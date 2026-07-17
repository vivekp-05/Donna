import type {
  Channel, Donation, DonationItem, RankedRecipient, Weights, AgentConfig,
  CallAttempt, CallOutcome, HistoryEvent,
} from './types.js';
import type { MemoryStore } from './memory/store.js';
import type { LlmClient } from './agents/llm.js';
import type { VoiceProvider } from './voice/caller.js';
import { parseDonation } from './agents/intake.js';
import { composeDonorMessage, rejectionScript } from './agents/callback.js';
import {
  startDispatch, onCallReport, type MachineDeps,
} from './voice/dispatchMachine.js';
import { draftOffer } from './agents/offer.js';
import { memoryHint } from './agents/memoryHint.js';
import { rankRecipients } from './scoring/engine.js';
import type { Geocoder } from './geo.js';

export interface PipelineDeps {
  store: MemoryStore;
  llm: LlmClient;
  voice: VoiceProvider;
  config: AgentConfig;
  /**
   * §K.2 — resolves a spoken pickup address to coordinates when intake parsed a
   * `pickupLocation` string but no lat/lng. Optional: when absent, geocoding is
   * skipped and coords stay whatever intake produced. Composition roots
   * (main.ts / worker.ts) wire `nominatimGeocode`; tests inject a stub so vitest
   * never hits the network.
   */
  geocode?: Geocoder;
}

// parse (Agent 1) → build Donation with ids → store → status 'scored'
export async function ingestDonation(
  input: { channel: Channel; contact: string; rawText: string },
  deps: PipelineDeps,
): Promise<Donation> {
  const parsed = await parseDonation(input.rawText, input.channel, deps.llm);

  // §K.2 — the caller gave an address but no coordinates: geocode it so the map
  // pins the exact spot. Skipped when no geocoder is wired (tests) or when
  // intake already produced coords (the canned/mock path always has them, so the
  // offline demo never touches the network).
  let pickupLat = parsed.pickupLat;
  let pickupLng = parsed.pickupLng;
  if (parsed.pickupLocation && pickupLat == null && pickupLng == null && deps.geocode) {
    const point = await deps.geocode(parsed.pickupLocation);
    if (point) {
      pickupLat = point.lat;
      pickupLng = point.lng;
    }
  }

  const donationId = crypto.randomUUID();
  const items: DonationItem[] = parsed.items.map((p) => ({
    id: crypto.randomUUID(),
    donationId,
    item: p.item,
    qtyLbs: p.qtyLbs,
    category: p.category,
    hoursToSpoil: p.hoursToSpoil,
    needsRefrigeration: p.needsRefrigeration,
    status: 'pending',
    attempts: [],
  }));

  const donation: Donation = {
    id: donationId,
    sourceChannel: input.channel,
    sourceContact: input.contact,
    receivedAt: new Date().toISOString(),
    rawText: input.rawText,
    status: 'scored',
    donorName: parsed.donorName,
    pickupLocation: parsed.pickupLocation,
    pickupLat,
    pickupLng,
    items,
  };

  await deps.store.saveDonation(donation);
  return donation;
}

/**
 * §G.3.3 — the shared donation-finish check. When NO item of a donation is
 * still `pending`, the donation is done: compose the Agent 5 donor callback,
 * stamp `donorMessage`, flip status to `resolved`, and persist. Returns whether
 * it resolved. dispatchDonation AND both directed/manual call endpoints call
 * this so a directed/manual call that closes the last pending item resolves the
 * donation identically to a full dispatch run.
 */
export async function finishDonationIfResolved(
  donation: Donation,
  deps: Pick<PipelineDeps, 'store' | 'llm'>,
): Promise<boolean> {
  if (donation.items.some((it) => it.status === 'pending')) return false;
  donation.donorMessage = await composeDonorMessage(donation, deps.llm);
  donation.status = 'resolved';
  await deps.store.saveDonation(donation);
  return true;
}

