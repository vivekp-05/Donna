import type { DonationItem, RankedRecipient, ScoreBreakdown } from '../types.js';
import type { LlmClient } from '../agents/llm.js';
import { buildTaskPrompt } from '../agents/protocol.js';

const EXPLAIN_INSTRUCTIONS =
  'You are a dispatch analyst. In exactly two plain, non-technical sentences, ' +
  'explain why the #1 recipient beats the #2 recipient for this donation item. ' +
  'Reference the concrete scoring dimensions. No preamble, no markdown.';

const TERM_LABELS: Record<string, string> = {
  feasibility: 'time-feasibility',
  coldchain: 'cold-chain fit',
  capacity: 'capacity fit',
  equity: 'fair-share equity',
  prefs: 'category preference',
};

const TERM_KEYS = ['feasibility', 'coldchain', 'capacity', 'equity', 'prefs'] as const;
type TermKey = (typeof TERM_KEYS)[number];

function pct(x: number): number {
  return Math.round(x * 100);
}

function biggestEdge(a: ScoreBreakdown, b: ScoreBreakdown): TermKey {
  let best: TermKey = 'feasibility';
  let bestDiff = -Infinity;
  for (const k of TERM_KEYS) {
    const diff = a[k] - b[k];
    if (diff > bestDiff) {
      bestDiff = diff;
      best = k;
    }
  }
  return best;
}

function topStrengths(sb: ScoreBreakdown): TermKey[] {
  return [...TERM_KEYS].sort((x, y) => sb[y] - sb[x]).slice(0, 2);
}

/**
 * Deterministic, number-grounded fallback that never needs a network call.
 */
function templateExplanation(item: DonationItem, ranked: RankedRecipient[]): string {
  const top1 = ranked[0];
  if (!top1) return `No feasible recipient was found for ${item.item}.`;
  const name1 = top1.recipient.name;

  if (top1.score.hardFail) {
    return `No feasible recipient was found for ${item.item}; the best candidate ` +
      `${name1} still hard-failed (${top1.score.hardFail.replace(/_/g, ' ')}).`;
  }

  const top2 = ranked[1];
  if (!top2) {
    const strengths = topStrengths(top1.score).map((k) => TERM_LABELS[k]).join(' and ');
    return `${name1} is the only feasible home for ${item.item} ` +
      `(overall ${pct(top1.score.total)}%), strongest on ${strengths}.`;
  }

  const name2 = top2.recipient.name;
  const strengths = topStrengths(top1.score).map((k) => TERM_LABELS[k]).join(' and ');
  const edge = biggestEdge(top1.score, top2.score);
  const s1 =
    `${name1} ranks #1 for ${item.item} at ${pct(top1.score.total)}% overall, ` +
    `leading on ${strengths}.`;
  const s2 = top2.score.hardFail
    ? `It clears the hard gates that ${name2} fails (${top2.score.hardFail.replace(/_/g, ' ')}).`
    : `It edges out ${name2} (${pct(top2.score.total)}%) mainly on ${TERM_LABELS[edge]}.`;
  return `${s1} ${s2}`;
}

/**
 * §4 explain — 2 plain sentences on why #1 beat #2. Uses an injected LlmClient
 * when available; otherwise (and on any LLM error) returns a number-grounded
 * template. Never throws.
 */
export async function explainRanking(
  item: DonationItem,
  ranked: RankedRecipient[],
  llm?: LlmClient,
): Promise<string> {
  const fallback = templateExplanation(item, ranked);
  if (!llm) return fallback;

  const top = ranked.slice(0, 2).map((rr) => ({
    name: rr.recipient.name,
    total: rr.score.total,
    hardFail: rr.score.hardFail ?? null,
    feasibility: rr.score.feasibility,
    coldchain: rr.score.coldchain,
    capacity: rr.score.capacity,
    equity: rr.score.equity,
    prefs: rr.score.prefs,
    driveTimeHours: rr.score.driveTimeHours,
    distanceMiles: rr.score.distanceMiles,
  }));

  try {
    // Route through the shared task protocol: the deterministic mock reads the
    // payload (itemName + top[].name/.total) and returns a number-grounded
    // sentence; live LLMs read the natural-language instructions and ignore the tag.
    const prompt = buildTaskPrompt('explain', EXPLAIN_INSTRUCTIONS, {
      itemName: item.item,
      item: {
        name: item.item, qtyLbs: item.qtyLbs, category: item.category,
        hoursToSpoil: item.hoursToSpoil, needsRefrigeration: item.needsRefrigeration,
      },
      top,
    });
    const out = await llm.complete({ system: EXPLAIN_INSTRUCTIONS, prompt });
    const trimmed = (out ?? '').trim();
    return trimmed.length > 0 ? trimmed : fallback;
  } catch {
    return fallback;
  }
}
