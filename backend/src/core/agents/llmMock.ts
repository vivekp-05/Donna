import type { LlmClient } from './llm.js';
import { readTaskPrompt } from './protocol.js';
import { humanize, firstName, fmtUrgency } from '../text/humanize.js';
import type {
  ParsedDonation,
  ItemCategory,
  Infrastructure,
  ConfigPatch,
} from '../types.js';

// ---------------------------------------------------------------------------
// Deterministic mock LLM (§6). Reads the DONNA task payload embedded by each
// agent and computes a deterministic response. Never touches the network.
// ---------------------------------------------------------------------------

export class LlmMock implements LlmClient {
  async complete(opts: { system?: string; prompt: string; json?: boolean }): Promise<string> {
    const req = readTaskPrompt(opts.prompt);
    if (!req) {
      // Unknown / free-form prompt: degrade to a harmless echo, never throw.
      return opts.json ? '{}' : 'OK';
    }
    switch (req.task) {
      case 'intake':
        return JSON.stringify(heuristicParse(String(req.input.raw ?? '')));
      case 'offer':
        return JSON.stringify(mockOffer(req.input));
      case 'callback':
        return mockCallback(req.input);
      case 'manager':
        return JSON.stringify(mockManagerFromPayload(req.input));
      case 'explain':
        return mockExplain(req.input);
      default:
        return opts.json ? '{}' : 'OK';
    }
  }
}

// ---------------------------------------------------------------------------
// Category / refrigeration / spoilage maps
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: ItemCategory[] = [
  'fresh_produce', 'fruit', 'canned', 'dry_goods', 'baked',
  'dairy', 'meat', 'prepared', 'beverages', 'other',
];

const VALID_INFRA: Infrastructure[] = [
  'walk_in_fridge', 'fridge', 'freezer', 'dry_storage', 'loading_dock',
];

// Ordered: earlier categories win when keywords overlap (e.g. "canned black
// beans" must resolve to `canned`, not `dry_goods` via the word "beans").
const CATEGORY_KEYWORDS: Array<[ItemCategory, string[]]> = [
  ['fresh_produce', ['fresh', 'strawberr', 'lettuce', 'spinach', 'kale', 'vegetable', 'veggie', 'greens', 'tomato', 'carrot', 'broccoli', 'cucumber', 'pepper', 'salad', 'produce', 'herb']],
  ['canned', ['canned', 'can of', 'tinned', 'tin of']],
  ['dairy', ['milk', 'cheese', 'yogurt', 'yoghurt', 'dairy', 'butter', 'cream', 'egg']],
  ['meat', ['meat', 'chicken', 'beef', 'pork', 'fish', 'poultry', 'turkey', 'sausage', 'bacon', 'ham']],
  ['prepared', ['prepared', 'meal', 'cooked', 'deli', 'sandwich', 'soup', 'entree', 'leftover']],
  ['baked', ['bread', 'baked', 'pastry', 'bagel', 'muffin', 'roll', 'cake', 'bun', 'donut', 'croissant', 'loaf']],
  ['fruit', ['fruit', 'apple', 'banana', 'orange', 'grape', 'melon', 'pear', 'peach', 'mango', 'berry', 'citrus']],
  ['dry_goods', ['rice', 'pasta', 'flour', 'cereal', 'dry good', 'grain', 'oats', 'beans', 'lentil', 'legume', 'sugar']],
  ['beverages', ['beverage', 'juice', 'soda', 'water', 'drink', 'coffee', 'tea', 'cola']],
];

const REFRIGERATED_CATEGORIES = new Set<ItemCategory>(['fresh_produce', 'dairy', 'meat', 'prepared']);