// ---------------------------------------------------------------------------
// §K.1 — inventory hold. A coordinator can take a pending item into the food
// bank's inventory instead of dispatching it, then send it out later via a
// directed/manual call. `held` is a resting status: dispatch loops skip it (it
// is not `pending`) and the finish check treats a donation with only held items
// as resolvable, so a hold never strands a donation at `dispatching`.
// ---------------------------------------------------------------------------
export type HoldError = 'item_not_found' | 'item_not_pending';
export type HoldResult =
  | { ok: true; item: DonationItem }
  | { ok: false; error: HoldError };

/**
 * Move a pending item to `held`. 404 (unknown item) and 409 (not pending)
 * surface as `{ ok: false, error }` so the HTTP layer can map them. Clears any
 * in-flight `dialing` marker — an item on the shelf is not on the phone.
 */
export async function holdItem(
  itemId: string,
  deps: Pick<PipelineDeps, 'store'>,
): Promise<HoldResult> {
  const located = locateItem(await deps.store.listDonations(), itemId);
  if (!located) return { ok: false, error: 'item_not_found' };
  const { item, donation } = located;
  if (item.status !== 'pending') return { ok: false, error: 'item_not_pending' };

  item.status = 'held';
  item.dialing = undefined;
  await deps.store.saveDonation(donation);
  return { ok: true, item };
}

// ---------------------------------------------------------------------------
// §M.1 — reject at the gate. The mirror of approve: instead of working the
// ranked shortlist, Donna rings the donor back on the number they called from
// and declines the offer. Nothing is offered to any pantry.
// ---------------------------------------------------------------------------
export type RejectError = 'donation_not_found' | 'donation_not_rejectable';
export type RejectResult =
  | { ok: true; donation: Donation; calling: boolean }
  | { ok: false; error: RejectError };

/**
 * Decline a donation and start the call telling the donor so.
 *
 * Returns as soon as the call is DIALLING, not when it ends (`calling: true`),
 * leaving the donation at `dispatching` with `rejectCallId` set — the
 * end-of-call-report resolves it. `calling: false` means no call was placed
 * (simulator, or no donor call support) and the donation is already `resolved`.
 *
 * Held items are left alone: they are in the food bank's inventory, which is a
 * decision already taken and not the one being reversed here. Only items still
 * pending are declined.
 *
 * A failure to place the call still rejects the donation. The coordinator's
 * decision is not contingent on the donor picking up, and leaving the donation
 * at the gate because VAPI 500'd would put it back in front of the next person
 * as if no one had decided.
 */
export async function rejectDonation(
  donationId: string,
  deps: Pick<PipelineDeps, 'store' | 'voice'>,
): Promise<RejectResult> {
  const donation = await deps.store.getDonation(donationId);
  if (!donation) return { ok: false, error: 'donation_not_found' };
  if (donation.status === 'dispatching' || donation.status === 'resolved') {
    return { ok: false, error: 'donation_not_rejectable' };
  }

  for (const item of donation.items) {
    if (item.status !== 'pending') continue;
    item.status = 'unplaceable';
    item.dialing = undefined;
    item.resolutionReason = 'declined by a coordinator at the food bank';
  }
  donation.rejected = true;

  const script = rejectionScript(donation);
  donation.donorMessage = script;

  // No donor-call support (the simulator): resolve now. The offline demo shows
  // the rejection message without pretending a phone rang.
  if (!deps.voice.startDonorCall) {
    donation.status = 'resolved';
    await deps.store.saveDonation(donation);
    return { ok: true, donation, calling: false };
  }

  // Persist the decision BEFORE dialling. If the process dies between the two,
  // the donation must already read as rejected — the alternative is a donor who
  // has been told no by a database that still says the offer is open.
  donation.status = 'dispatching';
  await deps.store.saveDonation(donation);

  try {
    donation.rejectCallId = await deps.voice.startDonorCall(donation, script);
    await deps.store.saveDonation(donation);
    return { ok: true, donation, calling: true };
  } catch (e) {
    console.error('[reject] donor call failed:', e instanceof Error ? e.message : String(e));
    donation.status = 'resolved';
    donation.rejectCallId = undefined;
    await deps.store.saveDonation(donation);
    return { ok: true, donation, calling: false };
  }
}

