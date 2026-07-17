import { describe, it, expect } from 'vitest';
import type {
  Donation, DonationItem, Recipient, HistoryEvent, AgentConfig, OfferDraft, CallAttempt,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider } from '../src/core/voice/caller.js';
import type { Geocoder } from '../src/core/geo.js';
import { createServer } from '../src/server.js';
import { ingestDonation, type PipelineDeps } from '../src/core/pipeline.js';
import { makeCallStoreParts } from './support/callStore.js';

// §K.1 inventory hold + §K.2 exact-location geocoding. These run the REAL
// pipeline (draftOffer + composeDonorMessage degrade to deterministic templates
// with a stub LLM, so zero env vars are needed) against an in-memory store.

const CONFIG: AgentConfig = {
  weights: { feasibility: 0.3, coldchain: 0.15, capacity: 0.2, equity: 0.2, prefs: 0.15 },
  autopilot: true,
  avgSpeedMph: 30,
};

function recipient(id: string, name: string): Recipient {
  return {
    id, name, type: 'pantry', leadContact: `Lead ${name}`, phone: '+14155550100',
    lat: 37.77, lng: -122.41, infrastructure: ['fridge'],
    accepts: ['fresh_produce', 'baked'], rejects: [],
    typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0,
  };
}

function item(id: string, donationId: string, name = 'strawberries'): DonationItem {
  return {
    id, donationId, item: name, qtyLbs: 500, category: 'fresh_produce',
    hoursToSpoil: 48, needsRefrigeration: true, status: 'pending', attempts: [],
  };
}

function donation(id: string, items: DonationItem[]): Donation {
  return {
    id, sourceChannel: 'voice', sourceContact: '+14155550142',
    receivedAt: new Date().toISOString(), rawText: 'raw', status: 'scored',
    donorName: 'Marcus', items,
  };
}

interface Harness {
  store: MemoryStore;
  donations: Map<string, Donation>;
}

function makeStore(seedDonations: Donation[], recipients: Recipient[]): Harness {
  const donations = new Map<string, Donation>();
  for (const d of seedDonations) donations.set(d.id, d);
  const history: HistoryEvent[] = [];
  const store: MemoryStore = {
    ...makeCallStoreParts(),
    async init() {},
    async saveDonation(d) { donations.set(d.id, d); },
    async getDonation(id) { return donations.get(id) ?? null; },
    async listDonations() { return [...donations.values()]; },
    async listRecipients() { return recipients; },
    async getRecipient(id) { return recipients.find((r) => r.id === id) ?? null; },
    async updateRecipient(id, patch) {
      const r = recipients.find((x) => x.id === id)!;
      Object.assign(r, patch);
      return r;
    },
    async addHistory(e) { history.push(e); },
    async listHistory(rid) { return rid ? history.filter((h) => h.recipientId === rid) : history; },
    async creditReceived() {},
    async getConfig() { return CONFIG; },
    async setConfig() { return CONFIG; },
    async reset() {},
  };
  return { store, donations };
}

const stubLlm: LlmClient = { async complete() { return ''; } };

function voiceReturning(outcome: CallAttempt['outcome']): VoiceProvider {
  let n = 0;
  return {
    async startCall(): Promise<string> { return `sim_${++n}`; },
    async synthesizeReport(): Promise<Pick<CallAttempt, 'outcome' | 'reason' | 'transcript'>> {
      return { outcome, transcript: [{ speaker: 'agent', text: 'hi' }] };
    },
  };
}

