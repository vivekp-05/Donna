import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Donation, DonationItem, Recipient, HistoryEvent, AgentConfig, CallAttempt,
  OfferDraft, CallOutcome,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider, DispatchDeps } from '../src/core/voice/caller.js';

// ---- Mock the two collaborators dispatchItem statically imports. ----
// rankRecipients: rank in array order; a recipient tagged __hardFail bubbles to
// total 0 with a hardFail set (exactly how the real engine surfaces hard gates).
vi.mock('../src/core/scoring/engine.js', () => ({
  rankRecipients: (_item: DonationItem, _donation: Donation, recipients: Recipient[]) =>
    recipients.map((r, idx) => {
      const hardFail = (r as Recipient & { __hardFail?: ScoreBreakdownHardFail }).__hardFail;
      return {
        recipient: r,
        score: {
          recipientId: r.id,
          feasibility: 1, coldchain: 1, capacity: 1, equity: 1, prefs: 1,
          total: hardFail ? 0 : 1 - idx * 0.1,
          hardFail,
          driveTimeHours: 0.2, distanceMiles: 6,
        },
      };
    }),
  scoreItem: vi.fn(),
}));

vi.mock('../src/core/agents/offer.js', () => ({
  draftOffer: async (item: DonationItem, _d: Donation, recipient: Recipient): Promise<OfferDraft> => ({
    itemId: item.id,
    recipientId: recipient.id,
    script: `Offer ${item.item} to ${recipient.name}`,
    summary: 'summary',
  }),
}));

// Import AFTER the mocks are declared (vi.mock is hoisted regardless).
import { dispatchItem } from '../src/core/voice/caller.js';

type ScoreBreakdownHardFail = 'infeasible_time' | 'no_cold_chain' | 'category_rejected';

// ---- Test fixtures ----
function recipient(id: string, over: Partial<Recipient> = {}): Recipient {
  return {
    id,
    name: `Recipient ${id}`,
    type: 'pantry',
    leadContact: 'Lead',
    phone: `+1415555${id.padStart(4, '0')}`,
    lat: 37.76,
    lng: -122.42,
    infrastructure: ['fridge'],
    accepts: ['fresh_produce'],
    rejects: [],
    typicalWeeklyVolumeLbs: 4000,
    receivedRecentLbs: 100,
    ...over,
  };
}

function makeItem(): DonationItem {
  return {
    id: 'i1',
    donationId: 'd1',
    item: 'strawberries',
    qtyLbs: 500,
    category: 'fresh_produce',
    hoursToSpoil: 48,
    needsRefrigeration: true,
    status: 'pending',
    attempts: [],
  };
}

function makeDonation(): Donation {
  return {
    id: 'd1',
    sourceChannel: 'voice',
    sourceContact: 'Marcus',
    receivedAt: new Date().toISOString(),
    rawText: 'strawberries',
    status: 'scored',
    pickupLat: 37.74,
    pickupLng: -122.39,
    items: [],
  };
}

const config: AgentConfig = {
  weights: { feasibility: 0.3, coldchain: 0.15, capacity: 0.2, equity: 0.2, prefs: 0.15 },
  autopilot: true,
  avgSpeedMph: 30,
};

// ---- Fake MemoryStore ----
function fakeStore(recipients: Recipient[]): MemoryStore & {
  history: HistoryEvent[];
  credits: Record<string, number>;
} {
  const history: HistoryEvent[] = [];
  const credits: Record<string, number> = {};
  return {
    history,
    credits,
    async init() {},
    async saveDonation() {},
    async getDonation() { return null; },
    async listDonations() { return []; },
    async listRecipients() { return recipients; },
    async getRecipient(id) { return recipients.find((r) => r.id === id) ?? null; },
    async updateRecipient(id, patch) {
      const r = recipients.find((x) => x.id === id)!;
      Object.assign(r, patch);
      return r;
    },
    async addHistory(e) { history.push(e); },
    async listHistory(recipientId) {
      return recipientId ? history.filter((h) => h.recipientId === recipientId) : history.slice();
    },
    async creditReceived(recipientId, lbs) {
      credits[recipientId] = (credits[recipientId] ?? 0) + lbs;
    },
    async getConfig() { return config; },
    async setConfig() { return config; },
    async reset() {},
  };
}

// ---- Fake voice that returns a scripted outcome per recipient id ----
function fakeVoice(outcomes: Record<string, CallOutcome>): VoiceProvider & {
  calls: string[];
  historySeen: HistoryEvent[][];
} {
  const calls: string[] = [];
  const historySeen: HistoryEvent[][] = [];
  return {
    calls,
    historySeen,
    setHistory(h) { historySeen.push(h); },
    async placeCall(_offer, recipient, _item): Promise<CallAttempt> {
      calls.push(recipient.id);
      const outcome = outcomes[recipient.id] ?? 'declined';
      return {
        recipientId: recipient.id,
        recipientName: recipient.name,
        outcome,
        reason: outcome === 'declined' ? 'we are full' : undefined,
        transcript: [{ speaker: 'agent', text: 'hi' }],
        at: new Date().toISOString(),
        simulated: true,
      };
    },
  };
}

