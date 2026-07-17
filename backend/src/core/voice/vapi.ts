import type {
  Donation, DonationItem, OfferDraft, Recipient, CallAttempt, CallOutcome,
} from '../types.js';
import type { VoiceProvider } from './caller.js';
import { ENV } from '../../config.js';

/**
 * §7.3 — live VAPI voice provider.
 *
 * ALL VAPI-specific request/response/webhook shapes live in this file only.
 * Verified against https://docs.vapi.ai (2026-07):
 *   - Outbound call: POST https://api.vapi.ai/call
 *       { phoneNumberId, customer: { number }, assistant: {...transient...} }
 *     Response: { id, ... } — `id` is the call id we correlate on.
 *   - Webhook (server messages): { message: { type: 'end-of-call-report',
 *       endedReason, call: { id }, artifact: { transcript, messages } } }
 *
 * startCall places the call and returns its id, nothing more. The outcome comes
 * back at the webhook and is correlated through the persisted CallRecord — see
 * dispatchMachine. This file holds no cross-request state, which is what lets
 * the backend run on a serverless runtime at all.
 */

const VAPI_BASE = 'https://api.vapi.ai';

/**
 * Hard ceiling on a single call, enforced by VAPI itself (`maxDurationSeconds`).
 * A recipient deciding on a pallet of produce needs far more than a few seconds,
 * but no legitimate offer call runs past five minutes.
 */
const MAX_CALL_DURATION_S = 300;

/**
 * The model that actually talks on the phone — VAPI's in-call ASR→LLM→TTS loop,
 * NOT the backend LlmClient (that one is chosen by LLM_PROVIDER and does intake,
 * offers, manager chat, and the donor callback).
 *
 * Google/Gemini rather than OpenAI: the pitch says Gemini, so the voice should
 * be Gemini too, and it keeps every model in the system on one provider we hold
 * the key for. Requires a `google` credential on the VAPI account (Gemini API
 * key from AI Studio) — without it VAPI rejects the call, it does not fall back.
 *
 * Shared by both assistants so the inbound donor and the outbound pantry never
 * end up on different models. `flash` because a phone call is latency-critical.
 */
export const IN_CALL_MODEL = {
  provider: 'google',
  model: 'gemini-2.5-flash',
} as const;

/**
 * How long after placing a call we give up waiting for its report.
 *
 * This used to be an in-process `setTimeout` racing the webhook. No timer
 * survives a serverless invocation, so the backstop is now a cron sweep
 * (dispatchMachine.sweepStaleCalls) over calls that were placed and never
 * reported. Same purpose, different mechanism: a dropped webhook must never
 * strand a donation at `dispatching` forever.
 *
 * Derived from the call's own ceiling plus a delivery buffer, so the report
 * always beats the sweep. The old value was 90s flat — shorter than a real
 * conversation. Observed live 2026-07-16: a recipient talked for ~100s and
 * declined, the timer fired first and logged `no_answer` over a genuine
 * decline (poisoning the memory PRD §9 learns from) and dialled the next
 * pantry while the first was still connected.
 */
export const CALL_REPORT_GRACE_MS = (MAX_CALL_DURATION_S + 60) * 1000;

/** endedReason values that mean nobody picked up. */
const NO_ANSWER_REASONS = new Set([
  'customer-did-not-answer',
  'customer-busy',
  'voicemail',
  'no-answer',
  'twilio-failed-to-connect-call',
  'phone-call-provider-closed-websocket',
]);

export interface NormalizedWebhook {
  type: 'end-of-call-report';
  callId: string;
  transcript: Array<{ speaker: 'agent' | 'recipient'; text: string }>;
  outcome: CallOutcome;
  reason?: string;
}

