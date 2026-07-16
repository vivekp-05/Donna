import { describe, it, expect } from 'vitest';
import type {
  Donation, DonationItem, Recipient, AgentConfig, HistoryEvent, ItemCategory,
  Infrastructure, RankedRecipient,
} from '../src/core/types.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import {
  feasibilityTerm, coldchainTerm, capacityTerm, equityTerm, prefsTerm,
  haversineMiles, driveTimeHours, clamp01,
} from '../src/core/scoring/terms.js';
import { scoreItem, rankRecipients } from '../src/core/scoring/engine.js';
import { gini, minMaxRatio, simulateAB } from '../src/core/scoring/equity.js';
import { explainRanking } from '../src/core/scoring/explain.js';
import { DEFAULT_AGENT_CONFIG } from '../src/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: AgentConfig = {
  weights: { ...DEFAULT_AGENT_CONFIG.weights },
  autopilot: false,
  avgSpeedMph: 30,
};

function makeRecipient(over: Partial<Recipient> = {}): Recipient {
  return {
    id: over.id ?? 'r1',
    name: over.name ?? 'Test Recipient',
    type: over.type ?? 'pantry',
    leadContact: 'Alex Doe',
    phone: '+14155550100',
    lat: over.lat ?? 37.7749,
    lng: over.lng ?? -122.4194,
    infrastructure: over.infrastructure ?? ['dry_storage'],
    accepts: over.accepts ?? [],
    rejects: over.rejects ?? [],
    typicalWeeklyVolumeLbs: over.typicalWeeklyVolumeLbs ?? 1000,
    receivedRecentLbs: over.receivedRecentLbs ?? 0,
    ...over,
  };
}

function makeItem(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: over.id ?? 'i1',
    donationId: over.donationId ?? 'd1',
    item: over.item ?? 'strawberries',
    qtyLbs: over.qtyLbs ?? 500,
    category: over.category ?? 'fresh_produce',
    hoursToSpoil: over.hoursToSpoil ?? 48,
    needsRefrigeration: over.needsRefrigeration ?? true,
    status: 'pending',
    attempts: [],
    ...over,
  };
}

