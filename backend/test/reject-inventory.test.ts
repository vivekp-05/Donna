import { describe, it, expect, afterEach } from 'vitest';
import type {
  Donation, DonationItem, Recipient, HistoryEvent, AgentConfig, CallAttempt,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider } from '../src/core/voice/caller.js';
import { createServer } from '../src/server.js';
import { ENV } from '../src/config.js';
import { makeCallStoreParts } from './support/callStore.js';

// §M.1 reject-at-the-gate (donor call-back) + §M.2 the inventory projection.
// Same shape as hold.test.ts: the REAL pipeline against an in-memory store, with
// a stub LLM (composeDonorMessage degrades to its template) so no env is needed.

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

function donation(id: string, items: DonationItem[], over: Partial<Donation> = {}): Donation {
  return {
    id, sourceChannel: 'voice', sourceContact: '+14155550142',
    receivedAt: new Date().toISOString(), rawText: 'raw', status: 'awaiting_triage',
    donorName: 'Marcus', items, ...over,
  };
}

function makeStore(seedDonations: Donation[], recipients: Recipient[]) {
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

/** A provider with no donor-call support — the simulator's shape. */
function simVoice(): VoiceProvider {
  return {
    async startCall(): Promise<string> { return 'sim_1'; },
    async synthesizeReport(): Promise<Pick<CallAttempt, 'outcome' | 'reason' | 'transcript'>> {
      return { outcome: 'accepted', transcript: [{ speaker: 'agent', text: 'hi' }] };
    },
  };
}

/** A provider that CAN ring the donor, recording what it was asked to say. */
function donorVoice(opts: { fail?: boolean } = {}) {
  const calls: Array<{ donation: Donation; script: string }> = [];
  const voice: VoiceProvider = {
    async startCall(): Promise<string> { return 'call_1'; },
    async startDonorCall(d, script): Promise<string> {
      calls.push({ donation: d, script });
      if (opts.fail) throw new Error('VAPI donor call failed: 500');
      return 'donorcall_1';
    },
  };
  return { voice, calls };
}

describe('POST /api/donations/:id/reject — decline at the gate', () => {
  const saved = { ...ENV };
  afterEach(() => { Object.assign(ENV, saved); });

  it('rings the donor and rests at dispatching until the call ends', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const { voice, calls } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    const res = await app.request('/api/donations/d1/reject', { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { calling: boolean; status: string };
    expect(body.calling).toBe(true);

    // One call, to the donor, with the rejection script.
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toMatch(/not able to take it this time/i);

    const d = h.donations.get('d1')!;
    expect(d.rejected).toBe(true);
    expect(d.items[0].status).toBe('unplaceable');
    expect(d.items[0].resolutionReason).toMatch(/coordinator/i);
    // NOT resolved yet — the donor is still on the phone. This is what holds the
    // dashboard's rail on "Outbound call" for the real duration of the call.
    expect(d.status).toBe('dispatching');
    expect(d.rejectCallId).toBe('donorcall_1');
  });

  it('names the food bank rather than saying "the food bank"', async () => {
    // #7 made FOOD_BANK_NAME a bare proper noun so Donna identifies herself by
    // name on every line she speaks. This is the first thing a rejected donor
    // hears, and it said "calling from the food bank" flat until that landed.
    Object.assign(ENV, { foodBankName: 'San Marin Food Bank' });
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const { voice, calls } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });

    expect(calls[0].script).toMatch(/calling from San Marin Food Bank/);
    expect(calls[0].script).not.toMatch(/from the food bank/);
    // No article before the name — that is what the bare-proper-noun rule buys.
    expect(calls[0].script).not.toMatch(/the San Marin Food Bank/);
  });

  it('never offers the donation to a pantry', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    let pantryCalls = 0;
    const voice: VoiceProvider = {
      async startCall(): Promise<string> { pantryCalls++; return 'call_1'; },
      async startDonorCall(): Promise<string> { return 'donorcall_1'; },
    };
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });
    expect(pantryCalls).toBe(0);
    expect(h.donations.get('d1')!.items[0].attempts).toHaveLength(0);
  });

  it('leaves held items alone — only pending items are declined', async () => {
    const held: DonationItem = { ...item('i1', 'd1', 'bread'), status: 'held' };
    const h = makeStore([donation('d1', [held, item('i2', 'd1')])], [recipient('r1', 'A')]);
    const { voice, calls } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });

    const d = h.donations.get('d1')!;
    expect(d.items.find((i) => i.id === 'i1')!.status).toBe('held');       // still on the shelf
    expect(d.items.find((i) => i.id === 'i2')!.status).toBe('unplaceable');
    // The script must not tell the donor we can't take food we just shelved.
    expect(calls[0].script).not.toMatch(/bread/i);
    expect(calls[0].script).toMatch(/strawberries/i);
  });

  it('resolves immediately when the provider cannot ring the donor (simulator)', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: simVoice() });

    const res = await app.request('/api/donations/d1/reject', { method: 'POST' });
    expect(res.status).toBe(202);
    expect((await res.json() as { calling: boolean }).calling).toBe(false);

    const d = h.donations.get('d1')!;
    expect(d.status).toBe('resolved');
    expect(d.rejected).toBe(true);
    expect(d.rejectCallId).toBeUndefined();
  });

  it('still rejects when the donor call fails to place', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const { voice } = donorVoice({ fail: true });
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    const res = await app.request('/api/donations/d1/reject', { method: 'POST' });
    expect(res.status).toBe(202);

    // The coordinator's decision does not depend on the donor picking up: a
    // donation that bounced back to the gate would be re-decided by the next person.
    const d = h.donations.get('d1')!;
    expect(d.rejected).toBe(true);
    expect(d.status).toBe('resolved');
    expect(d.rejectCallId).toBeUndefined();
  });

  it('404 unknown donation; 409 once dispatching or resolved', async () => {
    const h = makeStore(
      [
        donation('d1', [item('i1', 'd1')], { status: 'dispatching' }),
        donation('d2', [item('i2', 'd2')], { status: 'resolved' }),
      ],
      [recipient('r1', 'A')],
    );
    const { voice } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    expect((await app.request('/api/donations/ghost/reject', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/donations/d1/reject', { method: 'POST' })).status).toBe(409);
    expect((await app.request('/api/donations/d2/reject', { method: 'POST' })).status).toBe(409);
  });
});

/**
 * The other half of §M.1: the donor hangs up and the donation resolves.
 *
 * A donor rejection call matches no CallRecord — there is no shortlist to
 * advance — so it reaches the webhook's unmatched path, which used to fall
 * straight through to the inbound-call branch. These pin the two things that
 * must be true there: the report resolves the donation, and it is never mistaken
 * for a donor ringing US (which would ingest the rejection call as a NEW offer).
 */
describe('vapi webhook — donor rejection call ending (§M.1)', () => {
  const saved = { ...ENV };
  afterEach(() => { Object.assign(ENV, saved); });

  const report = (callId: string, type = 'outboundPhoneCall') => ({
    message: {
      type: 'end-of-call-report',
      endedReason: 'hangup',
      call: { id: callId, type, customer: { number: '+14155550142' } },
      artifact: { messages: [{ role: 'assistant', message: 'We cannot take it this time.' }] },
    },
  });

  const post = (app: ReturnType<typeof createServer>, body: unknown) =>
    app.request('/api/vapi/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('resolves the donation the call belonged to', async () => {
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const { voice } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });
    expect(h.donations.get('d1')!.status).toBe('dispatching');

    const res = await post(app, report('donorcall_1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rejected: true });

    const d = h.donations.get('d1')!;
    expect(d.status).toBe('resolved');
    expect(d.rejectCallId).toBeUndefined();
  });

  it('a duplicate report is a no-op', async () => {
    // VAPI provably sends more than one end-of-call-report per call.
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const { voice } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });
    await post(app, report('donorcall_1'));
    const second = await post(app, report('donorcall_1'));

    expect(second.status).toBe(200);
    expect(h.donations.get('d1')!.status).toBe('resolved');
    // The donation count must not grow: a second report must not be re-read as
    // an inbound offer, and must not un-resolve anything.
    expect(h.donations.size).toBe(1);
  });

  it('does not ingest the rejection call as a new inbound donation', async () => {
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const { voice } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });
    await post(app, report('donorcall_1'));

    // One donation, still — Donna telling a donor "no" is not a donor offering food.
    expect(h.donations.size).toBe(1);
    expect(h.donations.get('d1')!.rejected).toBe(true);
  });

  it('leaves a report for some other call alone', async () => {
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const { voice } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });
    const res = await post(app, report('someone_elses_call'));

    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ rejected: true });
    expect(h.donations.get('d1')!.status).toBe('dispatching');   // still on the phone
  });
});

