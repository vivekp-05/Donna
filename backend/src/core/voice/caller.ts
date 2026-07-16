import type {
  Donation, DonationItem, OfferDraft, Recipient, CallAttempt, AgentConfig,
  HistoryEvent,
} from '../types.js';
import type { MemoryStore } from '../memory/store.js';
import type { LlmClient } from '../agents/llm.js';
import { rankRecipients } from '../scoring/engine.js';
import { draftOffer } from '../agents/offer.js';
import { ENV } from '../../config.js';
import { SimulatorVoice } from './simulator.js';
import { VapiVoice } from './vapi.js';

/**
 * Agent 3 — the outbound voice provider.
 * `setHistory` is an optional hook: the simulator uses it to see the live
 * decline ledger (for its 7-day category memory) without changing placeCall's
 * signature. The live VAPI provider ignores it.
 */
export interface VoiceProvider {
  placeCall(offer: OfferDraft, recipient: Recipient, item: DonationItem): Promise<CallAttempt>;
  setHistory?(history: HistoryEvent[]): void;
}

export function createVoice(): VoiceProvider {   // env VOICE_PROVIDER: 'sim'(default)|'vapi'
  // VapiVoice compiles/constructs with zero keys; it only needs env when a call
  // is actually placed. All VAPI specifics stay inside vapi.ts.
  if (ENV.voiceProvider === 'vapi') return new VapiVoice();
  return new SimulatorVoice();
}

export interface DispatchDeps {
  store: MemoryStore;
  llm: LlmClient;
  voice: VoiceProvider;
  config: AgentConfig;
}

function genId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Short human-readable memory blurb handed to the offer drafter (Agent 2). */
function buildMemoryContext(recipient: Recipient, recent: HistoryEvent[]): string {
  const parts: string[] = [];
  parts.push(`${recipient.name} (${recipient.type}). Infrastructure: ${recipient.infrastructure.join(', ') || 'none'}.`);
  if (recipient.accepts.length) parts.push(`Prefers: ${recipient.accepts.join(', ')}.`);
  if (recipient.rejects.length) parts.push(`Does not take: ${recipient.rejects.join(', ')}.`);
  if (recipient.bestCallWindow) parts.push(`Best call window: ${recipient.bestCallWindow}.`);
  const declines = recent.filter((e) => e.outcome === 'declined').slice(-3);
  if (declines.length) {
    parts.push(`Recent declines: ${declines.map((e) => e.reason ?? 'no reason').join('; ')}.`);
  }
  return parts.join(' ');
}

/**
 * §7.1 — the dispatch loop.
 * rank → up to 3 candidates → draftOffer → placeCall.
 *   accepted → matched + creditReceived + history + stop.
 *   declined/no_answer → history (w/ reason) + continue.
 *   exhausted → unplaceable with resolutionReason.
 * Every attempt is appended to item.attempts.
 */
export async function dispatchItem(
  item: DonationItem,
  donation: Donation,
  store: MemoryStore,
  config: AgentConfig,
  deps: DispatchDeps,
): Promise<DonationItem> {
  const recipients = await store.listRecipients();
  const history = await store.listHistory();
  const ranked = rankRecipients(item, donation, recipients, config, history);

  // Only recipients that clear the hard gates are callable; take the best three.
  const candidates = ranked.filter((r) => !r.score.hardFail).slice(0, 3);

  item.attempts = item.attempts ?? [];

  for (const candidate of candidates) {
    const recipient = candidate.recipient;

    // Refresh history each iteration so the simulator's 7-day memory reflects
    // declines recorded earlier in this same dispatch run.
    if (deps.voice.setHistory) {
      deps.voice.setHistory(await store.listHistory());
    }

    const recentForRecipient = await store.listHistory(recipient.id);
    const memoryContext = buildMemoryContext(recipient, recentForRecipient);

    let offer: OfferDraft;
    try {
      offer = await draftOffer(item, donation, recipient, memoryContext, deps.llm);
    } catch {
      // Offer drafting must never abort the loop — fall back to a plain script.
      offer = {
        itemId: item.id,
        recipientId: recipient.id,
        summary: `Offer ${item.qtyLbs} lbs of ${item.item} to ${recipient.name}.`,
        script:
          `Hi, this is Donna calling on behalf of a food donor. We have ` +
          `${item.qtyLbs} lbs of ${item.item} available for pickup. ` +
          `Would ${recipient.name} be able to take it today?`,
      };
    }

    const attempt = await deps.voice.placeCall(offer, recipient, item);
    item.attempts.push(attempt);

    const event: HistoryEvent = {
      id: genId(),
      recipientId: recipient.id,
      itemId: item.id,
      outcome: attempt.outcome,
      reason: attempt.reason,
      at: attempt.at,
    };
    await store.addHistory(event);

    if (attempt.outcome === 'accepted') {
      item.status = 'matched';
      item.matchedRecipientId = recipient.id;
      item.resolutionReason = `Accepted by ${recipient.name}`;
      await store.creditReceived(recipient.id, item.qtyLbs);
      return item;
    }
    // declined or no_answer: history is recorded (a category-decline reason
    // feeds the 7-day prefs penalty automatically on the next ranking); continue.
  }

  // No candidate accepted.
  item.status = 'unplaceable';
  if (candidates.length === 0) {
    item.resolutionReason =
      `No feasible recipient — every option failed a hard constraint ` +
      `(spoilage window, cold chain, or category).`;
  } else {
    const names = candidates.map((c) => c.recipient.name).join(', ');
    item.resolutionReason =
      `No recipient accepted after ${item.attempts.length} call(s): ${names}.`;
  }
  return item;
}