/**
 * §M.1 — resolve a donation whose donor rejection call has ended.
 *
 * Called from the VAPI webhook for a report that matched no CallRecord: a donor
 * call has none (nothing to correlate, no shortlist to advance). Returns whether
 * this report belonged to a rejection call.
 *
 * Idempotent via the `dispatching` check — VAPI provably sends duplicate
 * end-of-call-reports, and the second must be a no-op.
 */
export async function onRejectCallEnded(
  callId: string,
  deps: Pick<PipelineDeps, 'store'>,
): Promise<boolean> {
  const donations = await deps.store.listDonations();
  const donation = donations.find((d) => d.rejectCallId === callId);
  if (!donation) return false;
  if (donation.status !== 'dispatching') return true;   // already resolved — duplicate report
  donation.status = 'resolved';
  donation.rejectCallId = undefined;
  await deps.store.saveDonation(donation);
  return true;
}

// ---------------------------------------------------------------------------
// §M.2 — the food bank's inventory: every item a coordinator has held.
// ---------------------------------------------------------------------------
export interface InventoryEntry {
  itemId: string;
  donationId: string;
  item: string;
  qtyLbs: number;
  category: DonationItem['category'];
  needsRefrigeration: boolean;
  hoursToSpoil: number;
  donorName?: string;
  receivedAt: string;
}

/**
 * Every held item across every donation, newest donation first.
 *
 * There is no inventory table to read: `held` is a status on a donation item
 * (holdItem above), so the shelf is a projection over donations rather than a
 * place. That is why this scans — the D1 store keeps donations as JSON documents,
 * so item status is not a queryable column and no WHERE clause could do it. Fine
 * at demo scale, and the honest shape of the data as it stands.
 */
export async function listInventory(
  deps: Pick<PipelineDeps, 'store'>,
): Promise<InventoryEntry[]> {
  const donations = await deps.store.listDonations();
  const out: InventoryEntry[] = [];
  for (const d of donations) {
    for (const item of d.items) {
      if (item.status !== 'held') continue;
      out.push({
        itemId: item.id,
        donationId: d.id,
        item: item.item,
        qtyLbs: item.qtyLbs,
        category: item.category,
        needsRefrigeration: item.needsRefrigeration,
        hoursToSpoil: item.hoursToSpoil,
        donorName: d.donorName,
        receivedAt: d.receivedAt,
      });
    }
  }
  out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
  return out;
}

/**
 * Build the state machine's dependencies from a PipelineDeps.
 *
 * This is the seam between "what the app has" (a VoiceProvider, an LlmClient)
 * and "what the machine needs" (place a call, get an id; compose the callback).
 * The machine deliberately knows nothing about VAPI or the simulator.
 */
export function machineDeps(deps: PipelineDeps): MachineDeps {
  const voice = deps.voice;
  return {
    store: deps.store,
    llm: deps.llm,
    config: deps.config,
    placeCall: (offer, recipient, item) => voice.startCall(offer, recipient, item),
    ...(voice.synthesizeReport
      ? { synthesizeReport: voice.synthesizeReport.bind(voice) }
      : {}),
    ...(voice.setHistory
      ? {
          refreshHistory: async () => {
            voice.setHistory!(await deps.store.listHistory());
          },
        }
      : {}),
    composeDonorMessage: (donation) => composeDonorMessage(donation, deps.llm),
  };
}

/**
 * Kick off a dispatch. Returns as soon as the FIRST call is placed — the rest
 * is driven by webhooks (dispatchMachine.onCallReport), not by this function.
 *
 * It used to run the entire donation to completion in one call, blocking for
 * minutes of real telephony. That shape is what pinned the backend to a single
 * always-on process; see dispatchMachine for the why.
 *
 * The returned Donation is therefore a SNAPSHOT taken after the first call goes
 * out — items will still be pending. Read it back from the store to see where
 * the dispatch got to. (Under VOICE_PROVIDER=sim there are no webhooks, so the
 * machine runs to completion synchronously and the snapshot IS the final state.)
 */
