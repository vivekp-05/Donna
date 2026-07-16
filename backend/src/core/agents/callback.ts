import type { Donation, DonationItem } from '../types.js';
import type { LlmClient } from './llm.js';
import { createLlm } from './llm.js';
import { buildTaskPrompt } from './protocol.js';

const INSTRUCTIONS =
  'You are Donna, composing a warm SMS-style callback to a food donor once their donation ' +
  'is resolved. Itemize what was placed and where, and what could not be placed and why. ' +
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
  const unplaced = items.filter((i) => i.status !== 'matched');

  for (const i of placed) {
    lines.push(`We placed ${i.qtyLbs} lbs of ${i.item} with ${i.recipientName || 'a partner agency'}.`);
  }
  for (const i of unplaced) {
    lines.push(`We couldn't place ${i.qtyLbs} lbs of ${i.item}${i.reason ? ` (${i.reason})` : ''}.`);
  }

  if (placed.length && !unplaced.length) {
    lines.push('Thank you so much — everything found a good home today.');
  } else if (placed.length) {
    lines.push('Thank you for the donation; we routed everything we could to neighbors in need.');
  } else {
    lines.push('We are sorry we could not place these this time, and appreciate you thinking of us.');
  }

  return clampWords(lines.join(' '), 120);
}

function clampWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(' ') + '…';
}