/**
 * Where VAPI posts this call's end-of-call-report, and what it's allowed to post.
 *
 * Verified against docs.vapi.ai (2026-07): `server: { url, secret, timeoutSeconds }`
 * plus `serverMessages: [...]` on the assistant. The 2024-10-13 changelog retired
 * the older top-level `serverUrl`/`serverUrlSecret` in favour of this block.
 *
 * `serverMessages` asks for exactly the two messages we act on:
 *   - end-of-call-report drives the dispatch machine (the outcome).
 *   - transcript feeds the live captions on the stage dashboard.
 *
 * `transcript` used to be omitted here, back when nothing consumed it and the
 * narrowing existed to stop status-update/speech-update chatter. Once live
 * captions were built, that omission meant the dashboard could only ever show
 * an INBOUND donor call — the outbound pantry call, which is the one on stage,
 * stayed silent. inbound.ts had it right; this did not. Keep the two lists in
 * step: anything server.ts handles must be requested by both assistants.
 *
 * Returns {} when PUBLIC_WEBHOOK_URL is unset, which leaves the call unable to
 * report back; startCall warns about exactly that below.
 */
function serverBlock() {
  if (!ENV.publicWebhookUrl) return {};
  return {
    server: {
      url: `${ENV.publicWebhookUrl}/api/vapi/webhook`,
      timeoutSeconds: 20,
      ...(ENV.vapiWebhookSecret ? { secret: ENV.vapiWebhookSecret } : {}),
    },
    serverMessages: ['end-of-call-report', 'transcript'],
  };
}

/**
 * Who Donna says she works for. Mirrors inbound.ts rather than importing from
 * it: inbound.ts already imports IN_CALL_MODEL from here, and the reverse would
 * close the cycle. Both read the same ENV, so they cannot disagree.
 */
const FOOD_BANK_NAME = ENV.foodBankName;

/**
 * Everything the assistant is allowed to state as fact, and what to do with the
 * rest.
 *
 * Observed live 2026-07-16: asked where the produce came from, the model
 * answered "a farm just outside Watsonville" — the donation record plainly said
 * Golden State Produce, Dock 12. inbound.ts documented that failure alongside
 * its own (inventing "Central City Food Bank" as an employer), diagnosed both
 * as the same thing — an unanswerable question plus no instruction to decline
 * produces a confident invention — and then fixed only the inbound half. This
 * is the other half.
 *
 * It matters more here than inbound. Inbound invents at a donor who knows the
 * truth and can correct it; outbound invents at a pantry deciding whether to
 * feed the food to people, and sourcing and handling are food-safety facts.
 *
 * Note what this prompt does NOT do: give Donna the real provenance. She has no
 * way to know it — buildAssistant receives (offer, recipient, item), and
 * provenance lives on Donation (donorName/pickupLocation), which never reaches
 * this file. Threading it through means changing the VoiceProvider interface,
 * so for now the honest answer to "where's it from?" is "I'll check" rather
 * than a plausible guess. Declining is a floor, not the ceiling.
 */
function outboundSystem(recipient: Recipient, item: DonationItem): string {
  return (
    `You are Donna, a food-rescue dispatcher for ${FOOD_BANK_NAME}, calling ${recipient.name}. ` +
    `Offer them ${item.qtyLbs} lbs of ${item.item}` +
    `${item.needsRefrigeration ? ' (needs refrigeration)' : ''}. ` +
    'Your only goal is to secure a clear ACCEPT or DECLINE and, if declined, the reason. ' +
    'Be brief and warm. When the recipient decides, confirm and end the call. ' +
    'NEVER invent facts. The offer above is the whole of what you know about this food. ' +
    'You do NOT know where it was grown or sourced, which farm, supplier or donor it came ' +
    'from, how it has been stored or handled, who else was offered it, or when it would be ' +
    'delivered. If you are asked any of that — or anything else you were not told — say you ' +
    'do not have it in front of you and the team will follow up. Sourcing and handling are ' +
    'food-safety facts and this pantry may feed this food to people: a confident wrong answer ' +
    "can put someone at risk, so \"I'll check\" is always the better answer. " +
    `You work for ${FOOD_BANK_NAME} and nothing else — never name a different organisation, ` +
    'partner, or policy. If asked, you are an AI assistant — say so plainly and do not ' +
    'pretend otherwise.'
  );
}

