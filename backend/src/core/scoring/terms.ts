import type { DonationItem, Recipient, HistoryEvent, Infrastructure } from '../types.js';

const COLD_INFRA: Infrastructure[] = ['walk_in_fridge', 'fridge', 'freezer'];

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Great-circle distance between two lat/lng points, in miles.
 */
export function haversineMiles(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const R = 3958.7613; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function driveTimeHours(distanceMiles: number, avgSpeedMph: number): number {
  const mph = avgSpeedMph > 0 ? avgSpeedMph : 30;
  return distanceMiles / mph;
}

/**
 * §4.1 feasibility — HARD GATE.
 * If round-trip drive + 1h handling >= spoilage window ⇒ infeasible.
 * Else 1 - driveTime/hoursToSpoil, clamped 0..1.
 */
export function feasibilityTerm(
  driveHours: number,
  hoursToSpoil: number,
): { score: number; hardFail: boolean } {
  if (driveHours * 2 + 1 >= hoursToSpoil) {
    return { score: 0, hardFail: true };
  }
  return { score: clamp01(1 - driveHours / hoursToSpoil), hardFail: false };
}

/**
 * §4.2 coldchain — HARD GATE for refrigerated items lacking any cold storage.
 * Not refrigerated ⇒ 1. walk_in_fridge / freezer ⇒ 1.0, plain fridge ⇒ 0.85.
 */
export function coldchainTerm(
  item: DonationItem,
  recipient: Recipient,
): { score: number; hardFail: boolean } {
  if (!item.needsRefrigeration) {
    return { score: 1, hardFail: false };
  }
  const hasCold = recipient.infrastructure.some((i) => COLD_INFRA.includes(i));
  if (!hasCold) {
    return { score: 0, hardFail: true };
  }
  const strong =
    recipient.infrastructure.includes('walk_in_fridge') ||
    recipient.infrastructure.includes('freezer');
  return { score: strong ? 1.0 : 0.85, hardFail: false };
}

/**
 * §4.3 capacity — Gaussian around r≈0.6 (r = qty / typical weekly volume).
 * Peak near 0.6; monotonic decline either side; r=0.1 and r=2.0 both < 0.5·peak.
 */
export function capacityTerm(qtyLbs: number, typicalWeeklyVolumeLbs: number): number {
  const vol = typicalWeeklyVolumeLbs > 0 ? typicalWeeklyVolumeLbs : 1;
  const r = qtyLbs / vol;
  return clamp01(Math.exp(-((r - 0.6) ** 2) / (2 * 0.35 ** 2)));
}

/**
 * §4.4 equity — recipients below the network average of receivedRecentLbs
 * score > 0.5; above average < 0.5.
 */
export function equityTerm(recipient: Recipient, allRecipients: Recipient[]): number {
  const n = allRecipients.length;
  if (n === 0) return 0.5;
  const sum = allRecipients.reduce((acc, r) => acc + r.receivedRecentLbs, 0);
  const avg = sum / n;
  let x = (avg - recipient.receivedRecentLbs) / Math.max(avg, 1);
  if (x < -1) x = -1;
  if (x > 1) x = 1;
  return (x + 1) / 2;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * §4.5 prefs — rejects ⇒ hard fail; accepts ⇒ 1.0; unlisted ⇒ 0.5.
 * A decline of this category within the last 7 days halves the score.
 */
export function prefsTerm(
  item: DonationItem,
  recipient: Recipient,
  history: HistoryEvent[] = [],
  now: number = Date.now(),
): { score: number; hardFail: boolean } {
  if (recipient.rejects.includes(item.category)) {
    return { score: 0, hardFail: true };
  }
  let score: number;
  if (recipient.accepts.includes(item.category)) {
    score = 1.0;
  } else {
    score = 0.5;
  }
  // Decline reasons are written in humanized form ('fresh produce'), so match on
  // that; also keep the raw underscored token for robustness across producers.
  const rawCat = item.category.toLowerCase();
  const humanCat = rawCat.replace(/_/g, ' ');
  const recentlyDeclined = history.some((e) => {
    if (e.recipientId !== recipient.id) return false;
    if (e.outcome !== 'declined') return false;
    const at = Date.parse(e.at);
    if (Number.isNaN(at) || now - at > SEVEN_DAYS_MS || now - at < 0) return false;
    const reason = (e.reason ?? '').toLowerCase();
    return reason.includes(humanCat) || reason.includes(rawCat);
  });
  if (recentlyDeclined) score *= 0.5;
  return { score, hardFail: false };
}