const DEFAULT_SPOIL_HOURS: Record<ItemCategory, number> = {
  fresh_produce: 72,
  fruit: 120,
  canned: 2160,
  dry_goods: 4320,
  baked: 24,
  dairy: 168,
  meat: 96,
  prepared: 48,
  beverages: 720,
  other: 168,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const UNIT_MULTIPLIER: Array<[RegExp, number]> = [
  [/^pallets?$/, 1000],
  [/^cases?$/, 30],
  [/^boxes?$/, 30],
  [/^crates?$/, 40],
  [/^bags?$/, 25],
  [/^trays?$/, 20],
  [/^flats?$/, 20],
  [/^(?:pounds?|lbs?)$/, 1],
  [/^(?:kg|kilograms?)$/, 2.20462],
];

// A tiny San Francisco gazetteer so the mock can produce pickup coords offline.
const GAZETTEER: Array<{ key: string; lat: number; lng: number }> = [
  { key: 'jerrold', lat: 37.7455, lng: -122.3934 },
  { key: 'mission', lat: 37.7599, lng: -122.4148 },
  { key: 'market', lat: 37.7749, lng: -122.4194 },
  { key: 'bayshore', lat: 37.7205, lng: -122.4016 },
  { key: 'evans', lat: 37.7398, lng: -122.3835 },
];

// ---------------------------------------------------------------------------
// Agent 1 — heuristic intake parser
// ---------------------------------------------------------------------------

const ITEM_RE = new RegExp(
  '\\b(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)' +
    '\\s*(pallets?|cases?|boxes?|crates?|bags?|trays?|flats?|pounds?|lbs?|kg|kilograms?)\\b' +
    '(?:\\s+of)?\\s+' +
    "([a-zA-Z][a-zA-Z'\\-]*(?:\\s+[a-zA-Z][a-zA-Z'\\-]*)*?)" +
    '(?=\\s*(?:,|\\.|;|\\u2014|\\u2013|\\bplus\\b|\\band\\b|\\bthey\\b|\\bthat\\b|\\bwhich\\b|\\bfor\\b|\\bat\\b|$))',
  'gi',
);

const SPOIL_RE = /(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(hours?|hrs?|days?|weeks?)/i;

export function heuristicParse(raw: string): ParsedDonation {
  const text = raw.replace(/\s+/g, ' ').trim();
  const items: ParsedDonation['items'] = [];

  const anchors: Array<{ index: number; qty: number; unit: string; itemText: string }> = [];
  let m: RegExpExecArray | null;
  ITEM_RE.lastIndex = 0;
  while ((m = ITEM_RE.exec(text)) !== null) {
    const qty = parseQty(m[1]);
    if (qty == null) continue;
    anchors.push({
      index: m.index,
      qty,
      unit: m[2].toLowerCase(),
      itemText: m[3].trim().replace(/\s+/g, ' '),
    });
  }

  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const segEnd = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
    const segment = text.slice(a.index, segEnd);

    const category = detectCategory(a.itemText);
    const needsRefrigeration = REFRIGERATED_CATEGORIES.has(category);
    const qtyLbs = round2(a.qty * unitMultiplier(a.unit));
    const hoursToSpoil = parseSpoilage(segment) ?? DEFAULT_SPOIL_HOURS[category];

    items.push({
      item: cleanItemName(a.itemText),
      qtyLbs,
      category,
      hoursToSpoil,
      needsRefrigeration,
    });
  }

  const parsed: ParsedDonation = { items };

  const donor = /\b(?:this is|i'?m|it'?s)\s+([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+)?)\s+from\b/.exec(raw);
  if (donor) parsed.donorName = donor[1].trim();

  const addr = /(\d{2,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\s+(?:Ave|Avenue|St|Street|Blvd|Boulevard|Rd|Road|Way|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Sq|Square))/.exec(raw);
  if (addr) parsed.pickupLocation = addr[1].trim();

  const lower = raw.toLowerCase();
  for (const g of GAZETTEER) {
    if (lower.includes(g.key)) {
      parsed.pickupLat = g.lat;
      parsed.pickupLng = g.lng;
      break;
    }
  }

  return parsed;
}

function parseQty(token: string): number | null {
  const t = token.toLowerCase();
  if (/^\d/.test(t)) return Number.parseFloat(t);
  return NUMBER_WORDS[t] ?? null;
}

function unitMultiplier(unit: string): number {
  for (const [re, mult] of UNIT_MULTIPLIER) if (re.test(unit)) return mult;
  return 1;
}

function detectCategory(itemText: string): ItemCategory {
  const t = itemText.toLowerCase();
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    for (const kw of kws) if (t.includes(kw)) return cat;
  }
  return 'other';
}

function parseSpoilage(segment: string): number | null {
  const m = SPOIL_RE.exec(segment);
  if (!m) return null;
  const n = parseQty(m[1]);
  if (n == null) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('day')) return round2(n * 24);
  if (unit.startsWith('week')) return round2(n * 168);
  return round2(n); // hours
}