function buildAssistant(offer: OfferDraft, recipient: Recipient, item: DonationItem) {
  return {
    ...serverBlock(),
    // VAPI ends the call here; CALL_TIMEOUT_MS is deliberately longer so the
    // report always wins the race against our own backstop.
    maxDurationSeconds: MAX_CALL_DURATION_S,
    firstMessage: offer.script,
    model: {
      ...IN_CALL_MODEL,
      messages: [{ role: 'system', content: outboundSystem(recipient, item) }],
    },
    voice: { provider: '11labs', voiceId: 'burt' },
  };
}

/**
 * The number this call is actually dialed to.
 *
 * LIVE_CALL_PHONE_OVERRIDE redirects every outbound call to one handset. This is
 * the ONLY place a dial target is chosen, so nothing upstream — ranking, offer
 * drafting, the recipient's own `phone` field — can route around it. The returned
 * CallAttempt still credits the recipient the engine actually picked.
 */
function dialTarget(recipient: Recipient): string {
  const override = ENV.liveCallPhoneOverride;
  if (!override) return recipient.phone;
  console.warn(
    `[vapi] LIVE_CALL_PHONE_OVERRIDE active — dialing ${override} ` +
      `instead of ${recipient.name} (${recipient.phone}).`,
  );
  return override;
}

/**
 * §M.1 — the number the DONOR gets called back on: whatever they rang in from.
 *
 * The override applies here exactly as it does to recipient calls, and for a
 * stronger reason. `sourceContact` is whatever the inbound webhook read off
 * `call.customer.number` — on the canned scenario it is seed text, not a real
 * phone number at all. Honouring the override keeps a rejection demo from
 * dialling a stranger.
 */
function dialDonor(donation: Donation): string {
  const override = ENV.liveCallPhoneOverride;
  if (!override) return donation.sourceContact;
  console.warn(
    `[vapi] LIVE_CALL_PHONE_OVERRIDE active — dialing ${override} ` +
      `instead of the donor (${donation.sourceContact}).`,
  );
  return override;
}

/**
 * What Donna may say when declining an offer.
 *
 * Same no-invention floor as outboundSystem, aimed at the mirror-image failure.
 * There, an unanswerable question was about food she'd been told nothing about;
 * here it is "why not?" — and the honest answer is that a coordinator made the
 * call, which is the one fact this prompt actually carries. A model left to
 * fill that silence will reach for a reason that sounds like a policy, and an
 * invented policy ("we don't take dairy this week") is worse than no reason: the
 * donor believes it, and stops offering dairy.
 */
function donorRejectSystem(donation: Donation): string {
  const what = donation.items.map((i) => `${i.qtyLbs} lbs of ${i.item}`).join(', ');
  return (
    `You are Donna, a food-rescue dispatcher for ${FOOD_BANK_NAME}, calling ` +
    `${donation.donorName ?? 'a donor'} back about the donation they offered: ${what}. ` +
    'A coordinator at the food bank has reviewed it and decided we cannot take it this time. ' +
    'Your only job is to let them know, kindly and briefly, thank them sincerely for thinking ' +
    'of us, and encourage them to call again with future donations. Then end the call. ' +
    'NEVER invent facts. You do NOT know WHY the coordinator declined — not capacity, not ' +
    'timing, not quality, not policy. If asked why, say a coordinator reviewed it and the ' +
    'team will follow up with the detail; do NOT guess at a reason. An invented reason ' +
    'sounds like a policy, and a donor who believes it may never offer that food again. ' +
    'Do not renegotiate, do not accept a partial load, and do not promise anyone will call ' +
    "back at a specific time. You work for " + FOOD_BANK_NAME + ' and nothing else. ' +
    'If asked, you are an AI assistant — say so plainly.'
  );
}

function buildDonorAssistant(donation: Donation, script: string) {
  return {
    ...serverBlock(),
    maxDurationSeconds: MAX_CALL_DURATION_S,
    firstMessage: script,
    model: {
      ...IN_CALL_MODEL,
      messages: [{ role: 'system', content: donorRejectSystem(donation) }],
    },
    voice: { provider: '11labs', voiceId: 'burt' },
  };
}