describe('GET /api/inventory — the food bank shelf (§M.2)', () => {
  it('empty when nothing is held', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: simVoice() });

    const res = await app.request('/api/inventory');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; totalLbs: number };
    expect(body.items).toEqual([]);
    expect(body.totalLbs).toBe(0);
  });

  it('lists held items across donations with their totals, and nothing else', async () => {
    const a = item('i1', 'd1', 'strawberries');
    const b = item('i2', 'd1', 'bread');
    const c = item('i3', 'd2', 'milk');
    const h = makeStore(
      [donation('d1', [a, b]), donation('d2', [c], { donorName: 'Rosa' })],
      [recipient('r1', 'A')],
    );
    const app = createServer({ store: h.store, llm: stubLlm, voice: simVoice() });

    // Hold two of the three through the real endpoint.
    await app.request('/api/items/i1/hold', { method: 'POST' });
    await app.request('/api/items/i3/hold', { method: 'POST' });

    const body = (await (await app.request('/api/inventory')).json()) as {
      items: Array<{ itemId: string; item: string; qtyLbs: number; donorName?: string }>;
      totalLbs: number;
    };

    expect(body.items.map((i) => i.itemId).sort()).toEqual(['i1', 'i3']);
    expect(body.totalLbs).toBe(1000);
    // The pending item is not inventory — it is still an open offer.
    expect(body.items.some((i) => i.itemId === 'i2')).toBe(false);
    expect(body.items.find((i) => i.itemId === 'i3')!.donorName).toBe('Rosa');
  });

  it('picks up an item held via the reject path leaving the rest declined', async () => {
    const held: DonationItem = { ...item('i1', 'd1', 'bread'), status: 'held' };
    const h = makeStore([donation('d1', [held, item('i2', 'd1')])], [recipient('r1', 'A')]);
    const { voice } = donorVoice();
    const app = createServer({ store: h.store, llm: stubLlm, voice });

    await app.request('/api/donations/d1/reject', { method: 'POST' });

    const body = (await (await app.request('/api/inventory')).json()) as {
      items: Array<{ itemId: string }>;
    };
    // Rejecting the offer must not empty the shelf.
    expect(body.items.map((i) => i.itemId)).toEqual(['i1']);
  });
});