function cleanItemName(itemText: string): string {
  return itemText
    .split(/\s+/)
    .filter((w) => !/^(?:and|plus|or|the|a|an|of)$/i.test(w))
    .join(' ')
    .trim() || itemText;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Agent 2 — offer template
// ---------------------------------------------------------------------------

// UI_REDESIGN §D.3 — kept in lockstep with offer.ts templateScript: ≤2 spoken
// sentences, first-name greeting, one optional memory clause, the ask. Never
// enumerates infrastructure/accepts/rejects, never prints raw enum tokens.
function mockOffer(input: Record<string, unknown>): { script: string; summary: string } {
  const itemName = str(input.itemName, 'the donation');
  const qtyLbs = num(input.qtyLbs, 0);
  const hoursToSpoil = num(input.hoursToSpoil, 0);
  const recipientName = str(input.recipientName, 'your organization');
  const contact = firstName(input.contactFirstName ?? input.recipientContact) || recipientName;
  const hint = str(input.memoryHint, '');

  const first = `Hi ${contact}, I've got ${fmtLbs(qtyLbs)} of ${itemName} that needs to move ${fmtUrgency(hoursToSpoil)}.`;
  const ask = hint ? `${hint}, so could your team take it today?` : 'Could your team take it today?';

  const script = `${first} ${ask}`;
  const summary = `Offer ${fmtLbs(qtyLbs)} of ${itemName} to ${recipientName}.`;
  return { script, summary };
}

// ---------------------------------------------------------------------------
// Agent 5 — donor callback template (itemized, ≤120 words)
// ---------------------------------------------------------------------------

interface CallbackItem {
  item: string;
  qtyLbs: number;
  status: string;
  recipientName?: string;
  reason?: string;
}

function mockCallback(input: Record<string, unknown>): string {
  const donorName = str(input.donorName, '');
  const rawItems = Array.isArray(input.items) ? (input.items as Record<string, unknown>[]) : [];
  const items: CallbackItem[] = rawItems.map((it) => ({
    item: str(it.item, 'items'),
    qtyLbs: num(it.qtyLbs, 0),
    status: str(it.status, 'pending'),
    recipientName: it.recipientName ? String(it.recipientName) : undefined,
    reason: it.reason ? String(it.reason) : undefined,
  }));

  const lines: string[] = [];
  lines.push(`Hi ${donorName || 'there'}, this is Donna with an update on your donation.`);

  const placed = items.filter((i) => i.status === 'matched');
  const unplaced = items.filter((i) => i.status !== 'matched');

  for (const i of placed) {
    lines.push(`We placed ${fmtLbs(i.qtyLbs)} of ${i.item} with ${i.recipientName || 'a partner agency'}.`);
  }
  for (const i of unplaced) {
    lines.push(
      `We couldn't place ${fmtLbs(i.qtyLbs)} of ${i.item}` +
        `${i.reason ? ` (${i.reason})` : ''}.`,
    );
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

// ---------------------------------------------------------------------------
// Agent 4 — manager pattern matcher (proposes ConfigPatch[]; code validates)
// ---------------------------------------------------------------------------

interface ManagerRecipient {
  id: string;
  name: string;
  accepts?: ItemCategory[];
  rejects?: ItemCategory[];
  infrastructure?: Infrastructure[];
}

interface ManagerProposal {
  reply: string;
  patches: ConfigPatch[];
}

function mockManagerFromPayload(input: Record<string, unknown>): ManagerProposal {
  const message = str(input.message, '');
  const rawR = Array.isArray(input.recipients) ? (input.recipients as Record<string, unknown>[]) : [];
  const recipients: ManagerRecipient[] = rawR.map((r) => ({
    id: str(r.id, ''),
    name: str(r.name, ''),
    accepts: Array.isArray(r.accepts) ? (r.accepts as ItemCategory[]) : [],
    rejects: Array.isArray(r.rejects) ? (r.rejects as ItemCategory[]) : [],
    infrastructure: Array.isArray(r.infrastructure) ? (r.infrastructure as Infrastructure[]) : [],
  }));
  return heuristicManager(message, recipients);
}

/** Deterministic pattern matcher shared with the manager agent fallback. */
export function heuristicManager(
  message: string,
  recipients: ManagerRecipient[],
): ManagerProposal {
  const msg = message.toLowerCase();
  const target = matchRecipient(message, recipients);

  // 1) Infrastructure gained ("got a new freezer / fridge / walk-in").
  if (/\b(got|have|added|installed|now have|just got|picked up|bought)\b/.test(msg) &&
      /\b(freezer|fridge|refrigerat|walk[\s-]?in|cold storage)\b/.test(msg)) {
    if (target) {
      const infra = detectInfrastructure(msg);
      const patches: ConfigPatch[] = infra.map((v) => ({
        op: 'add_infrastructure',
        recipientId: target.id,
        value: v,
      }));
      if (patches.length) {
        return {
          reply: `Got it — I've added ${infra.map(prettyInfra).join(' and ')} to ${target.name}. They can now take cold-chain items.`,
          patches,
        };
      }
    }
  }

  // 2) Infrastructure lost ("lost / removed our freezer").
  if (/\b(lost|removed|broke|down|no longer have|got rid of)\b/.test(msg) &&
      /\b(freezer|fridge|refrigerat|walk[\s-]?in|cold storage)\b/.test(msg)) {
    if (target) {
      const infra = detectInfrastructure(msg);
      const patches: ConfigPatch[] = infra.map((v) => ({
        op: 'remove_infrastructure',
        recipientId: target.id,
        value: v,
      }));
      if (patches.length) {
        return {
          reply: `Understood — I've removed ${infra.map(prettyInfra).join(' and ')} from ${target.name}.`,
          patches,
        };
      }
    }
  }

  // 3) "only send / only accept X" -> set_accepts.
  if (/\bonly\b/.test(msg) && /\b(send|accept|take|want)\b/.test(msg)) {
    const cats = parseCategoriesFromText(msg);
    if (target && cats.length) {
      return {
        reply: `Done — ${target.name} will now only be offered ${cats.map(prettyCategory).join(', ')}.`,
        patches: [{ op: 'set_accepts', recipientId: target.id, value: cats }],
      };
    }
  }

  // 4) "stop sending / don't send / no more X" -> set_rejects (merged).
  if (/\b(stop|don'?t|do not|no more|quit)\b/.test(msg) && /\b(send|sending)\b/.test(msg)) {
    const cats = parseCategoriesFromText(msg);
    if (target && cats.length) {
      const merged = uniq([...(target.rejects ?? []), ...cats]);
      return {
        reply: `Noted — I'll stop routing ${cats.map(prettyCategory).join(', ')} to ${target.name}.`,
        patches: [{ op: 'set_rejects', recipientId: target.id, value: merged }],
      };
    }
  }

  // 5) Weight tweaks ("prioritize equity / fairness").
  if (/\b(prioriti[sz]e|weigh|emphasi[sz]e|focus on)\b/.test(msg)) {
    const w = detectWeightKey(msg);
    if (w) {
      return {
        reply: `Sure — I've increased the ${w} weight in the allocation model.`,
        patches: [{ op: 'set_weights', value: { [w]: 0.4 } }],
      };
    }
  }

  // 6) Autopilot toggle.
  if (/\bautopilot\b/.test(msg) || /\bauto[\s-]?dispatch\b/.test(msg)) {
    const on = !/\b(off|disable|stop|pause)\b/.test(msg);
    return {
      reply: `Autopilot is now ${on ? 'on' : 'off'}.`,
      patches: [{ op: 'set_autopilot', value: on }],
    };
  }

  return {
    reply:
      "I couldn't map that to a change I can make. Try things like " +
      '"St. Mary\'s just got a new walk-in freezer", "only send produce to Mission Greens", ' +
      'or "stop sending dairy to Oak Avenue".',
    patches: [],
  };
}

function matchRecipient(message: string, recipients: ManagerRecipient[]): ManagerRecipient | null {
  const msgNorm = normalizeName(message);
  // Exact substring of the full normalized name first.
  for (const r of recipients) {
    const n = normalizeName(r.name);
    if (n && msgNorm.includes(n)) return r;
  }
  // Otherwise best token overlap (tokens longer than 2 chars).
  let best: ManagerRecipient | null = null;
  let bestScore = 0;
  const msgTokens = new Set(msgNorm.split(' ').filter((t) => t.length > 2));
  for (const r of recipients) {
    const tokens = normalizeName(r.name).split(' ').filter((t) => t.length > 2);
    let score = 0;
    for (const t of tokens) if (msgTokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 1 ? best : null;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/['.,]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectInfrastructure(msg: string): Infrastructure[] {
  const out: Infrastructure[] = [];
  const walkIn = /\bwalk[\s-]?in\b/.test(msg);
  if (/\bfreezer\b/.test(msg)) out.push('freezer');
  if (walkIn) out.push('walk_in_fridge');
  if (!walkIn && /\b(fridge|refrigerat|cold storage)\b/.test(msg)) out.push('fridge');
  return uniq(out);
}

function detectWeightKey(msg: string): string | null {
  if (/\bequit|fair/.test(msg)) return 'equity';
  if (/\bcapacit/.test(msg)) return 'capacity';
  if (/\bcold|refriger|coldchain/.test(msg)) return 'coldchain';
  if (/\bfeasib|time|distance/.test(msg)) return 'feasibility';
  if (/\bpref|preferen/.test(msg)) return 'prefs';
  return null;
}

function parseCategoriesFromText(text: string): ItemCategory[] {
  const out: ItemCategory[] = [];
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    for (const kw of kws) {
      if (text.includes(kw)) {
        out.push(cat);
        break;
      }
    }
  }
  // Direct category-name mentions too (e.g. "dry goods", "beverages").
  for (const c of VALID_CATEGORIES) {
    if (text.includes(c.replace('_', ' ')) || text.includes(c)) out.push(c);
  }
  return uniq(out);
}

// ---------------------------------------------------------------------------
// Explain (best-effort; WP-A owns explain.ts and may use this via the protocol)
// ---------------------------------------------------------------------------

function mockExplain(input: Record<string, unknown>): string {
  const itemName = str(input.itemName, 'this item');
  const top = Array.isArray(input.top) ? (input.top as Record<string, unknown>[]) : [];
  if (top.length >= 2) {
    const a = top[0];
    const b = top[1];
    const an = str(a.name, 'the top recipient');
    const bn = str(b.name, 'the runner-up');
    const at = num(a.total, 0);
    const bt = num(b.total, 0);
    return (
      `${an} ranks first for ${itemName} with an overall score of ${at.toFixed(2)}, ` +
      `ahead of ${bn} at ${bt.toFixed(2)} — a stronger balance of feasibility, capacity, and equity.`
    );
  }
  return `${itemName} was scored against all recipients and the top match was selected on overall fit.`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
function prettyCategory(c: string): string {
  return humanize(c);
}
function prettyInfra(i: Infrastructure): string {
  return humanize(i);
}
function fmtLbs(n: number): string {
  return `${n} lbs`;
}
function clampWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(' ') + '…';
}

export { VALID_CATEGORIES, VALID_INFRA };