const llm: LlmClient = { async complete() { return ''; } };

function deps(store: MemoryStore, voice: VoiceProvider): DispatchDeps {
  return { store, llm, voice, config };
}

describe('dispatchItem loop (§7.1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: first declines, second accepts → matched + credited + stop', async () => {
    const recips = [recipient('1'), recipient('2'), recipient('3')];
    const store = fakeStore(recips);
    const voice = fakeVoice({ '1': 'declined', '2': 'accepted', '3': 'accepted' });

    const item = makeItem();
    const out = await dispatchItem(item, makeDonation(), store, config, deps(store, voice));

    expect(out.status).toBe('matched');
    expect(out.matchedRecipientId).toBe('2');
    expect(out.resolutionReason).toContain('Recipient 2');
    // stopped at the acceptor — third recipient never called
    expect(voice.calls).toEqual(['1', '2']);
    // credited exactly the accepted recipient with the item weight
    expect(store.credits).toEqual({ '2': 500 });
    // every attempt appended
    expect(out.attempts).toHaveLength(2);
    // history recorded for both attempts
    expect(store.history).toHaveLength(2);
    expect(store.history[0]).toMatchObject({ recipientId: '1', outcome: 'declined', reason: 'we are full' });
    expect(store.history[1]).toMatchObject({ recipientId: '2', outcome: 'accepted' });
  });

  it('all-decline path → unplaceable, no credit, all attempts recorded', async () => {
    const recips = [recipient('1'), recipient('2'), recipient('3')];
    const store = fakeStore(recips);
    const voice = fakeVoice({ '1': 'declined', '2': 'declined', '3': 'declined' });

    const item = makeItem();
    const out = await dispatchItem(item, makeDonation(), store, config, deps(store, voice));

    expect(out.status).toBe('unplaceable');
    expect(out.matchedRecipientId).toBeUndefined();
    expect(out.resolutionReason).toContain('No recipient accepted');
    expect(voice.calls).toEqual(['1', '2', '3']);
    expect(out.attempts).toHaveLength(3);
    expect(store.history).toHaveLength(3);
    expect(store.credits).toEqual({});
  });

  it('caps at 3 candidates and skips hard-failed recipients', async () => {
    const recips = [
      recipient('1', { __hardFail: 'category_rejected' } as Partial<Recipient>),
      recipient('2'),
      recipient('3'),
      recipient('4'),
      recipient('5', { __hardFail: 'no_cold_chain' } as Partial<Recipient>),
    ];
    const store = fakeStore(recips);
    const voice = fakeVoice({}); // everyone declines by default

    const out = await dispatchItem(makeItem(), makeDonation(), store, config, deps(store, voice));

    // hard-failed 1 and 5 never called; only top 3 feasible (2,3,4)
    expect(voice.calls).toEqual(['2', '3', '4']);
    expect(out.attempts).toHaveLength(3);
    expect(out.status).toBe('unplaceable');
  });

  it('no feasible recipient (all hard-failed) → unplaceable, zero calls', async () => {
    const recips = [
      recipient('1', { __hardFail: 'infeasible_time' } as Partial<Recipient>),
      recipient('2', { __hardFail: 'no_cold_chain' } as Partial<Recipient>),
    ];
    const store = fakeStore(recips);
    const voice = fakeVoice({});

    const out = await dispatchItem(makeItem(), makeDonation(), store, config, deps(store, voice));

    expect(voice.calls).toEqual([]);
    expect(out.attempts).toHaveLength(0);
    expect(out.status).toBe('unplaceable');
    expect(out.resolutionReason).toContain('No feasible recipient');
  });

  it('feeds live history to the voice provider before each call (7-day memory hook)', async () => {
    const recips = [recipient('1'), recipient('2')];
    const store = fakeStore(recips);
    const voice = fakeVoice({ '1': 'declined', '2': 'accepted' });

    await dispatchItem(makeItem(), makeDonation(), store, config, deps(store, voice));

    // setHistory called once per attempt; the 2nd call must include the 1st decline
    expect(voice.historySeen).toHaveLength(2);
    expect(voice.historySeen[0]).toHaveLength(0);
    expect(voice.historySeen[1]).toHaveLength(1);
    expect(voice.historySeen[1][0]).toMatchObject({ recipientId: '1', outcome: 'declined' });
  });
});
