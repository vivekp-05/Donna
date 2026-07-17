import type { Donation, DonationItem } from '../types.js';
import type { LlmClient } from './llm.js';
import { createLlm } from './llm.js';
import { buildTaskPrompt } from './protocol.js';
import { ENV } from '../../config.js';

const INSTRUCTIONS =
  'You are Donna, composing a warm SMS-style callback to a food donor once their donation ' +
  'is resolved. Itemize what was placed and where, what could not be placed and why, and ' +
  'any items with status "held" that were taken into inventory at the food bank ' +
  '("We\'ve taken N lbs of X into our inventory at the food bank."). ' +
  'Keep it under 120 words with a warm sign-off. Return plain text (no JSON).';

/**
 * Agent 5 — resolved donation → donor callback message (§6). Itemized, ≤120
 * words, warm sign-off. Degrades to a deterministic template; never throws.
 */
export async function composeDonorMessage(
  donation: Donation,
  llm: LlmClient = createLlm(),
): Promise<string> {
  const items = donation.items.map(summarizeItem);
  const payload = { donorName: donation.donorName ?? '', items };

  try {
    const prompt = buildTaskPrompt('callback', INSTRUCTIONS, payload);
    const out = await llm.complete({ prompt });
    const text = (out ?? '').trim();
    if (text) return clampWords(text, 120);
    return template(donation.donorName ?? '', items);
  } catch {
    return template(donation.donorName ?? '', items);
  }
}

interface CallbackItem {
  item: string;
  qtyLbs: number;
  status: string;
  recipientName?: string;
  reason?: string;
}

function summarizeItem(it: DonationItem): CallbackItem {
  const accepted = it.attempts.find((a) => a.outcome === 'accepted');
  return {
    item: it.item,
    qtyLbs: it.qtyLbs,
    status: it.status,
    recipientName: accepted?.recipientName,
    reason: it.resolutionReason,
  };
}

function template(donorName: string, items: CallbackItem[]): string {
  const lines: string[] = [];
  lines.push(`Hi ${donorName || 'there'}, this is Donna with an update on your donation.`);

  const placed = items.filter((i) => i.status === 'matched');
  const held = items.filter((i) => i.status === 'held');
  const unplaced = items.filter((i) => i.status !== 'matched' && i.status !== 'held');

  for (const i of placed) {
    lines.push(`We placed ${i.qtyLbs} lbs of ${i.item} with ${i.recipientName || 'a partner agency'}.`);
  }
  for (const i of held) {
    lines.push(`We've taken ${i.qtyLbs} lbs of ${i.item} into our inventory at the food bank.`);
  }
  for (const i of unplaced) {
    lines.push(`We couldn't place ${i.qtyLbs} lbs of ${i.item}${i.reason ? ` (${i.reason})` : ''}.`);
  }

  if (!unplaced.length) {
    if (placed.length) {
      lines.push('Thank you so much — everything found a good home today.');
    } else {
      lines.push("Thank you — these are safe in our inventory and we'll place them soon.");
    }
  } else if (placed.length || held.length) {
    lines.push('Thank you for the donation; we routed everything we could to neighbors in need.');
  } else {
    lines.push('We are sorry we could not place these this time, and appreciate you thinking of us.');
  }

  return clampWords(lines.join(' '), 120);
}

/**
 * §M.1 — Donna's opening line on the donor rejection call, and the message
 * stamped on the donation as `donorMessage`.
 *
 * Deterministic, NOT model-written, unlike composeDonorMessage above. That one
 * reports facts the donation already contains — what was placed, where, what
 * wasn't — so a model has something true to work from and a template to fall
 * back to. This one has exactly one fact (a coordinator said no) and the
 * interesting part of the sentence is the part nobody knows: why. That is the
 * shape of prompt that gets a plausible invented reason, and it would be spoken
 * to the donor as the food bank's official position (see donorRejectSystem in
 * vapi.ts, which spends its length forbidding precisely this). A warm fixed
 * sentence is worth more here than a fluent guess.
 *
 * Held items are deliberately NOT mentioned: those were taken into inventory, so
 * naming them inside a "we can't take this" call is a contradiction the donor
 * has to untangle mid-sentence.
 *
 * Donna NAMES the food bank here, like every other line she speaks — it is a
 * self-identification down a phone, the exact parallel of inbound.ts's "Thanks
 * for calling ${FOOD_BANK_NAME} — this is Donna". This said "the food bank" flat
 * until FOOD_BANK_NAME was fixed to a bare proper noun (#7); a donor who is being
 * turned down deserves to know by whom. Note the string is interpolated WITHOUT a
 * leading article, which is the whole reason that fix requires a proper noun.
 */
export function rejectionScript(donation: Donation): string {
  const declined = donation.items.filter((i) => i.status !== 'held');
  const what = declined.length
    ? declined.map((i) => `${i.qtyLbs} lbs of ${i.item}`).join(' and ')
    : 'your donation';
  return (
    `Hi, this is Donna calling from ${ENV.foodBankName} about the ${what} you offered — ` +
    "thank you so much for thinking of us. I'm sorry to say a coordinator has reviewed it " +
    "and we're not able to take it this time. We'd really appreciate you calling us again " +
    'with future donations.'
  );
}

function clampWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(' ') + '…';
}