export async function dispatchDonation(
  donationId: string,
  deps: PipelineDeps,
): Promise<Donation> {
  const donation = await deps.store.getDonation(donationId);
  if (!donation) throw new Error(`donation not found: ${donationId}`);
  await startDispatch(donation, machineDeps(deps));
  return (await deps.store.getDonation(donationId)) ?? donation;
}

// ---------------------------------------------------------------------------
// §G.3 — directed / manual single-recipient calls (bypass the ranking loop).
// Discriminated result so the HTTP layer can map to 404 / 409 without throwing.
// ---------------------------------------------------------------------------
export type DirectedCallError =
  | 'item_not_found' | 'recipient_not_found' | 'item_not_pending';
/**
 * `attempt` is only present when the outcome is known by the time we return —
 * i.e. a manual log (the human already made the call) or the simulator.
 *
 * A live directed call cannot include one: the call has been placed, but its
 * outcome arrives later at the webhook. `callId` is returned instead so the
 * caller can follow it; the attempt lands on the item once the report comes in.
 */
export type DirectedCallResult =
  | { ok: true; item: DonationItem; attempt?: CallAttempt; callId?: string }
  | { ok: false; error: DirectedCallError };

function genId(): string {
  return crypto.randomUUID();
}

function locateItem(
  donations: Donation[],
  itemId: string,
): { item: DonationItem; donation: Donation } | undefined {
  for (const d of donations) {
    const item = d.items.find((it) => it.id === itemId);
    if (item) return { item, donation: d };
  }
  return undefined;
}

/**
 * Record a placed/logged attempt on an item and run the shared side effects:
 * append to item.attempts, addHistory, and on `accepted` mark the item matched
 * + credit the recipient's ledger. Then persist the donation and run the shared
 * finish check. Mutates `item`/`donation` in place.
 */
async function applyAttempt(
  item: DonationItem,
  donation: Donation,
  recipientName: string,
  recipientId: string,
  attempt: CallAttempt,
  deps: PipelineDeps,
): Promise<void> {
  item.attempts = item.attempts ?? [];
  item.attempts.push(attempt);

  const event: HistoryEvent = {
    id: genId(),
    recipientId,
    itemId: item.id,
    outcome: attempt.outcome,
    reason: attempt.reason,
    at: attempt.at,
  };
  await deps.store.addHistory(event);

  if (attempt.outcome === 'accepted') {
    item.status = 'matched';
    item.matchedRecipientId = recipientId;
    item.resolutionReason = `Accepted by ${recipientName}`;
    await deps.store.creditReceived(recipientId, item.qtyLbs);
  }
  // declined / no_answer: attempt + history recorded; item stays pending so it
  // can be tried again. The category-decline reason feeds the 7-day prefs
  // penalty on the next ranking automatically.

  await deps.store.saveDonation(donation);
  await finishDonationIfResolved(donation, deps);
}

/**
 * §G.3.1 — a directed agent call to one chosen recipient, skipping ranking.
 *
 * The call is placed and its CallRecord is flagged `directed`, which tells the
 * state machine to record the report but NOT steer: no shortlist to walk, and a
 * decline leaves the item pending so the coordinator can try someone else. That
 * is the point of a manual override.
 *
 * Live, the outcome is not known when this returns — `callId` comes back and
 * the attempt lands on the item at the webhook. Simulated, there is no webhook,
 * so the decision is fed through the same path immediately and `attempt` is
 * populated. 404 (unknown item/recipient), 409 (item not pending) surface as
 * `{ ok: false, error }`.
 */
