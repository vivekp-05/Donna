import type {
  Recipient, EquitySimResult, Donation, DonationItem, ItemCategory,
} from '../types.js';
import { DEFAULT_AGENT_CONFIG } from '../../config.js';
import { rankRecipients, scoreItem } from './engine.js';

/**
 * Gini coefficient (0 = perfectly equal, →1 = maximally unequal).
 * Mean-absolute-difference form. Empty/zero-sum inputs return 0.
 */
export function gini(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  let absDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      absDiff += Math.abs(values[i] - values[j]);
    }
  }
  return absDiff / (2 * n * sum);
}

/**
 * min/max ratio (1 = perfectly equal). Guards div-by-zero: an all-zero or
 * empty vector is treated as perfectly equal (ratio 1).
 */
export function minMaxRatio(values: number[]): number {
  if (values.length === 0) return 1;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === 0) return 1;
  return min / max;
}

/** Seeded PRNG — mulberry32. Math.random is FORBIDDEN in this module. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Non-refrigerated categories keep the A/B story focused on equity/capacity/
// feasibility rather than cold-chain gating.
const SIM_CATEGORIES: ItemCategory[] = [
  'canned', 'dry_goods', 'baked', 'fruit', 'beverages', 'other',
];

const SIM_CONFIG = { ...DEFAULT_AGENT_CONFIG, weights: { ...DEFAULT_AGENT_CONFIG.weights } };

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function cloneRecipients(recipients: Recipient[]): Recipient[] {
  return recipients.map((r) => ({ ...r }));
}

/**
 * §4 equity — A/B simulation. Generates `drops` deterministic random donations
 * and allocates each under two policies:
 *   nearest — closest recipient passing hard gates
 *   donna   — top of rankRecipients (default weights), equity-aware
 * Both mutate independently-cloned ledgers. Same seed ⇒ identical result.
 */
export function simulateAB(
  recipients: Recipient[],
  drops = 30,
  seed = 42,
): EquitySimResult {
  const rng = mulberry32(seed);

  const nearestState = cloneRecipients(recipients);
  const donnaState = cloneRecipients(recipients);
  const nearestById = new Map(nearestState.map((r) => [r.id, r]));
  const donnaById = new Map(donnaState.map((r) => [r.id, r]));

  // SF bounding box for random pickup points (keeps drives feasible).
  const LAT0 = 37.70, LAT1 = 37.81;
  const LNG0 = -122.51, LNG1 = -122.38;

  const series: EquitySimResult['series'] = [];

  for (let d = 0; d < drops; d++) {
    const category = pick(rng, SIM_CATEGORIES);
    const qtyLbs = Math.round(50 + rng() * 750);        // 50..800 lbs
    const hoursToSpoil = Math.round(48 + rng() * 300);  // 48..348 h (feasible)
    const pickupLat = LAT0 + rng() * (LAT1 - LAT0);
    const pickupLng = LNG0 + rng() * (LNG1 - LNG0);

    const donation: Donation = {
      id: `sim-d-${d}`, sourceChannel: 'web_form', sourceContact: 'sim',
      receivedAt: '1970-01-01T00:00:00.000Z', rawText: '', status: 'scored',
      pickupLat, pickupLng, items: [],
    };
    const item: DonationItem = {
      id: `sim-i-${d}`, donationId: donation.id,
      item: category, qtyLbs, category, hoursToSpoil,
      needsRefrigeration: false, status: 'pending', attempts: [],
    };

    // nearest policy — min distance among recipients passing hard gates.
    let bestNearest: Recipient | undefined;
    let bestDist = Infinity;
    for (const r of nearestState) {
      const sb = scoreItem(item, donation, r, SIM_CONFIG, [], nearestState);
      if (sb.hardFail) continue;
      if (sb.distanceMiles < bestDist) {
        bestDist = sb.distanceMiles;
        bestNearest = r;
      }
    }
    if (bestNearest) {
      nearestById.get(bestNearest.id)!.receivedRecentLbs += qtyLbs;
    }

    // donna policy — top of the ranking (equity-aware) that isn't a hard fail.
    const donnaRanked = rankRecipients(item, donation, donnaState, SIM_CONFIG, []);
    const donnaWinner = donnaRanked.find((rr) => !rr.score.hardFail);
    if (donnaWinner) {
      donnaById.get(donnaWinner.recipient.id)!.receivedRecentLbs += qtyLbs;
    }

    series.push({
      drop: d + 1,
      nearestGini: gini(nearestState.map((r) => r.receivedRecentLbs)),
      donnaGini: gini(donnaState.map((r) => r.receivedRecentLbs)),
    });
  }

  const nearestLbs = nearestState.map((r) => r.receivedRecentLbs);
  const donnaLbs = donnaState.map((r) => r.receivedRecentLbs);

  const nearestLedger: Record<string, number> = {};
  for (const r of nearestState) nearestLedger[r.id] = r.receivedRecentLbs;
  const donnaLedger: Record<string, number> = {};
  for (const r of donnaState) donnaLedger[r.id] = r.receivedRecentLbs;

  return {
    drops,
    nearest: {
      perRecipientLbs: nearestLedger,
      minMaxRatio: minMaxRatio(nearestLbs),
      gini: gini(nearestLbs),
    },
    donna: {
      perRecipientLbs: donnaLedger,
      minMaxRatio: minMaxRatio(donnaLbs),
      gini: gini(donnaLbs),
    },
    series,
  };
}
