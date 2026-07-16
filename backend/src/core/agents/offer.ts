import type { Donation, DonationItem, Recipient, OfferDraft } from '../types.js';
import type { LlmClient } from './llm.js';
import { createLlm, extractJson } from './llm.js';
import { buildTaskPrompt } from './protocol.js';
import { firstName, fmtUrgency } from '../text/humanize.js';
import { memoryHint } from './memoryHint.js';

// UI_REDESIGN §D.3 — the offer script must sound like a person, not a database
// row. Hard rules baked into the prompt AND the deterministic template:
//   • ≤2 spoken sentences, warm phone register.
//   • Greet the contact by first name.
//   • Say what + how much + the spoilage urgency.
//   • At MOST ONE short contextual clause from memory (already distilled for you
//     in `memoryHint`) — never enumerate infrastructure / accepts / rejects.
//   • Never print raw enum tokens (no underscores, no category codes).
//   • End with the ask.
const INSTRUCTIONS =
  'You are Donna, leaving a short, warm spoken offer for a food-recipient contact. ' +
  'Write AT MOST TWO sentences in natural speech. Greet the contact by their first ' +
  'name, then say what the item is, roughly how much, and how soon it needs to move. ' +
  'You may add ONE brief contextual nod ONLY if a memoryHint is provided — never list ' +
  'their infrastructure, preferences, or rejected categories, and never write raw ' +
  'codes or underscores. Finish by asking if they can take it today. ' +
  'Return JSON: {"script": string, "summary": string} where summary is one short line.';

interface OfferPayload {
  itemName: string;
  qtyLbs: number;
  hoursToSpoil: number;
  donorName: string;
  recipientName: string;
  contactFirstName: string;
  memoryHint: string;
}

/**
 * Agent 2 — item + recipient → OfferDraft (§6). Degrades to a deterministic
 * humane template if the LLM output can't be parsed; never throws.
 */
export async function draftOffer(
  item: DonationItem,
  donation: Donation,
  recipient: Recipient,
  memoryContext: string,
  llm: LlmClient = createLlm(),
): Promise<OfferDraft> {
  // memoryContext arrives already distilled to a single humane clause from the
  // caller; if empty (e.g. direct callers/tests), derive one from the recipient.
  const hint = memoryContext && memoryContext.trim()
    ? memoryContext.trim()
    : memoryHint(recipient, item);

  const payload: OfferPayload = {
    itemName: item.item,
    qtyLbs: item.qtyLbs,
    hoursToSpoil: item.hoursToSpoil,
    donorName: donation.donorName ?? '',
    recipientName: recipient.name,
    contactFirstName: firstName(recipient.leadContact) || recipient.name,
    memoryHint: hint,
  };

  try {
    const prompt = buildTaskPrompt('offer', INSTRUCTIONS, payload);
    const out = await llm.complete({ prompt, json: true });
    const parsed = extractJson<{ script?: unknown; summary?: unknown }>(out);
    const script = typeof parsed.script === 'string' && parsed.script.trim()
      ? parsed.script.trim()
      : templateScript(payload);
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : templateSummary(payload);
    return { itemId: item.id, recipientId: recipient.id, script, summary };
  } catch {
    return {
      itemId: item.id,
      recipientId: recipient.id,
      script: templateScript(payload),
      summary: templateSummary(payload),
    };
  }
}

/** Deterministic humane fallback — kept in lockstep with llmMock's mockOffer. */
function templateScript(p: OfferPayload): string {
  const greet = p.contactFirstName ? `Hi ${p.contactFirstName}` : 'Hi there';
  const urgency = fmtUrgency(p.hoursToSpoil);
  const first = `${greet}, I've got ${fmtLbs(p.qtyLbs)} of ${p.itemName} that needs to move ${urgency}.`;
  const ask = p.memoryHint
    ? `${p.memoryHint}, so could your team take it today?`
    : 'Could your team take it today?';
  return `${first} ${ask}`;
}

function templateSummary(p: OfferPayload): string {
  return `Offer ${fmtLbs(p.qtyLbs)} of ${p.itemName} to ${p.recipientName}.`;
}

function fmtLbs(n: number): string {
  return `${n} lbs`;
}