export async function directedCall(
  itemId: string,
  recipientId: string,
  deps: PipelineDeps,
): Promise<DirectedCallResult> {
  const located = locateItem(await deps.store.listDonations(), itemId);
  if (!located) return { ok: false, error: 'item_not_found' };
  const recipient = await deps.store.getRecipient(recipientId);
  if (!recipient) return { ok: false, error: 'recipient_not_found' };
  const { item, donation } = located;
  // §K.1 — a held item can be sent out via a directed call ("send it out
  // later"): accept `held` as well as `pending`. On accept it becomes matched;
  // on decline recordAttempt leaves the status untouched, so it stays held.
  if (item.status !== 'pending' && item.status !== 'held') {
    return { ok: false, error: 'item_not_pending' };
  }

  const offer = await draftOffer(
    item, donation, recipient, memoryHint(recipient, item), deps.llm,
  );
  const md = machineDeps(deps);

  // Publish "dialing X" before the call, exactly as the machine's placeNext
  // does — this path bypasses it, so without this a coordinator's directed call
  // rings with the dashboard showing nothing. onCallReport clears it.
  item.dialing = {
    recipientId: recipient.id,
    recipientName: recipient.name,
    startedAt: new Date().toISOString(),
  };
  await deps.store.saveDonation(donation);

  let callId: string;
  try {
    callId = await deps.voice.startCall(offer, recipient, item);
  } catch (e) {
    item.dialing = undefined;
    await deps.store.saveDonation(donation);
    throw e;
  }
  await deps.store.saveCall({
    callId,
    donationId: donation.id,
    itemId: item.id,
    recipientId: recipient.id,
    candidateIndex: -1,          // not on any shortlist
    placedAt: new Date().toISOString(),
    directed: true,
  });

  if (deps.voice.synthesizeReport) {
    if (deps.voice.setHistory) deps.voice.setHistory(await deps.store.listHistory());
    const r = await deps.voice.synthesizeReport(offer, recipient, item);
    await onCallReport(callId, r.outcome, r.reason, r.transcript, md);
    const fresh = await deps.store.getDonation(donation.id);
    const freshItem = fresh?.items.find((it) => it.id === item.id) ?? item;
    return { ok: true, item: freshItem, attempt: freshItem.attempts.at(-1), callId };
  }

  return { ok: true, item, callId };
}

export interface ManualCallInput {
  outcome: CallOutcome;
  reason?: string;
  notes?: string;
}

/**
 * §G.3.2 — a human-logged call, recorded exactly like an agent call but flagged
 * `manual: true`, `simulated: false`. Transcript = the notes as a single
 * agent-line when provided. Same 404/409 rules and finish semantics as (1).
 */
export async function manualCall(
  itemId: string,
  recipientId: string,
  input: ManualCallInput,
  deps: PipelineDeps,
): Promise<DirectedCallResult> {
  const located = locateItem(await deps.store.listDonations(), itemId);
  if (!located) return { ok: false, error: 'item_not_found' };
  const recipient = await deps.store.getRecipient(recipientId);
  if (!recipient) return { ok: false, error: 'recipient_not_found' };
  const { item, donation } = located;
  // §K.1 — held items can be logged out of inventory too (accept + decline). A
  // decline leaves applyAttempt's status untouched, so a held item stays held.
  if (item.status !== 'pending' && item.status !== 'held') {
    return { ok: false, error: 'item_not_pending' };
  }

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const attempt: CallAttempt = {
    recipientId: recipient.id,
    recipientName: recipient.name,
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    transcript: notes ? [{ speaker: 'agent', text: notes }] : [],
    at: new Date().toISOString(),
    simulated: false,
    manual: true,
  };
  await applyAttempt(item, donation, recipient.name, recipient.id, attempt, deps);
  return { ok: true, item, attempt };
}

// stateless re-rank (slider preview) — optional weights override, does NOT persist
export async function rankItem(
  itemId: string,
  weightsOverride: Weights | undefined,
  deps: PipelineDeps,
): Promise<RankedRecipient[]> {
  let target: DonationItem | undefined;
  let owner: Donation | undefined;
  const donations = await deps.store.listDonations();
  for (const d of donations) {
    const found = d.items.find((it) => it.id === itemId);
    if (found) { target = found; owner = d; break; }
  }
  if (!target || !owner) throw new Error(`item not found: ${itemId}`);

  const recipients = await deps.store.listRecipients();
  const history = await deps.store.listHistory();
  const config: AgentConfig = weightsOverride
    ? { ...deps.config, weights: weightsOverride }
    : deps.config;

  return rankRecipients(target, owner, recipients, config, history);
}
