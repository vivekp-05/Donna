import type { Recipient, HistoryEvent } from '../core/types.js';

/**
 * 15 recipients around San Francisco — ARCHITECTURE §11.
 *
 * Composition (exact §11 constraints):
 *   • 10 pantries + 5 community agencies
 *   • infrastructure: 4 walk_in_fridge, 4 fridge-only, 3 freezer+fridge, 4 dry-only
 *   • typicalWeeklyVolumeLbs spans 300 (tiny agency) → 8000 (regional pantry)
 *   • personalities: "Oak Avenue Pantry" (canned/dry only),
 *     "Mission Greens Collective" (fresh-produce only),
 *     "Visitacion Valley Fruit Share" (fruit / small-items agency),
 *     "St. Mary's Center" (starts WITHOUT freezer — the manager demo adds it)
 *   • receivedRecentLbs skewed: big pantries on the eastern pickup corridor start
 *     high (2000–4000); outer recipients start near 0 — so equity visibly matters
 *   • phones obviously fake (+1 415 555 01xx), contacts are named people
 *
 * Story wiring for the canned scenario (§12), pickup ≈ (37.7455, -122.3934):
 *   • strawberries (fresh_produce, walk-in) → "Bayview Community Food Hub" wins —
 *     close, big walk-in, near-peak capacity, low received (equity carries it over
 *     the bigger-but-overstocked Potrero Hill / Chinatown pantries).
 *   • black beans (canned) → "Hunters Point Community Agency" wins — an agency,
 *     tiny volume ⇒ near-peak capacity, close, low received.
 *   • day-old bread (baked, 24h) → unplaceable. Only Sunset Outreach & Richmond
 *     District Larder take baked, both far on the west side AND currently full:
 *     SEED_HISTORY records a recent baked decline for each, so the deterministic
 *     simulator's 7-day category memory turns them down again. Everyone else
 *     rejects baked (hard-fail). ⇒ partial placement in the donor callback.
 */

