import { describe, it, expect } from 'vitest';
import { SimulatorVoice } from '../src/core/voice/simulator.js';
import type {
  DonationItem, OfferDraft, Recipient, HistoryEvent,
} from '../src/core/types.js';

function recipient(over: Partial<Recipient> = {}): Recipient {
  return {
    id: 'r1',
    name: 'Mission Greens Collective',
    type: 'pantry',
    leadContact: 'Rosa',
    phone: '+14155550101',
    lat: 37.76,
    lng: -122.42,
    infrastructure: ['walk_in_fridge', 'dry_storage'],
    accepts: ['fresh_produce', 'fruit'],
    rejects: [],
    typicalWeeklyVolumeLbs: 4000,
    receivedRecentLbs: 500,
    ...over,
  };
}

function item(over: Partial<DonationItem> = {}): DonationItem {
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
    ...over,
  };
}

const offer: OfferDraft = {
  itemId: 'i1',
  recipientId: 'r1',
  script: 'Hi, this is Donna with a produce donation for you.',
  summary: 'Offer strawberries.',
};

function historyEvent(over: Partial<HistoryEvent>): HistoryEvent {
  return {
    id: 'h1',
    recipientId: 'r1',
    itemId: 'ix',
    outcome: 'declined',
    at: new Date().toISOString(),
    ...over,
  };
}

describe('SimulatorVoice persona rules (§7.2)', () => {
  it('declines when the category is in rejects', async () => {
    const sim = new SimulatorVoice();
    const rec = recipient({ rejects: ['fresh_produce'], accepts: [] });
    const a = await sim.placeCall(offer, rec, item());
    expect(a.outcome).toBe('declined');
    expect(a.reason).toBe("we don't take fresh produce");
    expect(a.simulated).toBe(true);
  });

  it('declines when quantity exceeds 1.5x weekly volume', async () => {
    const sim = new SimulatorVoice();
    const rec = recipient({ typicalWeeklyVolumeLbs: 300 });
    const a = await sim.placeCall(offer, rec, item({ qtyLbs: 500 })); // ratio 1.67
    expect(a.outcome).toBe('declined');
    expect(a.reason).toBe("that's more than we can move this week");
  });

  it('accepts when quantity is exactly 1.5x (boundary, not > 1.5)', async () => {
    const sim = new SimulatorVoice();
    const rec = recipient({ typicalWeeklyVolumeLbs: 1000 });
    const a = await sim.placeCall(offer, rec, item({ qtyLbs: 1500 })); // ratio == 1.5
    expect(a.outcome).toBe('accepted');
  });

  it('declines refrigerated item when recipient has no cold chain', async () => {
    const sim = new SimulatorVoice();
    const rec = recipient({ infrastructure: ['dry_storage'] });
    const a = await sim.placeCall(offer, rec, item({ needsRefrigeration: true }));
    expect(a.outcome).toBe('declined');
    expect(a.reason).toBe('no cold storage available');
  });

  it('accepts a non-refrigerated item even without cold chain', async () => {
    const sim = new SimulatorVoice();
    const rec = recipient({
      infrastructure: ['dry_storage'],
      accepts: ['canned'],
    });
    const a = await sim.placeCall(offer, rec, item({
      item: 'black beans',
      category: 'canned',
      needsRefrigeration: false,
      hoursToSpoil: 2160,
    }));
    expect(a.outcome).toBe('accepted');
  });

  it('declines when it declined the same category within the last 7 days', async () => {
    const recent = historyEvent({
      outcome: 'declined',
      reason: "we're still overstocked on fresh produce",
      at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const sim = new SimulatorVoice([recent]);
    const a = await sim.placeCall(offer, recipient(), item());
    expect(a.outcome).toBe('declined');
    expect(a.reason).toBe("we're still overstocked on fresh produce");
  });

  it('does NOT apply 7-day memory when the decline is older than 7 days', async () => {
    const old = historyEvent({
      outcome: 'declined',
      reason: "we're still overstocked on fresh produce",
      at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const sim = new SimulatorVoice([old]);
    const a = await sim.placeCall(offer, recipient(), item());
    expect(a.outcome).toBe('accepted');
  });

  it('does NOT apply 7-day memory for a different category', async () => {
    const recent = historyEvent({
      outcome: 'declined',
      reason: "we're still overstocked on canned",
      at: new Date().toISOString(),
    });
    const sim = new SimulatorVoice([recent]);
    const a = await sim.placeCall(offer, recipient(), item()); // fresh_produce
    expect(a.outcome).toBe('accepted');
  });

  it('accepts the happy path and references the offer script + infrastructure', async () => {
    const sim = new SimulatorVoice();
    const a = await sim.placeCall(offer, recipient(), item());
    expect(a.outcome).toBe('accepted');
    expect(a.reason).toBeUndefined();
    // 4–6 line transcript, first line is the agent's offer script.
    expect(a.transcript.length).toBeGreaterThanOrEqual(4);
    expect(a.transcript.length).toBeLessThanOrEqual(6);
    expect(a.transcript[0]).toEqual({ speaker: 'agent', text: offer.script });
    const joined = a.transcript.map((t) => t.text).join(' ');
    expect(joined).toContain('Mission Greens Collective');
  });

  it('setHistory updates the 7-day memory used by the next call', async () => {
    const sim = new SimulatorVoice();
    // first call: no memory ⇒ accept
    expect((await sim.placeCall(offer, recipient(), item())).outcome).toBe('accepted');
    sim.setHistory([
      historyEvent({
        outcome: 'declined',
        reason: "we're still overstocked on fresh produce",
        at: new Date().toISOString(),
      }),
    ]);
    expect((await sim.placeCall(offer, recipient(), item())).outcome).toBe('declined');
  });
});
