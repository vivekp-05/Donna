-- ============================================================================
-- Donna — live-mode schema (InsForge / Postgres)
-- ============================================================================
-- Derived from insforgeStore.ts — the store is authoritative.
--
-- Every column below is exactly what the InsforgeStore row-mappers
-- (toRecipientRow/fromRecipientRow, toDonationRow/fromDonationRow,
-- toHistoryRow/fromHistoryRow, and the agent_config {id, config} pair) read and
-- write. If the store and this file ever disagree, change this file — not the
-- store. Nothing else in the app reads these tables directly.
--
-- Key facts encoded here (all verified against the running InsForge project):
--   * id columns are TEXT — the seed uses human slugs ('rec-chinatown',
--     'hist-seed-…', donation ids), NOT uuids. No gen_random_uuid() defaults.
--   * agent_config is a single row {id: 'singleton', config: <AgentConfig jsonb>}
--     — the whole AgentConfig (weights/autopilot/avgSpeedMph) lives in one jsonb
--     blob, not split into columns.
--   * A donation's line-items AND their call attempts (incl. transcripts) are
--     embedded in donations.items (jsonb DonationItem[]). There is deliberately
--     NO separate donation_items table — one round-trip per donation.
--   * Timestamp-ish fields (donations.received_at, history_events.at) are TEXT:
--     the store treats them as opaque ISO-8601 strings and does no DB-side date
--     math, so TEXT guarantees byte-exact round-trips.
--   * Arrays (infrastructure/accepts/rejects) are jsonb.
--
-- No seed INSERTs live in this file: InsforgeStore.init() seeds 15 recipients +
-- history + the default config the first time the recipients table is empty.
--
-- Apply with the raw-SQL endpoint (statement-by-statement) or:
--   npx @insforge/cli db query --file insforge/schema.sql
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS — safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- recipients  (InsforgeStore RecipientRow)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipients (
  id                        text PRIMARY KEY,
  name                      text        NOT NULL,
  type                      text        NOT NULL,
  lead_contact              text        NOT NULL,
  phone                     text        NOT NULL,
  lat                       double precision NOT NULL,
  lng                       double precision NOT NULL,
  infrastructure            jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- Infrastructure[]
  accepts                   jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- ItemCategory[]
  rejects                   jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- ItemCategory[]
  typical_weekly_volume_lbs numeric     NOT NULL DEFAULT 0,
  best_call_window          text,
  received_recent_lbs       numeric     NOT NULL DEFAULT 0,            -- rolling ledger (equity term)
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recipients_type ON recipients (type);

-- ----------------------------------------------------------------------------
-- donations  (InsforgeStore DonationRow — line-items + attempts embedded in items)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS donations (
  id              text PRIMARY KEY,
  source_channel  text        NOT NULL,
  source_contact  text        NOT NULL,
  received_at     text        NOT NULL,                 -- ISO-8601 string (opaque)
  raw_text        text        NOT NULL,
  status          text        NOT NULL DEFAULT 'received',
  donor_name      text,
  pickup_location text,
  pickup_lat      double precision,
  pickup_lng      double precision,
  items           jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- DonationItem[] (attempts+transcripts inside)
  donor_message   text,                                       -- Agent 5 output once resolved
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations (status);

-- ----------------------------------------------------------------------------
-- history_events  (InsforgeStore HistoryRow — drives the 7-day prefs penalty)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS history_events (
  id           text PRIMARY KEY,
  recipient_id text NOT NULL,
  item_id      text NOT NULL,
  outcome      text NOT NULL,
  reason       text,
  at           text NOT NULL                            -- ISO-8601 string (opaque)
);
CREATE INDEX IF NOT EXISTS idx_history_recipient ON history_events (recipient_id);

-- ----------------------------------------------------------------------------
-- agent_config  (InsforgeStore: single row {id, config}; id === 'singleton')
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_config (
  id     text PRIMARY KEY,
  config jsonb NOT NULL                                 -- full AgentConfig blob
);