// Order chosen so the array reads as a spread across SF neighborhoods.
const RECIPIENTS: Recipient[] = [
  {
    id: 'rec-bayview-hub',
    name: 'Bayview Community Food Hub',
    type: 'pantry',
    leadContact: 'Denise Carter',
    phone: '+14155550101',
    lat: 37.7360,
    lng: -122.3890,
    infrastructure: ['walk_in_fridge', 'fridge', 'loading_dock'],
    accepts: ['fresh_produce', 'fruit', 'dairy', 'canned', 'dry_goods', 'beverages'],
    rejects: ['baked', 'meat'],
    typicalWeeklyVolumeLbs: 7500,
    bestCallWindow: 'Weekdays 8am–4pm',
    receivedRecentLbs: 250,
    notes: 'Large Bayview hub with a walk-in cooler and a loading dock. Runs low this week — good target for equity.',
  },
  {
    id: 'rec-islais-creek',
    name: 'Islais Creek Pantry',
    type: 'pantry',
    leadContact: 'Raymond Ortiz',
    phone: '+14155550102',
    lat: 37.7480,
    lng: -122.3980,
    infrastructure: ['fridge'],
    accepts: ['fresh_produce', 'fruit', 'canned', 'dry_goods', 'beverages'],
    rejects: ['baked', 'meat', 'prepared'],
    typicalWeeklyVolumeLbs: 4000,
    bestCallWindow: 'Weekdays 9am–5pm',
    receivedRecentLbs: 3200,
    notes: 'On the eastern pickup corridor; has taken a lot of produce lately.',
  },
  {
    id: 'rec-mission-greens',
    name: 'Mission Greens Collective',
    type: 'pantry',
    leadContact: 'Lucia Fernández',
    phone: '+14155550103',
    lat: 37.7600,
    lng: -122.4150,
    infrastructure: ['walk_in_fridge', 'fridge'],
    accepts: ['fresh_produce', 'fruit'],
    rejects: ['canned', 'dry_goods', 'baked', 'dairy', 'meat', 'prepared', 'beverages', 'other'],
    typicalWeeklyVolumeLbs: 2500,
    bestCallWindow: 'Tue/Thu mornings',
    receivedRecentLbs: 900,
    notes: 'Fresh-produce specialist — only takes produce and fruit. Small footprint, fills up fast.',
  },
  {
    id: 'rec-oak-avenue',
    name: 'Oak Avenue Pantry',
    type: 'pantry',
    leadContact: 'Harold Kim',
    phone: '+14155550104',
    lat: 37.7240,
    lng: -122.4260,
    infrastructure: ['dry_storage'],
    accepts: ['canned', 'dry_goods'],
    rejects: ['fresh_produce', 'fruit', 'dairy', 'meat', 'prepared', 'baked', 'beverages'],
    typicalWeeklyVolumeLbs: 1800,
    bestCallWindow: 'Weekdays 10am–2pm',
    receivedRecentLbs: 150,
    notes: 'Shelf-stable only — no refrigeration. Canned goods and dry goods.',
  },
  {
    id: 'rec-tenderloin-meals',
    name: 'Tenderloin Meal Program',
    type: 'community_agency',
    leadContact: 'Angela Brooks',
    phone: '+14155550105',
    lat: 37.7840,
    lng: -122.4140,
    infrastructure: ['freezer', 'fridge'],
    accepts: ['prepared', 'dairy', 'meat', 'fresh_produce', 'canned', 'dry_goods', 'beverages'],
    rejects: ['baked'],
    typicalWeeklyVolumeLbs: 3000,
    bestCallWindow: 'Daily 7am–3pm',
    receivedRecentLbs: 2800,
    notes: 'Cooks hot meals; freezer + fridge on site. Already well-supplied this week. Bakes fresh, so no day-old bread.',
  },
  {
    id: 'rec-st-marys',
    name: "St. Mary's Center",
    type: 'community_agency',
    leadContact: 'Father Daniel Reyes',
    phone: '+14155550106',
    lat: 37.7810,
    lng: -122.4320,
    infrastructure: ['fridge'],
    accepts: ['canned', 'dry_goods', 'fresh_produce', 'fruit', 'dairy', 'beverages'],
    rejects: ['meat', 'baked'],
    typicalWeeklyVolumeLbs: 1200,
    bestCallWindow: 'Weekdays 9am–1pm',
    receivedRecentLbs: 400,
    notes: 'Refrigerator only — no freezer yet (the manager demo adds one).',
  },
  {
    id: 'rec-excelsior-table',
    name: 'Excelsior Family Table',
    type: 'pantry',
    leadContact: 'Marisol Vega',
    phone: '+14155550107',
    lat: 37.7260,
    lng: -122.4300,
    infrastructure: ['freezer', 'fridge'],
    accepts: ['fresh_produce', 'fruit', 'dairy', 'meat', 'canned', 'dry_goods', 'prepared', 'beverages'],
    rejects: ['baked'],
    typicalWeeklyVolumeLbs: 3500,
    bestCallWindow: 'Weekdays 8am–6pm',
    receivedRecentLbs: 300,
    notes: 'Full cold chain incl. freezer. Underserved lately — strong equity candidate.',
  },
  {
    id: 'rec-sunset-outreach',
    name: 'Sunset Outreach Pantry',
    type: 'pantry',
    leadContact: 'Grace Liu',
    phone: '+14155550108',
    lat: 37.7520,
    lng: -122.4940,
    infrastructure: ['dry_storage'],
    accepts: ['canned', 'dry_goods', 'baked', 'beverages'],
    rejects: ['meat', 'prepared', 'fresh_produce'],
    typicalWeeklyVolumeLbs: 900,
    bestCallWindow: 'Mon/Wed/Fri 10am–2pm',
    receivedRecentLbs: 3000,
    notes: 'Outer Sunset — far from eastern pickups. Takes bread when it can, but is overstocked right now.',
  },
  {
    id: 'rec-richmond-larder',
    name: 'Richmond District Larder',
    type: 'pantry',
    leadContact: 'Peter Nakamura',
    phone: '+14155550109',
    lat: 37.7770,
    lng: -122.4870,
    infrastructure: ['dry_storage'],
    accepts: ['canned', 'dry_goods', 'baked', 'beverages'],
    rejects: ['fresh_produce', 'meat', 'prepared', 'dairy'],
    typicalWeeklyVolumeLbs: 1500,
    bestCallWindow: 'Weekdays 11am–3pm',
    receivedRecentLbs: 2600,
    notes: 'Outer Richmond — the other bread-taker, also full this week.',
  },
  {
    id: 'rec-potrero-hill',
    name: 'Potrero Hill Pantry',
    type: 'pantry',
    leadContact: 'Sandra Willis',
    phone: '+14155550110',
    lat: 37.7570,
    lng: -122.4000,
    infrastructure: ['walk_in_fridge', 'fridge'],
    accepts: ['fresh_produce', 'fruit', 'dairy', 'canned', 'dry_goods', 'beverages'],
    rejects: ['baked', 'meat'],
    typicalWeeklyVolumeLbs: 6000,
    bestCallWindow: 'Weekdays 8am–5pm',
    receivedRecentLbs: 3800,
    notes: 'Big walk-in pantry near the corridor, but heavily supplied this week — equity holds it back.',
  },
  {
    id: 'rec-hunters-point',
    name: 'Hunters Point Community Agency',
    type: 'community_agency',
    leadContact: 'Tyrone Jefferson',
    phone: '+14155550111',
    lat: 37.7300,
    lng: -122.3770,
    infrastructure: ['dry_storage'],
    accepts: ['canned', 'dry_goods', 'beverages'],
    rejects: ['fresh_produce', 'fruit', 'dairy', 'meat', 'prepared', 'baked'],
    typicalWeeklyVolumeLbs: 350,
    bestCallWindow: 'Weekdays 9am–12pm',
    receivedRecentLbs: 100,
    notes: 'Small agency close to the docks. Shelf-stable only; barely served lately — ideal for a modest canned load.',
  },
  {
    id: 'rec-visitacion-fruit',
    name: 'Visitacion Valley Fruit Share',
    type: 'community_agency',
    leadContact: 'Mei Zhang',
    phone: '+14155550112',
    lat: 37.7170,
    lng: -122.4080,
    infrastructure: ['fridge'],
    accepts: ['fruit', 'fresh_produce'],
    rejects: ['meat', 'prepared', 'baked', 'dry_goods'],
    typicalWeeklyVolumeLbs: 300,
    bestCallWindow: 'Sat mornings',
    receivedRecentLbs: 80,
    notes: 'Tiny fruit/produce share for families. Smallest volume in the network.',
  },
  {
    id: 'rec-north-beach',
    name: 'North Beach Neighbors',
    type: 'community_agency',
    leadContact: 'Gina Romano',
    phone: '+14155550113',
    lat: 37.8060,
    lng: -122.4100,
    infrastructure: ['freezer', 'fridge'],
    accepts: ['dairy', 'meat', 'prepared', 'fresh_produce', 'canned', 'dry_goods', 'beverages'],
    rejects: ['baked'],
    typicalWeeklyVolumeLbs: 2000,
    bestCallWindow: 'Weekdays 10am–4pm',
    receivedRecentLbs: 500,
    notes: 'Freezer + fridge; flexible intake, but no day-old baked goods.',
  },
  {
    id: 'rec-haight-street',
    name: 'Haight Street Pantry',
    type: 'pantry',
    leadContact: 'Owen Bradley',
    phone: '+14155550114',
    lat: 37.7700,
    lng: -122.4460,
    infrastructure: ['fridge'],
    accepts: ['fresh_produce', 'fruit', 'canned', 'dry_goods', 'dairy', 'beverages'],
    rejects: ['meat', 'baked', 'prepared'],
    typicalWeeklyVolumeLbs: 1600,
    bestCallWindow: 'Weekdays 11am–5pm',
    receivedRecentLbs: 600,
    notes: 'Neighborhood pantry with a fridge.',
  },
  {
    id: 'rec-chinatown',
    name: 'Chinatown Community Pantry',
    type: 'pantry',
    leadContact: 'David Chen',
    phone: '+14155550115',
    lat: 37.7960,
    lng: -122.4070,
    infrastructure: ['walk_in_fridge', 'fridge'],
    accepts: ['fresh_produce', 'fruit', 'canned', 'dry_goods', 'beverages'],
    rejects: ['meat', 'baked', 'prepared', 'dairy'],
    typicalWeeklyVolumeLbs: 8000,
    bestCallWindow: 'Daily 8am–6pm',
    receivedRecentLbs: 4000,
    notes: 'Largest regional pantry, walk-in cooler — but already the most-served this week.',
  },
];

