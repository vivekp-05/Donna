import type { Donation, DonationItem, Recipient, OfferDraft } from '../types.js';
import type { LlmClient } from './llm.js';
import { createLlm, extractJson } from './llm.js';
import { buildTaskPrompt } from './protocol.js';

const INSTRUCTIONS =
  'You are Donna, drafting a short, warm phone script to offer a food donation to a ' +
  'recipient agency. Reference the real item, quantity, freshness window, and pickup ' +
  'location. Ask whether they can take it today. Return JSON: {"script": string, ' +
  '"summary": string} where summary is one line.';

/**
 * Agent 2 — item + recipient → OfferDraft (§6). Degrades to a deterministic
 * template if the LLM output can't be parsed; never throws.
 */
export async function draftOffer(
  item: DonationItem,
  donation: Donation,
  recipient: Recipient,
  memoryContext: string,
  llm: LlmClient = createLlm(),
): Promise<OfferDraft> {
  const payload = {
    itemName: item.item,
    qtyLbs: item.qtyLbs,
    category: item.category,
    hoursToSpoil: item.hoursToSpoil,
    needsRefrigeration: item.needsRefrigeration,
    donorName: donation.donorName ?? '',
    pickupLocation: donation.pickupLocation ?? '',
    recipientName: recipient.name,
    recipientContact: recipient.leadContact,
    memoryContext,
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

function templateScript(p: {
  itemName: string;
  qtyLbs: number;
  category: string;
  hoursToSpoil: number;
  needsRefrigeration: boolean;
  donorName: string;
  pickupLocation: string;
  recipientName: string;
  recipientContact: string;
}): string {
  const parts: string[] = [];
  parts.push(`Hi ${p.recipientContact || p.recipientName}, this is Donna calling on behalf of ${p.donorName || 'a local food donor'}.`);
  parts.push(
    `We have about ${p.qtyLbs} lbs of ${p.itemName} (${p.category.replace(/_/g, ' ')})` +
      `${p.needsRefrigeration ? ', which needs refrigeration' : ''}` +
      `${p.pickupLocation ? `, available for pickup at ${p.pickupLocation}` : ''}.`,
  );
  parts.push(`It should stay good for roughly ${p.hoursToSpoil} hours.`);
  parts.push(`Could ${p.recipientName} take this today?`);
  return parts.join(' ');
}

function templateSummary(p: { qtyLbs: number; itemName: string; recipientName: string }): string {
  return `Offer ${p.qtyLbs} lbs of ${p.itemName} to ${p.recipientName}.`;
}
