import type {
  Donation, DonationItem, Recipient, AgentConfig,
  ScoreBreakdown, RankedRecipient, HistoryEvent,
} from '../types.js';
import {
  haversineMiles, driveTimeHours,
  feasibilityTerm, coldchainTerm, capacityTerm, equityTerm, prefsTerm,
} from './terms.js';

// City-center fallback when a donation carries no pickup coordinates (§4).
const FALLBACK_LAT = 37.7749;
const FALLBACK_LNG = -122.4194;

export function scoreItem(
  item: DonationItem,
  donation: Donation,
  recipient: Recipient,
  config: AgentConfig,
  history: HistoryEvent[] = [],
  allRecipients: Recipient[] = [recipient],
): ScoreBreakdown {
  const pickupLat = donation.pickupLat ?? FALLBACK_LAT;
  const pickupLng = donation.pickupLng ?? FALLBACK_LNG;
  const distanceMiles = haversineMiles(pickupLat, pickupLng, recipient.lat, recipient.lng);
  const driveHours = driveTimeHours(distanceMiles, config.avgSpeedMph);

  const feas = feasibilityTerm(driveHours, item.hoursToSpoil);
  const cold = coldchainTerm(item, recipient);
  const cap = capacityTerm(item.qtyLbs, recipient.typicalWeeklyVolumeLbs);
  const eq = equityTerm(recipient, allRecipients);
  const pr = prefsTerm(item, recipient, history);

  const w = config.weights;
  const wSum = w.feasibility + w.coldchain + w.capacity + w.equity + w.prefs;
  const weighted =
    wSum > 0
      ? (w.feasibility * feas.score +
         w.coldchain * cold.score +
         w.capacity * cap +
         w.equity * eq +
         w.prefs * pr.score) / wSum
      : 0;

  let hardFail: ScoreBreakdown['hardFail'];
  if (feas.hardFail) hardFail = 'infeasible_time';
  else if (cold.hardFail) hardFail = 'no_cold_chain';
  else if (pr.hardFail) hardFail = 'category_rejected';

  return {
    recipientId: recipient.id,
    feasibility: feas.score,
    coldchain: cold.score,
    capacity: cap,
    equity: eq,
    prefs: pr.score,
    total: hardFail ? 0 : weighted,
    ...(hardFail ? { hardFail } : {}),
    driveTimeHours: driveHours,
    distanceMiles,
  };
}

export function rankRecipients(
  item: DonationItem,
  donation: Donation,
  recipients: Recipient[],
  config: AgentConfig,
  history: HistoryEvent[] = [],
): RankedRecipient[] {
  const ranked: RankedRecipient[] = recipients.map((recipient) => ({
    recipient,
    score: scoreItem(item, donation, recipient, config, history, recipients),
  }));

  ranked.sort((a, b) => {
    // Hard fails always sink to the bottom, then by total desc, stable-ish by id.
    const aFail = a.score.hardFail ? 1 : 0;
    const bFail = b.score.hardFail ? 1 : 0;
    if (aFail !== bFail) return aFail - bFail;
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return a.recipient.id.localeCompare(b.recipient.id);
  });

  return ranked;
}
