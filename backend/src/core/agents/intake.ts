import type { Channel, ParsedDonation, ItemCategory } from '../types.js';
import type { LlmClient } from './llm.js';
import { createLlm, extractJson } from './llm.js';
import { buildTaskPrompt } from './protocol.js';
import { heuristicParse } from './llmMock.js';

const VALID_CATEGORIES: ItemCategory[] = [
  'fresh_produce', 'fruit', 'canned', 'dry_goods', 'baked',
  'dairy', 'meat', 'prepared', 'beverages', 'other',
];

const INSTRUCTIONS =
  'You are Donna, parsing an incoming food-donation message into structured line items. ' +
  'Extract each distinct item with: item (short name), qtyLbs (number, pounds — convert ' +
  'pallets≈1000lbs, cases≈30lbs), category (one of ' + VALID_CATEGORIES.join(', ') + '), ' +
  'hoursToSpoil (number), needsRefrigeration (boolean). Also extract donorName, ' +
  'pickupLocation, pickupLat, pickupLng when present. Return JSON: ' +
  '{"donorName"?,"pickupLocation"?,"pickupLat"?,"pickupLng"?,"items":[{"item","qtyLbs",' +
  '"category","hoursToSpoil","needsRefrigeration"}]}.';

/**
 * Agent 1 — raw text → ParsedDonation (§6). Prompts the LLM with a strict JSON
 * contract, tolerantly extracts the result, then validates/coerces it. Any
 * failure degrades to the deterministic heuristic parser — never throws.
 */
export async function parseDonation(
  raw: string,
  channel: Channel,
  llm: LlmClient = createLlm(),
): Promise<ParsedDonation> {
  try {
    const prompt = buildTaskPrompt('intake', INSTRUCTIONS, { raw, channel });
    const out = await llm.complete({ prompt, json: true });
    const parsed = extractJson<ParsedDonation>(out);
    const coerced = coerce(parsed);
    if (coerced.items.length > 0) return coerced;
    // Empty extraction — fall through to heuristic on the raw text.
    return heuristicParse(raw);
  } catch {
    return heuristicParse(raw);
  }
}

function coerce(p: unknown): ParsedDonation {
  const obj = (p ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(obj.items) ? (obj.items as Record<string, unknown>[]) : [];
  const items: ParsedDonation['items'] = rawItems
    .map((it) => {
      const category = normalizeCategory(it.category);
      const qtyLbs = toNum(it.qtyLbs);
      const hoursToSpoil = toNum(it.hoursToSpoil);
      const item = typeof it.item === 'string' && it.item.trim() ? it.item.trim() : 'donation';
      return {
        item,
        qtyLbs: qtyLbs > 0 ? qtyLbs : 0,
        category,
        hoursToSpoil: hoursToSpoil > 0 ? hoursToSpoil : 168,
        needsRefrigeration: Boolean(it.needsRefrigeration),
      };
    })
    .filter((it) => it.qtyLbs > 0);

  const out: ParsedDonation = { items };
  if (typeof obj.donorName === 'string') out.donorName = obj.donorName;
  if (typeof obj.pickupLocation === 'string') out.pickupLocation = obj.pickupLocation;
  if (typeof obj.pickupLat === 'number') out.pickupLat = obj.pickupLat;
  if (typeof obj.pickupLng === 'number') out.pickupLng = obj.pickupLng;
  return out;
}

function normalizeCategory(c: unknown): ItemCategory {
  const s = String(c ?? '').toLowerCase().replace(/\s+/g, '_');
  return (VALID_CATEGORIES as string[]).includes(s) ? (s as ItemCategory) : 'other';
}

function toNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
