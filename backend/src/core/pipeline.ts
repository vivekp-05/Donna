import { randomUUID } from 'node:crypto';
import type {
  Channel, Donation, DonationItem, RankedRecipient, Weights, AgentConfig,
} from './types.js';
import type { MemoryStore } from './memory/store.js';
import type { LlmClient } from './agents/llm.js';
import type { VoiceProvider } from './voice/caller.js';
import { parseDonation } from './agents/intake.js';
import { composeDonorMessage } from './agents/callback.js';
import { dispatchItem } from './voice/caller.js';
import { rankRecipients } from './scoring/engine.js';

export interface PipelineDeps {
  store: MemoryStore;
  llm: LlmClient;
  voice: VoiceProvider;
  config: AgentConfig;
}

// parse (Agent 1) → build Donation with ids → store → status 'scored'
export async function ingestDonation(
  input: { channel: Channel; contact: string; rawText: string },
  deps: PipelineDeps,
): Promise<Donation> {
  const parsed = await parseDonation(input.rawText, input.channel, deps.llm);

  const donationId = randomUUID();
  const items: DonationItem[] = parsed.items.map((p) => ({
    id: randomUUID(),
    donationId,
    item: p.item,
    qtyLbs: p.qtyLbs,
    category: p.category,
    hoursToSpoil: p.hoursToSpoil,
    needsRefrigeration: p.needsRefrigeration,
    status: 'pending',
    attempts: [],
  }));

  const donation: Donation = {
    id: donationId,
    sourceChannel: input.channel,
    sourceContact: input.contact,
    receivedAt: new Date().toISOString(),
    rawText: input.rawText,
    status: 'scored',
    donorName: parsed.donorName,
    pickupLocation: parsed.pickupLocation,
    pickupLat: parsed.pickupLat,
    pickupLng: parsed.pickupLng,
    items,
  };

  await deps.store.saveDonation(donation);
  return donation;
}

// all pending items → dispatchItem → Agent 5 composeDonorMessage → donorMessage → 'resolved'
export async function dispatchDonation(
  donationId: string,
  deps: PipelineDeps,
): Promise<Donation> {
  const donation = await deps.store.getDonation(donationId);
  if (!donation) throw new Error(`donation not found: ${donationId}`);

  donation.status = 'dispatching';
  await deps.store.saveDonation(donation);

  for (let i = 0; i < donation.items.length; i++) {
    if (donation.items[i].status === 'pending') {
      donation.items[i] = await dispatchItem(
        donation.items[i], donation, deps.store, deps.config, deps,
      );
    }
  }

  donation.donorMessage = await composeDonorMessage(donation, deps.llm);
  donation.status = 'resolved';
  await deps.store.saveDonation(donation);
  return donation;
}

// stateless re-rank (slider preview) — optional weights override, does NOT persist
export async function rankItem(
  itemId: string,
  weightsOverride: Weights | undefined,
  deps: PipelineDeps,
): Promise<RankedRecipient[]> {
  let target: DonationItem | undefined;
  let owner: Donation | undefined;
  const donations = await deps.store.listDonations();
  for (const d of donations) {
    const found = d.items.find((it) => it.id === itemId);
    if (found) { target = found; owner = d; break; }
  }
  if (!target || !owner) throw new Error(`item not found: ${itemId}`);

  const recipients = await deps.store.listRecipients();
  const history = await deps.store.listHistory();
  const config: AgentConfig = weightsOverride
    ? { ...deps.config, weights: weightsOverride }
    : deps.config;

  return rankRecipients(target, owner, recipients, config, history);
}
