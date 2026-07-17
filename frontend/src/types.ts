// Mirrored from backend/src/core/types.ts (ARCHITECTURE §3).
// Frontend and backend are separate packages and cannot import across the boundary,
// so this is a verbatim copy of the shared contract. Do not diverge.

export type Channel = 'voice' | 'sms' | 'email' | 'walk_in' | 'web_form';
export type ItemCategory =
  | 'fresh_produce' | 'fruit' | 'canned' | 'dry_goods' | 'baked'
  | 'dairy' | 'meat' | 'prepared' | 'beverages' | 'other';
export type ItemStatus = 'pending' | 'matched' | 'unplaceable' | 'held';
// `awaiting_triage`: parsed and scored but held for a human to approve the calls
// (PRD §10). Inbound phone donations land here; only POST /donations/:id/approve
// releases them.
export type DonationStatus =
  | 'received' | 'parsed' | 'scored' | 'awaiting_triage' | 'dispatching' | 'resolved';
export type RecipientType = 'pantry' | 'community_agency';
export type Infrastructure = 'walk_in_fridge' | 'fridge' | 'freezer' | 'dry_storage' | 'loading_dock';
export type CallOutcome = 'accepted' | 'declined' | 'no_answer';

export interface Donation {
  id: string; sourceChannel: Channel; sourceContact: string;
  receivedAt: string; rawText: string; status: DonationStatus;
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: DonationItem[];
  donorMessage?: string;
  // §M.1 — a coordinator declined this offer at the gate: no pantry was ever
  // called, and the only call placed was the one telling the donor no.
  rejected?: boolean;
  // Set while the donor rejection call is ringing; cleared when it ends. Its
  // presence is what holds the donation at `dispatching` (and the rail on
  // "Outbound call") for the real duration of the call.
  rejectCallId?: string;
}
export interface DonationItem {
  id: string; donationId: string;
  item: string; qtyLbs: number; category: ItemCategory;
  hoursToSpoil: number; needsRefrigeration: boolean;
  status: ItemStatus;
  // Present only while a call for this item is ringing/connected.
  dialing?: { recipientId: string; recipientName: string; startedAt: string };
  matchedRecipientId?: string; resolutionReason?: string;
  attempts: CallAttempt[];
}
export interface Recipient {
  id: string; name: string; type: RecipientType;
  leadContact: string; phone: string;
  lat: number; lng: number;
  infrastructure: Infrastructure[];
  accepts: ItemCategory[]; rejects: ItemCategory[];
  typicalWeeklyVolumeLbs: number;
  bestCallWindow?: string;
  receivedRecentLbs: number;
  notes?: string;
}
export interface HistoryEvent {
  id: string; recipientId: string; itemId: string;
  outcome: CallOutcome; reason?: string; at: string;
}
export interface Weights {
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;
}
export interface AgentConfig {
  weights: Weights;
  autopilot: boolean;
  avgSpeedMph: number;
}
export interface ScoreBreakdown {
  recipientId: string;
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;
  total: number;
  hardFail?: 'infeasible_time' | 'no_cold_chain' | 'category_rejected';
  driveTimeHours: number; distanceMiles: number;
}
export interface RankedRecipient { recipient: Recipient; score: ScoreBreakdown; }
export interface ParsedDonation {
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: Array<Pick<DonationItem, 'item' | 'qtyLbs' | 'category' | 'hoursToSpoil' | 'needsRefrigeration'>>;
}
export interface OfferDraft { itemId: string; recipientId: string; script: string; summary: string; }
export interface CallAttempt {
  recipientId: string; recipientName: string;
  outcome: CallOutcome; reason?: string;
  transcript: Array<{ speaker: 'agent' | 'recipient'; text: string }>;
  at: string; simulated: boolean;
  manual?: boolean;                 // §G.3 — human-logged intervention (renders MANUAL tag, not SIM)
}
// §G.3 — POST /api/items/:itemId/call/:recipientId (directed agent call) and
// POST /api/items/:itemId/manual/:recipientId (human log) both return this shape.
// §J.3: `attempt` is OPTIONAL — under live (vapi) voice the backend pipeline returns
// {item, attempt: undefined} because the real call resolves later via webhook, not
// inline. This is a documented divergence from the backend type mirror (the backend
// declares attempt non-optional but is wrong about its own live behavior).
export interface DirectedCallResponse { item: DonationItem; attempt?: CallAttempt; }
export interface ManualCallInput { outcome: CallOutcome; reason?: string; notes?: string; }
// §D.5 / §F — one flattened call-log row per CallAttempt, tagged with its donation
// and item. Mirrors backend/src/server.ts CallLogEntry (GET /api/calls, newest
// first). Feeds the Outbound feed.
export type CallLogEntry = {
  donationId: string;
  itemId: string;
  itemName: string;
} & CallAttempt;
export interface ConfigPatch {
  op: 'set_accepts' | 'add_infrastructure' | 'remove_infrastructure'
    | 'set_rejects' | 'set_weights' | 'set_autopilot' | 'set_note' | 'set_volume';
  recipientId?: string;
  value: unknown;
}
export interface ManagerReply { reply: string; patches: ConfigPatch[]; applied: boolean; }
export interface EquitySimResult {
  drops: number;
  nearest: { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  donna: { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  series: Array<{ drop: number; nearestGini: number; donnaGini: number }>;
}

// ---- API response envelopes (ARCHITECTURE §9) ----
export type Mode = { llm: string; db: string; voice: string };
export interface HealthResponse { ok: boolean; mode: Mode; warnings?: string[] }
export type Rankings = Record<string, RankedRecipient[]>;
export interface EnrichedDonation {
  donation: Donation;
  rankings: Rankings;
  warnings?: string[];
}
export interface RankResponse {
  rankings: RankedRecipient[];
  explanation: string;
  warnings?: string[];
}

// ---- inventory (§M.2) ----
// GET /api/inventory — what is on the food bank's shelf: every item a coordinator
// held, across all donations, newest first. Mirrors backend InventoryEntry.
export interface InventoryEntry {
  itemId: string;
  donationId: string;
  item: string;
  qtyLbs: number;
  category: ItemCategory;
  needsRefrigeration: boolean;
  hoursToSpoil: number;
  donorName?: string;
  receivedAt: string;
}
export interface InventoryResponse { items: InventoryEntry[]; totalLbs: number }

// §M.1 — POST /api/donations/:id/reject. `calling` is false when no donor call
// was placed (simulator voice, or the call failed) — the donation is rejected
// either way, and is already `resolved` rather than `dispatching`.
export interface RejectResponse {
  ok: boolean;
  status: DonationStatus;
  donationId: string;
  calling: boolean;
  donorMessage?: string;
}

// ---- live call feed (stage dashboard) ----
export interface LiveLine { speaker: 'agent' | 'recipient'; text: string }
/**
 * §L.2 — what a live call is DOING, as opposed to what was said on it.
 * 'on_call': someone is on the line. 'thinking': hung up, intake LLM parsing.
 * Optional because an older backend simply omits it — the rail degrades to
 * treating a phase-less live call as 'on_call'.
 */
export type CallPhase = 'on_call' | 'thinking';
export interface LiveCall { callId: string; lines: LiveLine[]; phase?: CallPhase }
export interface LiveResponse { calls: LiveCall[] }

export const TERM_KEYS = ['feasibility', 'coldchain', 'capacity', 'equity', 'prefs'] as const;
export type TermKey = (typeof TERM_KEYS)[number];