export class VapiVoice implements VoiceProvider {
  /**
   * Place the call and return VAPI's call id. Returns as soon as the call is
   * accepted for dialling — the outcome arrives later, at the webhook, and is
   * correlated back through the persisted CallRecord.
   */
  async startCall(
    offer: OfferDraft,
    recipient: Recipient,
    item: DonationItem,
  ): Promise<string> {
    if (!ENV.vapiApiKey || !ENV.vapiPhoneNumberId) {
      throw new Error('VAPI_API_KEY and VAPI_PHONE_NUMBER_ID are required for VOICE_PROVIDER=vapi');
    }
    if (!ENV.publicWebhookUrl) {
      // Not fatal — the call still connects and a human still hears the offer —
      // but nothing can report the outcome back, so this item will sit at
      // `dialing` until the cron sweep writes it off as no_answer.
      console.warn(
        '[vapi] PUBLIC_WEBHOOK_URL is unset: no server block on the assistant, so ' +
          'no end-of-call-report can reach us. This call cannot resolve on its own ' +
          "and will be swept as no_answer regardless of the recipient's answer.",
      );
    }

    const res = await fetch(`${VAPI_BASE}/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.vapiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: ENV.vapiPhoneNumberId,
        customer: { number: dialTarget(recipient) },
        assistant: buildAssistant(offer, recipient, item),
      }),
    });

    if (!res.ok) {
      throw new Error(`VAPI call failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { id?: string };
    const callId = data.id;
    if (!callId) throw new Error('VAPI call response missing id');
    return callId;
  }

  /**
   * §M.1 — ring the donor back to decline their offer. Returns the call id once
   * VAPI accepts it for dialling.
   *
   * Unlike startCall this places NO CallRecord: there is no shortlist to walk and
   * no outcome to correlate, so the end-of-call-report has nothing to drive.
   * rejectDonation resolves the donation up front rather than on the report —
   * which is also what makes an unreachable donor harmless here (a recipient who
   * doesn't answer must advance the machine; a donor who doesn't answer must not
   * un-reject the donation).
   */
  async startDonorCall(donation: Donation, script: string): Promise<string> {
    if (!ENV.vapiApiKey || !ENV.vapiPhoneNumberId) {
      throw new Error('VAPI_API_KEY and VAPI_PHONE_NUMBER_ID are required for VOICE_PROVIDER=vapi');
    }

    const res = await fetch(`${VAPI_BASE}/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.vapiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: ENV.vapiPhoneNumberId,
        customer: { number: dialDonor(donation) },
        assistant: buildDonorAssistant(donation, script),
      }),
    });

    if (!res.ok) {
      throw new Error(`VAPI donor call failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { id?: string };
    const callId = data.id;
    if (!callId) throw new Error('VAPI donor call response missing id');
    return callId;
  }
}

// resolveCall() and the `pending` map are gone. A webhook no longer resolves a
// promise held in this process's memory — it looks the call up in the store and
// drives the state machine (see dispatchMachine.onCallReport). That is what
// lets any invocation, on any machine, carry a dispatch forward.

/** Map a VAPI messages[] array ({role, message}) into our transcript shape. */
function normalizeTranscript(
  messages: unknown,
): Array<{ speaker: 'agent' | 'recipient'; text: string }> {
  if (!Array.isArray(messages)) return [];
  const out: Array<{ speaker: 'agent' | 'recipient'; text: string }> = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as Record<string, unknown>).role ?? '');
    const text = String(
      (m as Record<string, unknown>).message ?? (m as Record<string, unknown>).content ?? '',
    );
    if (!text) continue;
    if (role === 'system') continue;
    // VAPI: 'assistant'/'bot' = our agent; 'user'/'customer' = the recipient.
    const speaker: 'agent' | 'recipient' =
      role === 'assistant' || role === 'bot' ? 'agent' : 'recipient';
    out.push({ speaker, text });
  }
  return out;
}

/**
 * Decide accept/decline/no_answer from the report. VAPI does not ship a
 * guaranteed structured accept flag, so we consult (in order): a boolean/label
 * successEvaluation from analysis, then the summary/transcript text, then the
 * endedReason for the no-answer cases.
 */
