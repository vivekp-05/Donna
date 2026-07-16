import type { Channel, ParsedDonation } from '../core/types.js';

// Canned demo scenario — ARCHITECTURE §12.
export interface CannedScenario {
  channel: Channel;
  contact: string;
  rawText: string;
  /** Ground-truth pickup coordinates the mock parser must resolve from the text. */
  pickupLat: number;
  pickupLng: number;
}

export const CANNED_SCENARIO: CannedScenario = {
  channel: 'voice',
  contact: '+14155550142',
  rawText:
    "Hey, this is Marcus from Golden State Produce. We've got a rejected shipment: " +
    'five pallets of fresh strawberries — they\'ll spoil in about 48 hours — plus around ' +
    '200 pounds of canned black beans, and 80 pounds of day-old bread. Dock 12 at ' +
    '2200 Jerrold Ave. Someone needs to grab these today. Call me back at this number.',
  pickupLat: 37.7455,
  pickupLng: -122.3934,
};

/**
 * Expected parse for the canned scenario — the mock intake parser (WP-C) MUST
 * reproduce these item facts exactly (ARCHITECTURE §12), and the memory/integration
 * tests assert against them:
 *   • strawberries — 5 pallets ⇒ 5 × 1000 = 5000 lbs, fresh_produce, 48h, refrigerated
 *   • black beans  — 200 lbs, canned, 2160h (90 days), not refrigerated
 *   • day-old bread — 80 lbs, baked, 24h, not refrigerated
 *   • pickup ≈ (37.7455, -122.3934)
 */
export const CANNED_EXPECTED_PARSE: ParsedDonation = {
  donorName: 'Marcus',
  pickupLocation: 'Dock 12, 2200 Jerrold Ave',
  pickupLat: 37.7455,
  pickupLng: -122.3934,
  items: [
    {
      item: 'strawberries',
      qtyLbs: 5000,
      category: 'fresh_produce',
      hoursToSpoil: 48,
      needsRefrigeration: true,
    },
    {
      item: 'canned black beans',
      qtyLbs: 200,
      category: 'canned',
      hoursToSpoil: 2160,
      needsRefrigeration: false,
    },
    {
      item: 'day-old bread',
      qtyLbs: 80,
      category: 'baked',
      hoursToSpoil: 24,
      needsRefrigeration: false,
    },
  ],
};