describe('POST /api/items/:id/hold — take an item into inventory', () => {
  it('pending item ⇒ 200 {item} with status held, persisted', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const res = await app.request('/api/items/i1/hold', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: DonationItem };
    expect(body.item.status).toBe('held');
    expect(h.donations.get('d1')?.items[0].status).toBe('held');
  });

  it('404 for an unknown item', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });
    const res = await app.request('/api/items/ghost/hold', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409 when the item is not pending', async () => {
    const matched = { ...item('i1', 'd1'), status: 'matched' as const };
    const h = makeStore([donation('d1', [matched])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });
    const res = await app.request('/api/items/i1/hold', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('a held item is skipped by dispatch and does not block resolution; callback mentions it', async () => {
    const a = item('i1', 'd1', 'strawberries');
    const b = item('i2', 'd1', 'bread');
    b.category = 'baked';
    b.needsRefrigeration = false;
    const h = makeStore([donation('d1', [a, b])], [recipient('r1', 'Mission Pantry')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    // Hold the bread; dispatch the donation. Only the pending item is called.
    const held = await app.request('/api/items/i2/hold', { method: 'POST' });
    expect(held.status).toBe(200);

    const disp = await app.request('/api/donations/d1/dispatch', { method: 'POST' });
    expect(disp.status).toBe(200);

    const d = h.donations.get('d1')!;
    expect(d.status).toBe('resolved');                 // held item did not strand it
    expect(d.items.find((i) => i.id === 'i1')?.status).toBe('matched');
    expect(d.items.find((i) => i.id === 'i2')?.status).toBe('held'); // still held
    expect(d.donorMessage).toContain('into our inventory at the food bank');
    expect(d.donorMessage).toContain('bread');
  });
});

describe('directed call on a held item (send it out later)', () => {
  it('accepted ⇒ held item becomes matched', async () => {
    const held = { ...item('i1', 'd1'), status: 'held' as const };
    const h = makeStore([donation('d1', [held])], [recipient('r1', 'Bayview Pantry')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const res = await app.request('/api/items/i1/call/r1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: DonationItem };
    expect(body.item.status).toBe('matched');
    expect(body.item.matchedRecipientId).toBe('r1');
  });

  it('declined ⇒ held item stays held', async () => {
    const held = { ...item('i1', 'd1'), status: 'held' as const };
    const h = makeStore([donation('d1', [held])], [recipient('r1', 'Harbor Pantry')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('declined') });

    const res = await app.request('/api/items/i1/call/r1', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(h.donations.get('d1')?.items[0].status).toBe('held');
  });
});

describe('§K.2 — geocoding a spoken pickup address', () => {
  const rawText = 'Hi, this is Sam from Acme Bakery. We have 100 lbs of bread at 500 Main Street.';

  function ingestDeps(store: MemoryStore, geocode?: Geocoder): PipelineDeps {
    const voice: VoiceProvider = { async startCall() { return 'x'; }, async synthesizeReport() { return { outcome: 'accepted', transcript: [] }; } };
    return { store, llm: stubLlm, voice, config: CONFIG, ...(geocode ? { geocode } : {}) };
  }

  it('parsed location without coords ⇒ geocoder fills them in', async () => {
    const h = makeStore([], []);
    const seen: string[] = [];
    const geocode: Geocoder = async (loc) => { seen.push(loc); return { lat: 37.8, lng: -122.41 }; };
    const d = await ingestDonation({ channel: 'voice', contact: 'x', rawText }, ingestDeps(h.store, geocode));
    expect(seen[0]).toContain('Main St');
    expect(d.pickupLat).toBe(37.8);
    expect(d.pickupLng).toBe(-122.41);
  });

  it('geocoder miss (null) ⇒ coords stay absent', async () => {
    const h = makeStore([], []);
    const geocode: Geocoder = async () => null;
    const d = await ingestDonation({ channel: 'voice', contact: 'x', rawText }, ingestDeps(h.store, geocode));
    expect(d.pickupLat).toBeUndefined();
    expect(d.pickupLng).toBeUndefined();
  });

  it('no geocoder wired ⇒ never called, coords stay absent (offline default)', async () => {
    const h = makeStore([], []);
    const d = await ingestDonation({ channel: 'voice', contact: 'x', rawText }, ingestDeps(h.store));
    expect(d.pickupLocation).toBeTruthy();
    expect(d.pickupLat).toBeUndefined();
  });
});