function deriveOutcome(msg: Record<string, unknown>): { outcome: CallOutcome; reason?: string } {
  const endedReason = String(msg.endedReason ?? '');
  if (NO_ANSWER_REASONS.has(endedReason)) {
    return { outcome: 'no_answer', reason: endedReason };
  }

  const analysis = (msg.analysis ?? {}) as Record<string, unknown>;
  const artifact = (msg.artifact ?? {}) as Record<string, unknown>;
  const summary = String(
    analysis.summary ?? msg.summary ?? artifact.summary ?? '',
  ).toLowerCase();
  const transcriptText = String(artifact.transcript ?? msg.transcript ?? '').toLowerCase();
  const hay = `${summary} ${transcriptText}`;

  const success = analysis.successEvaluation;
  if (typeof success === 'boolean') {
    return success
      ? { outcome: 'accepted' }
      : { outcome: 'declined', reason: summary || 'declined' };
  }
  if (typeof success === 'string') {
    const s = success.toLowerCase();
    if (s === 'true' || s === 'pass' || s === 'accepted' || s === 'yes') {
      return { outcome: 'accepted' };
    }
    if (s === 'false' || s === 'fail' || s === 'declined' || s === 'no') {
      return { outcome: 'declined', reason: summary || 'declined' };
    }
  }

  // Text heuristic fallback.
  const declined = /\b(declin|can't take|cannot take|no thanks|not able|don't need|full|overstock)/.test(hay);
  const accepted = /\b(accept|yes|we'll take|we can take|sounds good|bring it|works for us)/.test(hay);
  if (declined && !accepted) return { outcome: 'declined', reason: summary || 'declined' };
  if (accepted) return { outcome: 'accepted' };
  // Ambiguous but the call connected — treat as declined so dispatch keeps trying.
  return { outcome: 'declined', reason: summary || endedReason || 'no clear acceptance' };
}

/**
 * Normalize a raw VAPI webhook body into NormalizedWebhook.
 * Body wrapper: { message: { type, endedReason, call: { id }, artifact, analysis } }.
 * Throws if the message is not an end-of-call-report we can act on.
 */
export function parseWebhook(body: unknown): NormalizedWebhook {
  const root = (body ?? {}) as Record<string, unknown>;
  const msg = (root.message ?? root) as Record<string, unknown>;

  const type = String(msg.type ?? '');
  if (type !== 'end-of-call-report') {
    throw new Error(`Unsupported VAPI webhook type: ${type || '(none)'}`);
  }

  // VAPI posts TWO end-of-call-reports per call. The first fires while the call
  // is still winding down — endedReason `call.in-progress.*`, empty analysis,
  // empty transcript. The second, seconds later, carries the real endedReason
  // (`customer-ended-call`), successEvaluation, and transcript.
  //
  // resolveCall() resolves on first match and drops the pending entry, so acting
  // on the premature one means every call derives `declined` (no data ⇒ the
  // ambiguous fallback) and the real acceptance arrives to find nothing pending.
  // Observed live 2026-07-16: recipient said "Yes. I will be able to take them
  // today.", successEvaluation 'true' — and dispatch still rang the next pantry.
  //
  // Gate on endedReason, NOT on "is the payload empty": a real no-answer report
  // is also empty (no transcript, no analysis) but must still resolve, or the
  // dispatch hangs for the full 90s timeout.
  const endedReason = String(msg.endedReason ?? '');
  if (endedReason.startsWith('call.in-progress.')) {
    throw new Error(`Premature end-of-call-report (endedReason=${endedReason}); awaiting the final report`);
  }

  const call = (msg.call ?? {}) as Record<string, unknown>;
  const callId = String(call.id ?? msg.callId ?? '');
  if (!callId) throw new Error('VAPI webhook missing call id');

  const artifact = (msg.artifact ?? {}) as Record<string, unknown>;
  const transcript = normalizeTranscript(artifact.messages ?? msg.messages);
  const { outcome, reason } = deriveOutcome(msg);

  return { type: 'end-of-call-report', callId, transcript, outcome, reason };
}
