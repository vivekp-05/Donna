import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/core/memory/jsonStore.js';
import { makeSeedRecipients } from '../src/seed/recipients.js';
import { DEFAULT_AGENT_CONFIG } from '../src/config.js';
import type { Donation, HistoryEvent } from '../src/core/types.js';

let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `donna-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});

afterEach(async () => {
  await fs.rm(dbPath, { force: true });
});

function freshStore(): JsonStore {
  return new JsonStore(dbPath);
}

describe('JsonStore — seed on empty', () => {
  it('seeds the 15 recipients when the file is absent', async () => {
    const store = freshStore();
    await store.init();
    const recipients = await store.listRecipients();
    expect(recipients).toHaveLength(15);
    // 10 pantries + 5 community agencies (§11).
    expect(recipients.filter((r) => r.type === 'pantry')).toHaveLength(10);
    expect(recipients.filter((r) => r.type === 'community_agency')).toHaveLength(5);
  });

  it('seeds the recent baked-decline history so bread is unplaceable', async () => {
    const store = freshStore();
    await store.init();
    const history = await store.listHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
    const bakedDeclines = history.filter(
      (e) => e.outcome === 'declined' && (e.reason ?? '').toLowerCase().includes('baked'),
    );
    expect(bakedDeclines).toHaveLength(2);
    // Both must sit inside the 7-day window used by the prefs/simulator memory.
    const now = Date.now();
    for (const e of bakedDeclines) {
      const at = Date.parse(e.at);
      expect(now - at).toBeGreaterThan(0);
      expect(now - at).toBeLessThan(7 * 24 * 60 * 60 * 1000);
    }
  });

  it('persists seeds to disk and a second store reads them back', async () => {
    const a = freshStore();
    await a.init();
    await a.flushNow();
    const raw = await fs.readFile(dbPath, 'utf8');
    expect(raw.length).toBeGreaterThan(0);

    const b = freshStore();
    await b.init();
    const recipients = await b.listRecipients();
    expect(recipients).toHaveLength(15);
  });

  it('does not reseed when the file already holds recipients', async () => {
    const a = freshStore();
    await a.init();
    await a.updateRecipient('rec-bayview-hub', { receivedRecentLbs: 9999 });
    await a.flushNow();

    const b = freshStore();
    await b.init();
    const bayview = await b.getRecipient('rec-bayview-hub');
    expect(bayview?.receivedRecentLbs).toBe(9999);
  });
});

describe('JsonStore — §11 composition constraints', () => {
  it('has the required infrastructure mix and volume range', async () => {
    const seeds = makeSeedRecipients();
    const count = (fn: (r: (typeof seeds)[number]) => boolean) => seeds.filter(fn).length;

    const walkIn = count((r) => r.infrastructure.includes('walk_in_fridge'));
    const freezer = count((r) => r.infrastructure.includes('freezer'));
    const fridgeOnly = count(
      (r) =>
        r.infrastructure.includes('fridge') &&
        !r.infrastructure.includes('walk_in_fridge') &&
        !r.infrastructure.includes('freezer'),
    );
    const dryOnly = count(
      (r) => !r.infrastructure.some((i) => i === 'walk_in_fridge' || i === 'fridge' || i === 'freezer'),
    );
    expect(walkIn).toBe(4);
    expect(freezer).toBe(3);
    expect(fridgeOnly).toBe(4);
    expect(dryOnly).toBe(4);

    const vols = seeds.map((r) => r.typicalWeeklyVolumeLbs);
    expect(Math.min(...vols)).toBe(300);
    expect(Math.max(...vols)).toBe(8000);
  });

  it('carries the named personality recipients', async () => {
    const seeds = makeSeedRecipients();
    const byName = (n: string) => seeds.find((r) => r.name === n);

    const stMarys = byName("St. Mary's Center");
    expect(stMarys).toBeDefined();
    // Starts WITHOUT a freezer — the manager demo adds it later.
    expect(stMarys?.infrastructure).not.toContain('freezer');

    const oak = byName('Oak Avenue Pantry');
    expect(oak?.accepts).toEqual(expect.arrayContaining(['canned', 'dry_goods']));
    // Canned/dry only — takes nothing perishable.
    expect(oak?.accepts).not.toEqual(expect.arrayContaining(['fresh_produce']));

    expect(byName('Mission Greens Collective')?.accepts).toEqual(
      expect.arrayContaining(['fresh_produce']),
    );

    const skew = seeds.map((r) => r.receivedRecentLbs);
    expect(Math.min(...skew)).toBeLessThan(150); // some near zero
    expect(Math.max(...skew)).toBeGreaterThanOrEqual(3000); // some corridor pantries high
  });
});

describe('JsonStore — reset', () => {
  it('restores seeds after mutations', async () => {
    const store = freshStore();
    await store.init();

    await store.updateRecipient('rec-bayview-hub', { receivedRecentLbs: 5000 });
    await store.saveDonation(makeDonation('d1'));
    await store.addHistory(makeHistory('h-extra', 'rec-bayview-hub'));

    await store.reset();

    const bayview = await store.getRecipient('rec-bayview-hub');
    expect(bayview?.receivedRecentLbs).toBe(250); // back to seed value
    expect(await store.listDonations()).toHaveLength(0);
    // Only the 2 seeded history events remain (the extra one is gone).
    const history = await store.listHistory();
    expect(history.find((e) => e.id === 'h-extra')).toBeUndefined();
    expect(history).toHaveLength(2);
  });
});

describe('JsonStore — creditReceived', () => {
  it('increments the rolling ledger', async () => {
    const store = freshStore();
    await store.init();
    const before = (await store.getRecipient('rec-hunters-point'))!.receivedRecentLbs;
    await store.creditReceived('rec-hunters-point', 200);
    const after = (await store.getRecipient('rec-hunters-point'))!.receivedRecentLbs;
    expect(after).toBe(before + 200);
  });

  it('throws for an unknown recipient', async () => {
    const store = freshStore();
    await store.init();
    await expect(store.creditReceived('nope', 10)).rejects.toThrow();
  });
});

describe('JsonStore — history filtering', () => {
  it('filters by recipientId and returns all when unfiltered', async () => {
    const store = freshStore();
    await store.init();
    await store.addHistory(makeHistory('h1', 'rec-oak-avenue'));
    await store.addHistory(makeHistory('h2', 'rec-oak-avenue'));
    await store.addHistory(makeHistory('h3', 'rec-chinatown'));

    const oak = await store.listHistory('rec-oak-avenue');
    expect(oak).toHaveLength(2);
    expect(oak.every((e) => e.recipientId === 'rec-oak-avenue')).toBe(true);

    const all = await store.listHistory();
    // 2 seeded + 3 added.
    expect(all).toHaveLength(5);
  });
});

describe('JsonStore — config get/set', () => {
  it('returns the default config initially', async () => {
    const store = freshStore();
    await store.init();
    const cfg = await store.getConfig();
    expect(cfg).toEqual(DEFAULT_AGENT_CONFIG);
  });

  it('shallow-merges weight patches and scalar fields', async () => {
    const store = freshStore();
    await store.init();
    const updated = await store.setConfig({
      autopilot: true,
      weights: { ...DEFAULT_AGENT_CONFIG.weights, equity: 0.5 },
    });
    expect(updated.autopilot).toBe(true);
    expect(updated.weights.equity).toBe(0.5);
    // Untouched terms survive.
    expect(updated.weights.feasibility).toBe(DEFAULT_AGENT_CONFIG.weights.feasibility);
    expect((await store.getConfig()).avgSpeedMph).toBe(DEFAULT_AGENT_CONFIG.avgSpeedMph);
  });

  it('persists config across store instances', async () => {
    const a = freshStore();
    await a.init();
    await a.setConfig({ avgSpeedMph: 45 });
    await a.flushNow();

    const b = freshStore();
    await b.init();
    expect((await b.getConfig()).avgSpeedMph).toBe(45);
  });
});

// ---- helpers ---------------------------------------------------------------

function makeDonation(id: string): Donation {
  return {
    id,
    sourceChannel: 'voice',
    sourceContact: '+14155550100',
    receivedAt: new Date().toISOString(),
    rawText: 'test donation',
    status: 'received',
    items: [],
  };
}

function makeHistory(id: string, recipientId: string): HistoryEvent {
  return {
    id,
    recipientId,
    itemId: 'item-x',
    outcome: 'declined',
    reason: 'overstocked',
    at: new Date().toISOString(),
  };
}