function makeDonation(over: Partial<Donation> = {}): Donation {
  return {
    id: over.id ?? 'd1',
    sourceChannel: 'voice',
    sourceContact: 'donor',
    receivedAt: '2026-07-16T00:00:00.000Z',
    rawText: '',
    status: 'scored',
    pickupLat: over.pickupLat ?? 37.7455,
    pickupLng: over.pickupLng ?? -122.3934,
    items: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

describe('geometry helpers', () => {
  it('haversine is zero for identical points', () => {
    expect(haversineMiles(37.7, -122.4, 37.7, -122.4)).toBeCloseTo(0, 6);
  });
  it('haversine ~ real SF distance (Ferry Building ↔ Golden Gate Park ~4-5mi)', () => {
    const d = haversineMiles(37.7955, -122.3937, 37.7694, -122.4862);
    expect(d).toBeGreaterThan(4);
    expect(d).toBeLessThan(6);
  });
  it('driveTime = miles / mph, guards non-positive speed', () => {
    expect(driveTimeHours(30, 30)).toBeCloseTo(1, 6);
    expect(driveTimeHours(30, 0)).toBeCloseTo(1, 6); // falls back to 30mph
  });
  it('clamp01 bounds and NaN-guards', () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4.1 feasibility (HARD GATE)
// ---------------------------------------------------------------------------

describe('feasibilityTerm §4.1', () => {
  it('hard-fails when round-trip + 1h handling >= spoilage', () => {
    // driveHours*2 + 1 >= hoursToSpoil
    const r = feasibilityTerm(3, 7); // 3*2+1=7 >= 7
    expect(r.hardFail).toBe(true);
    expect(r.score).toBe(0);
  });
  it('passes and scores 1 - drive/spoil when feasible', () => {
    const r = feasibilityTerm(1, 48); // 3 < 48
    expect(r.hardFail).toBe(false);
    expect(r.score).toBeCloseTo(1 - 1 / 48, 6);
  });
  it('closer pickups score higher (monotonic in drive time)', () => {
    const near = feasibilityTerm(0.5, 48).score;
    const far = feasibilityTerm(5, 48).score;
    expect(near).toBeGreaterThan(far);
  });
});

// ---------------------------------------------------------------------------
// §4.2 coldchain (HARD GATE)
// ---------------------------------------------------------------------------

describe('coldchainTerm §4.2', () => {
  const refItem = makeItem({ needsRefrigeration: true });
  it('non-refrigerated item always scores 1, never fails', () => {
    const item = makeItem({ needsRefrigeration: false });
    const r = coldchainTerm(item, makeRecipient({ infrastructure: ['dry_storage'] }));
    expect(r).toEqual({ score: 1, hardFail: false });
  });
  it('hard-fails a refrigerated item at a dry-only recipient', () => {
    const r = coldchainTerm(refItem, makeRecipient({ infrastructure: ['dry_storage'] }));
    expect(r.hardFail).toBe(true);
    expect(r.score).toBe(0);
  });
  it('walk_in_fridge scores 1.0 for refrigerated items', () => {
    const r = coldchainTerm(refItem, makeRecipient({ infrastructure: ['walk_in_fridge'] }));
    expect(r).toEqual({ score: 1.0, hardFail: false });
  });
  it('plain fridge scores 0.85 (still passes)', () => {
    const r = coldchainTerm(refItem, makeRecipient({ infrastructure: ['fridge'] }));
    expect(r).toEqual({ score: 0.85, hardFail: false });
  });
  it('freezer counts as strong cold storage (1.0)', () => {
    const r = coldchainTerm(refItem, makeRecipient({ infrastructure: ['freezer', 'fridge'] }));
    expect(r.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// §4.3 capacity (Gaussian, peak ~0.6)
// ---------------------------------------------------------------------------

describe('capacityTerm §4.3', () => {
  const peak = capacityTerm(0.6 * 1000, 1000); // r=0.6
  it('peaks near r≈0.6 (value 1)', () => {
    expect(peak).toBeCloseTo(1, 6);
    expect(capacityTerm(0.55 * 1000, 1000)).toBeLessThan(peak);
    expect(capacityTerm(0.65 * 1000, 1000)).toBeLessThan(peak);
  });
  it('r=0.1 and r=2.0 both score < 0.5 · peak', () => {
    expect(capacityTerm(0.1 * 1000, 1000)).toBeLessThan(0.5 * peak);
    expect(capacityTerm(2.0 * 1000, 1000)).toBeLessThan(0.5 * peak);
  });
  it('monotonically declines on both sides of the peak', () => {
    const belowRs = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    for (let i = 1; i < belowRs.length; i++) {
      expect(capacityTerm(belowRs[i] * 1000, 1000))
        .toBeGreaterThan(capacityTerm(belowRs[i - 1] * 1000, 1000));
    }
    const aboveRs = [0.6, 0.8, 1.0, 1.5, 2.0, 3.0];
    for (let i = 1; i < aboveRs.length; i++) {
      expect(capacityTerm(aboveRs[i] * 1000, 1000))
        .toBeLessThan(capacityTerm(aboveRs[i - 1] * 1000, 1000));
    }
  });
  it('guards zero volume', () => {
    expect(() => capacityTerm(500, 0)).not.toThrow();
    expect(capacityTerm(500, 0)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// §4.4 equity
// ---------------------------------------------------------------------------

describe('equityTerm §4.4', () => {
  const all = [
    makeRecipient({ id: 'a', receivedRecentLbs: 0 }),
    makeRecipient({ id: 'b', receivedRecentLbs: 1000 }),
    makeRecipient({ id: 'c', receivedRecentLbs: 2000 }),
  ]; // avg = 1000
  it('below-average recipient scores > 0.5', () => {
    expect(equityTerm(all[0], all)).toBeGreaterThan(0.5);
  });
  it('above-average recipient scores < 0.5', () => {
    expect(equityTerm(all[2], all)).toBeLessThan(0.5);
  });
  it('exactly-average recipient scores 0.5', () => {
    expect(equityTerm(all[1], all)).toBeCloseTo(0.5, 6);
  });
  it('clamps extreme over-served recipient to 0 floor', () => {
    const skewed = [
      makeRecipient({ id: 'x', receivedRecentLbs: 0 }),
      makeRecipient({ id: 'y', receivedRecentLbs: 100 }),
    ];
    expect(equityTerm(skewed[1], skewed)).toBeGreaterThanOrEqual(0);
    expect(equityTerm(skewed[1], skewed)).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// §4.5 prefs
// ---------------------------------------------------------------------------

describe('prefsTerm §4.5', () => {
  const NOW = Date.parse('2026-07-16T00:00:00.000Z');
  const produce = makeItem({ category: 'fresh_produce' });
  it('rejects ⇒ hard fail, score 0', () => {
    const r = prefsTerm(produce, makeRecipient({ rejects: ['fresh_produce'] }), [], NOW);
    expect(r).toEqual({ score: 0, hardFail: true });
  });
  it('accepts ⇒ 1.0', () => {
    const r = prefsTerm(produce, makeRecipient({ accepts: ['fresh_produce'] }), [], NOW);
    expect(r).toEqual({ score: 1.0, hardFail: false });
  });
  it('unlisted ⇒ 0.5', () => {
    const r = prefsTerm(produce, makeRecipient({}), [], NOW);
    expect(r).toEqual({ score: 0.5, hardFail: false });
  });
  it('a multi-word category decline within 7 days halves the score (humanized reason)', () => {
    // The simulator emits the HUMANIZED category ('fresh produce', space) in the
    // decline reason — mirror that exactly so the test reflects the real pipeline.
    const rec = makeRecipient({ id: 'r7', accepts: ['fresh_produce'] });
    const hist: HistoryEvent[] = [{
      id: 'h1', recipientId: 'r7', itemId: 'x', outcome: 'declined',
      reason: "we're still overstocked on fresh produce",
      at: '2026-07-14T00:00:00.000Z', // 2 days ago
    }];
    const r = prefsTerm(produce, rec, hist, NOW);
    expect(r.score).toBeCloseTo(0.5, 6); // 1.0 * 0.5
  });
  it('a single-word category decline within 7 days halves the score', () => {
    const canned = makeItem({ category: 'canned' });
    const rec = makeRecipient({ id: 'r7', accepts: ['canned'] });
    const hist: HistoryEvent[] = [{
      id: 'h1', recipientId: 'r7', itemId: 'x', outcome: 'declined',
      reason: "we're still overstocked on canned",
      at: '2026-07-14T00:00:00.000Z', // 2 days ago
    }];
    expect(prefsTerm(canned, rec, hist, NOW).score).toBeCloseTo(0.5, 6);
  });
  it('a decline older than 7 days does NOT penalize', () => {
    const rec = makeRecipient({ id: 'r7', accepts: ['fresh_produce'] });
    const hist: HistoryEvent[] = [{
      id: 'h1', recipientId: 'r7', itemId: 'x', outcome: 'declined',
      reason: 'overstocked on fresh produce',
      at: '2026-07-01T00:00:00.000Z', // >7 days ago
    }];
    expect(prefsTerm(produce, rec, hist, NOW).score).toBe(1.0);
  });
  it('a decline of a DIFFERENT category does not penalize', () => {
    const rec = makeRecipient({ id: 'r7', accepts: ['fresh_produce'] });
    const hist: HistoryEvent[] = [{
      id: 'h1', recipientId: 'r7', itemId: 'x', outcome: 'declined',
      reason: 'overstocked on canned', at: '2026-07-15T00:00:00.000Z',
    }];
    expect(prefsTerm(produce, rec, hist, NOW).score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// engine: scoreItem + rankRecipients
// ---------------------------------------------------------------------------

describe('scoreItem (§4 total)', () => {
  it('produces a normalized weighted total in [0,1] with no hard fail', () => {
    const item = makeItem({ needsRefrigeration: true, hoursToSpoil: 48, qtyLbs: 600 });
    const rec = makeRecipient({
      id: 'win', lat: 37.7455, lng: -122.3934, infrastructure: ['walk_in_fridge'],
      accepts: ['fresh_produce'], typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0,
    });
    const sb = scoreItem(item, makeDonation(), rec, CONFIG, [], [rec]);
    expect(sb.hardFail).toBeUndefined();
    expect(sb.total).toBeGreaterThan(0);
    expect(sb.total).toBeLessThanOrEqual(1);
    expect(sb.recipientId).toBe('win');
    expect(sb.distanceMiles).toBeGreaterThanOrEqual(0);
  });

  it('hard fail (no cold chain) short-circuits total to 0 and tags reason', () => {
    const item = makeItem({ needsRefrigeration: true });
    const rec = makeRecipient({ infrastructure: ['dry_storage'] });
    const sb = scoreItem(item, makeDonation(), rec, CONFIG, [], [rec]);
    expect(sb.total).toBe(0);
    expect(sb.hardFail).toBe('no_cold_chain');
  });

  it('infeasible time takes precedence and zeroes total', () => {
    const item = makeItem({ needsRefrigeration: false, hoursToSpoil: 1 });
    // far recipient, tiny spoil window
    const rec = makeRecipient({ lat: 38.5, lng: -121.5, infrastructure: ['dry_storage'] });
    const sb = scoreItem(item, makeDonation(), rec, CONFIG, [], [rec]);
    expect(sb.total).toBe(0);
    expect(sb.hardFail).toBe('infeasible_time');
  });

  it('category rejected zeroes total', () => {
    const item = makeItem({ needsRefrigeration: false, category: 'canned' });
    const rec = makeRecipient({ rejects: ['canned'], infrastructure: ['dry_storage'] });
    const sb = scoreItem(item, makeDonation(), rec, CONFIG, [], [rec]);
    expect(sb.total).toBe(0);
    expect(sb.hardFail).toBe('category_rejected');
  });

  it('uses city-center fallback when donation lacks coordinates', () => {
    const item = makeItem({ needsRefrigeration: false });
    const rec = makeRecipient({ lat: 37.7749, lng: -122.4194, infrastructure: ['dry_storage'] });
    const don = makeDonation({ pickupLat: undefined, pickupLng: undefined });
    const sb = scoreItem(item, don, rec, CONFIG, [], [rec]);
    expect(sb.distanceMiles).toBeCloseTo(0, 3); // recipient sits at fallback center
  });
});

describe('rankRecipients', () => {
  it('sorts by total desc and sinks hard-fails to the bottom', () => {
    const item = makeItem({ needsRefrigeration: true, hoursToSpoil: 48, qtyLbs: 600 });
    const recipients: Recipient[] = [
      makeRecipient({ id: 'dry', lat: 37.7455, lng: -122.3934, infrastructure: ['dry_storage'] }), // hard fail cold
      makeRecipient({ id: 'walkin', lat: 37.7455, lng: -122.3934, infrastructure: ['walk_in_fridge'], accepts: ['fresh_produce'], typicalWeeklyVolumeLbs: 1000 }),
      makeRecipient({ id: 'fridge', lat: 37.75, lng: -122.40, infrastructure: ['fridge'], typicalWeeklyVolumeLbs: 1000 }),
    ];
    const ranked = rankRecipients(item, makeDonation(), recipients, CONFIG, []);
    expect(ranked[0].recipient.id).toBe('walkin');
    expect(ranked[ranked.length - 1].recipient.id).toBe('dry');
    expect(ranked[ranked.length - 1].score.hardFail).toBe('no_cold_chain');
    // scores are monotonically non-increasing
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score.total).toBeGreaterThanOrEqual(ranked[i].score.total);
    }
  });

  it('equity visibly tips the ranking between two otherwise-equal recipients', () => {
    const item = makeItem({ needsRefrigeration: false, category: 'canned', hoursToSpoil: 200, qtyLbs: 600 });
    const under = makeRecipient({ id: 'under', lat: 37.7455, lng: -122.3934, infrastructure: ['dry_storage'], typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0 });
    const over = makeRecipient({ id: 'over', lat: 37.7455, lng: -122.3934, infrastructure: ['dry_storage'], typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 5000 });
    const ranked = rankRecipients(item, makeDonation(), [over, under], CONFIG, []);
    expect(ranked[0].recipient.id).toBe('under');
  });
});

// ---------------------------------------------------------------------------
// equity module: gini / minMaxRatio
// ---------------------------------------------------------------------------

describe('gini / minMaxRatio', () => {
  it('gini is 0 for a perfectly equal vector', () => {
    expect(gini([5, 5, 5, 5])).toBeCloseTo(0, 9);
  });
  it('gini known value: [0,0,0,1] = 0.75', () => {
    expect(gini([0, 0, 0, 1])).toBeCloseTo(0.75, 9);
  });
  it('gini handles empty and all-zero without NaN', () => {
    expect(gini([])).toBe(0);
    expect(gini([0, 0, 0])).toBe(0);
  });
  it('more concentrated distribution has higher gini', () => {
    expect(gini([10, 10, 10, 100])).toBeGreaterThan(gini([10, 10, 10, 20]));
  });
  it('minMaxRatio known value: [2,4,8] = 0.25', () => {
    expect(minMaxRatio([2, 4, 8])).toBeCloseTo(0.25, 9);
  });
  it('minMaxRatio is 1 for equal vectors and guards zero/empty', () => {
    expect(minMaxRatio([5, 5, 5])).toBe(1);
    expect(minMaxRatio([0, 0, 0])).toBe(1);
    expect(minMaxRatio([])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// simulateAB — determinism + donna beats nearest on equity
// ---------------------------------------------------------------------------

function equityFixture(): Recipient[] {
  const dry: Infrastructure[] = ['dry_storage'];
  // 3 centrally-located, already over-served pantries near the pickup cloud's center.
  const central: Recipient[] = [
    makeRecipient({ id: 'c1', name: 'Central A', lat: 37.758, lng: -122.446, infrastructure: dry, typicalWeeklyVolumeLbs: 6000, receivedRecentLbs: 3500 }),
    makeRecipient({ id: 'c2', name: 'Central B', lat: 37.752, lng: -122.442, infrastructure: dry, typicalWeeklyVolumeLbs: 6000, receivedRecentLbs: 3000 }),
    makeRecipient({ id: 'c3', name: 'Central C', lat: 37.756, lng: -122.448, infrastructure: dry, typicalWeeklyVolumeLbs: 6000, receivedRecentLbs: 4000 }),
  ];
  // 6 peripheral, under-served agencies spread to the edges of the box.
  const peripheral: Recipient[] = [
    makeRecipient({ id: 'p1', name: 'Edge NW', lat: 37.805, lng: -122.505, infrastructure: dry, typicalWeeklyVolumeLbs: 900, receivedRecentLbs: 0 }),
    makeRecipient({ id: 'p2', name: 'Edge NE', lat: 37.805, lng: -122.385, infrastructure: dry, typicalWeeklyVolumeLbs: 900, receivedRecentLbs: 50 }),
    makeRecipient({ id: 'p3', name: 'Edge SW', lat: 37.705, lng: -122.505, infrastructure: dry, typicalWeeklyVolumeLbs: 900, receivedRecentLbs: 0 }),
    makeRecipient({ id: 'p4', name: 'Edge SE', lat: 37.705, lng: -122.385, infrastructure: dry, typicalWeeklyVolumeLbs: 900, receivedRecentLbs: 100 }),
    makeRecipient({ id: 'p5', name: 'Edge N', lat: 37.808, lng: -122.445, infrastructure: dry, typicalWeeklyVolumeLbs: 900, receivedRecentLbs: 0 }),
    makeRecipient({ id: 'p6', name: 'Edge S', lat: 37.702, lng: -122.445, infrastructure: dry, typicalWeeklyVolumeLbs: 900, receivedRecentLbs: 25 }),
  ];
  return [...central, ...peripheral];
}

describe('simulateAB', () => {
  it('is fully deterministic: same seed twice ⇒ deep-equal', () => {
    const recips = equityFixture();
    const a = simulateAB(recips, 30, 42);
    const b = simulateAB(recips, 30, 42);
    expect(a).toEqual(b);
  });

  it('does not mutate the caller-supplied recipients', () => {
    const recips = equityFixture();
    const before = recips.map((r) => r.receivedRecentLbs);
    simulateAB(recips, 30, 42);
    expect(recips.map((r) => r.receivedRecentLbs)).toEqual(before);
  });

  it('different seeds generally produce different drop sequences', () => {
    const recips = equityFixture();
    const a = simulateAB(recips, 30, 42);
    const b = simulateAB(recips, 30, 7);
    expect(a.series).not.toEqual(b.series);
  });

  it("Donna's final gini is lower than nearest-only (more equitable)", () => {
    const res = simulateAB(equityFixture(), 30, 42);
    expect(res.donna.gini).toBeLessThan(res.nearest.gini);
  });

  it("Donna's min/max ratio is higher (closer to equal) than nearest", () => {
    const res = simulateAB(equityFixture(), 30, 42);
    expect(res.donna.minMaxRatio).toBeGreaterThan(res.nearest.minMaxRatio);
  });

  it('reports one series point per drop and correct drop count', () => {
    const res = simulateAB(equityFixture(), 25, 42);
    expect(res.drops).toBe(25);
    expect(res.series).toHaveLength(25);
    expect(res.series[24].drop).toBe(25);
  });

  it('property holds across several seeds', () => {
    for (const seed of [1, 42, 123, 2024, 99999]) {
      const res = simulateAB(equityFixture(), 30, seed);
      expect(res.donna.gini).toBeLessThanOrEqual(res.nearest.gini);
    }
  });
});

// ---------------------------------------------------------------------------
// explain.ts
// ---------------------------------------------------------------------------

describe('explainRanking', () => {
  function twoRanked(): RankedRecipient[] {
    const item = makeItem({ needsRefrigeration: true, hoursToSpoil: 48, qtyLbs: 600 });
    const recipients: Recipient[] = [
      makeRecipient({ id: 'walkin', name: 'Walk-In Pantry', lat: 37.7455, lng: -122.3934, infrastructure: ['walk_in_fridge'], accepts: ['fresh_produce'], typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0 }),
      makeRecipient({ id: 'fridge', name: 'Fridge Pantry', lat: 37.75, lng: -122.40, infrastructure: ['fridge'], typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 4000 }),
    ];
    return rankRecipients(item, makeDonation(), recipients, CONFIG, []);
  }

  it('template fallback (no LLM) references the winning recipient and a percentage', async () => {
    const ranked = twoRanked();
    const out = await explainRanking(makeItem(), ranked);
    expect(out).toContain(ranked[0].recipient.name);
    expect(out).toMatch(/\d+%/);
    // two sentences
    expect(out.trim().split('.').filter((s) => s.trim().length > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('uses an injected LlmClient when provided', async () => {
    const fake: LlmClient = {
      complete: async () => 'Sentence one about the winner. Sentence two about the runner-up.',
    };
    const out = await explainRanking(makeItem(), twoRanked(), fake);
    expect(out).toBe('Sentence one about the winner. Sentence two about the runner-up.');
  });

  it('falls back to the template when the LlmClient throws (never propagates)', async () => {
    const boom: LlmClient = { complete: async () => { throw new Error('network down'); } };
    const ranked = twoRanked();
    const out = await explainRanking(makeItem(), ranked, boom);
    expect(out).toContain(ranked[0].recipient.name);
  });

  it('falls back to the template when the LlmClient returns empty text', async () => {
    const empty: LlmClient = { complete: async () => '   ' };
    const ranked = twoRanked();
    const out = await explainRanking(makeItem(), ranked, empty);
    expect(out).toContain(ranked[0].recipient.name);
  });
});