/** Deep clones so callers can never mutate the shared seed constant. */
export const SEED_RECIPIENTS: Recipient[] = RECIPIENTS;

export function makeSeedRecipients(): Recipient[] {
  return RECIPIENTS.map((r) => ({
    ...r,
    infrastructure: [...r.infrastructure],
    accepts: [...r.accepts],
    rejects: [...r.rejects],
  }));
}

/**
 * Seeded history — the two bread-takers each declined a baked donation a few days
 * ago and are still overstocked. The scoring prefs term (§4.5) and the simulator's
 * 7-day category memory (§7.2) both key off the humanized category name ("baked")
 * appearing in the decline reason, so these turn day-old bread away deterministically.
 * `at` is regenerated relative to now on every seed/reset so it always sits inside
 * the 7-day window.
 */
export function makeSeedHistory(nowMs: number = Date.now()): HistoryEvent[] {
  const twoDaysAgo = new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString();
  const threeDaysAgo = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();
  return [
    {
      id: 'hist-seed-sunset-baked',
      recipientId: 'rec-sunset-outreach',
      itemId: 'seed-baked-decline-1',
      outcome: 'declined',
      reason: "We're still overstocked on baked goods from earlier this week.",
      at: twoDaysAgo,
    },
    {
      id: 'hist-seed-richmond-baked',
      recipientId: 'rec-richmond-larder',
      itemId: 'seed-baked-decline-2',
      outcome: 'declined',
      reason: 'Our shelves are full of baked bread right now, no room.',
      at: threeDaysAgo,
    },
  ];
}
