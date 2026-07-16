-- ============================================================================
-- Donna — live-mode schema (InsForge / Postgres)
-- ============================================================================
-- Owned by WP-H. Mirrors ARCHITECTURE §3 (shared types) and §5 (MemoryStore).
--
-- Conventions:
--   * snake_case columns; TypeScript camelCase maps 1:1 (insforgeStore does the
--     column<->field translation).
--   * uuid primary keys (gen_random_uuid()).
--   * jsonb for every array / transcript / weights blob from §3.
--   * All app data lives in the `public` schema (never the reserved auth /
--     storage / system / payments schemas — see INSFORGE_SETUP.md).
--
-- Apply with:  npx @insforge/cli db query --file insforge/schema.sql
-- (idempotent: safe to re-run; recipient seeds use ON CONFLICT DO NOTHING).
--
-- NOTE on access control: the demo runs its live-mode writes through the
-- project ADMIN api key (createAdminClient), which bypasses RLS. The GRANT /
-- RLS block at the bottom is therefore optional for the hackathon demo and is
-- provided (commented) only if you later expose these tables to anon clients.
-- ============================================================================

-- Needed for gen_random_uuid() on some Postgres builds (InsForge ships it, but
-- keep this here so the file is portable / self-contained).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- recipients  (ARCHITECTURE §3 Recipient, §11 seed)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipients (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text        NOT NULL,
  type                      text        NOT NULL CHECK (type IN ('pantry','community_agency')),
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
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recipients_type ON recipients (type);

-- ----------------------------------------------------------------------------
-- donations  (ARCHITECTURE §3 Donation; items normalised into donation_items)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS donations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_channel  text        NOT NULL CHECK (source_channel IN ('voice','sms','email','walk_in','web_form')),
  source_contact  text        NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  raw_text        text        NOT NULL,
  status          text        NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','parsed','scored','dispatching','resolved')),
  donor_name      text,
  pickup_location text,
  pickup_lat      double precision,
  pickup_lng      double precision,
  donor_message   text,                    -- Agent 5 output once resolved
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_donations_status      ON donations (status);
CREATE INDEX IF NOT EXISTS idx_donations_received_at ON donations (received_at DESC);

-- ----------------------------------------------------------------------------
-- donation_items  (ARCHITECTURE §3 DonationItem; attempts[] incl. transcripts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS donation_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donation_id           uuid NOT NULL REFERENCES donations (id) ON DELETE CASCADE,
  item                  text        NOT NULL,
  qty_lbs               numeric     NOT NULL DEFAULT 0,
  category              text        NOT NULL
                          CHECK (category IN ('fresh_produce','fruit','canned','dry_goods',
                                              'baked','dairy','meat','prepared','beverages','other')),
  hours_to_spoil        numeric     NOT NULL DEFAULT 0,
  needs_refrigeration   boolean     NOT NULL DEFAULT false,
  status                text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','matched','unplaceable')),
  matched_recipient_id  uuid REFERENCES recipients (id) ON DELETE SET NULL,
  resolution_reason     text,
  attempts              jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- CallAttempt[] (transcript inside)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_donation_items_donation ON donation_items (donation_id);
CREATE INDEX IF NOT EXISTS idx_donation_items_matched  ON donation_items (matched_recipient_id);
CREATE INDEX IF NOT EXISTS idx_donation_items_status   ON donation_items (status);

-- ----------------------------------------------------------------------------
-- history_events  (ARCHITECTURE §3 HistoryEvent — drives the 7-day prefs penalty)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS history_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES recipients (id) ON DELETE CASCADE,
  item_id      text NOT NULL,   -- DonationItem.id (kept loose: items may be re-seeded independently)
  outcome      text NOT NULL CHECK (outcome IN ('accepted','declined','no_answer')),
  reason       text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_history_recipient ON history_events (recipient_id);
CREATE INDEX IF NOT EXISTS idx_history_at        ON history_events (at DESC);

-- ----------------------------------------------------------------------------
-- agent_config  (ARCHITECTURE §3 AgentConfig — single-row singleton)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_config (
  id            text PRIMARY KEY DEFAULT 'default',      -- always 'default'
  weights       jsonb   NOT NULL,                        -- Weights
  autopilot     boolean NOT NULL DEFAULT false,
  avg_speed_mph numeric NOT NULL DEFAULT 30,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton config with DEFAULT_WEIGHTS (config.ts). Idempotent.
INSERT INTO agent_config (id, weights, autopilot, avg_speed_mph) VALUES
  ('default',
   '{"feasibility":0.30,"coldchain":0.15,"capacity":0.20,"equity":0.20,"prefs":0.15}'::jsonb,
   false, 30)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Seed: 15 recipients around San Francisco (ARCHITECTURE §11).
-- ----------------------------------------------------------------------------
-- Coordinates with the seed/recipients.ts spirit (WP-B): same names, personas,
-- infra mix (4 walk_in_fridge / 4 fridge-only / 3 freezer+fridge / 4 dry-only),
-- volumes 300..8000, ledger skew so equity visibly matters. Fixed UUIDs so live
-- mode is reproducible.
--
--   *** RECONCILE-WITH-WP-B ***  The demo (mock) path uses the json store seeded
--   from backend/src/seed/recipients.ts. These INSERTs must stay value-aligned
--   with that file. At integration time, diff the two and make them match
--   (names/coords/accepts/rejects/volume/received). See report notes.
-- ============================================================================
INSERT INTO recipients
  (id, name, type, lead_contact, phone, lat, lng,
   infrastructure, accepts, rejects, typical_weekly_volume_lbs, best_call_window, received_recent_lbs, notes)
VALUES
  -- ---- 4 x walk_in_fridge --------------------------------------------------
  ('a1000000-0000-4000-8000-000000000001','Bayview Community Food Bank','pantry','Denise Carter','+14155550101',
   37.7300,-122.3850,
   '["walk_in_fridge","fridge","loading_dock","dry_storage"]'::jsonb,
   '["fresh_produce","fruit","canned","dry_goods","dairy","meat","prepared","beverages","baked"]'::jsonb,
   '[]'::jsonb, 8000, 'weekday mornings', 3800, 'Regional pantry near the pickup corridor; high recent intake.'),

  ('a1000000-0000-4000-8000-000000000004','Tenderloin Family Pantry','pantry','Marcus Bell','+14155550104',
   37.7840,-122.4130,
   '["walk_in_fridge","freezer","fridge"]'::jsonb,
   '["fresh_produce","fruit","canned","dry_goods","dairy","meat","prepared","beverages","baked"]'::jsonb,
   '[]'::jsonb, 6000, 'weekday afternoons', 3200, 'Busy downtown pantry; full cold chain; high recent intake.'),

  ('a1000000-0000-4000-8000-000000000008','Potrero Hill Provisions','pantry','Yolanda Reyes','+14155550108',
   37.7580,-122.4000,
   '["walk_in_fridge","fridge","loading_dock"]'::jsonb,
   '["fresh_produce","fruit","canned","dry_goods","dairy","prepared","beverages","baked"]'::jsonb,
   '[]'::jsonb, 4000, 'mornings', 2600, 'Close to the Jerrold Ave dock; already well-supplied this week.'),

  ('a1000000-0000-4000-8000-000000000009','Ingleside Harvest Hub','pantry','Priya Nair','+14155550109',
   37.7220,-122.4550,
   '["walk_in_fridge","fridge"]'::jsonb,
   '["fresh_produce","fruit","canned","dry_goods","dairy","meat","prepared","beverages","baked"]'::jsonb,
   '[]'::jsonb, 5000, 'mornings', 100, 'Outer-district pantry, cold chain, barely served lately — equity favours it.'),

  -- ---- 4 x fridge only -----------------------------------------------------
  ('a1000000-0000-4000-8000-000000000002','Mission Greens Collective','pantry','Sofia Alvarez','+14155550102',
   37.7599,-122.4148,
   '["fridge"]'::jsonb,
   '["fresh_produce","fruit"]'::jsonb,
   '["canned","dry_goods","dairy","meat","prepared","beverages","baked","other"]'::jsonb,
   2500, 'weekday mornings', 500, 'Fresh-produce-only co-op; refuses shelf-stable and animal products.'),

  ('a1000000-0000-4000-8000-000000000005','Sunset Neighborhood Larder','pantry','Grace Lim','+14155550105',
   37.7530,-122.4940,
   '["fridge","dry_storage"]'::jsonb,
   '["fresh_produce","fruit","canned","dry_goods","dairy","beverages","baked"]'::jsonb,
   '["meat"]'::jsonb, 1800, 'afternoons', 50, 'Outer Sunset; fridge but no freezer; rarely served.'),

  ('a1000000-0000-4000-8000-000000000011','St. Mary''s Community Center','community_agency','Father Tom Hughes','+14155550111',
   37.7920,-122.4100,
   '["fridge","dry_storage"]'::jsonb,
   '["fresh_produce","fruit","canned","dry_goods","dairy","prepared","beverages","baked"]'::jsonb,
   '[]'::jsonb, 700, 'weekday mornings', 0,
   'Starts WITHOUT a freezer — the manager-chat demo adds one ("St. Mary''s just got a new walk-in freezer").'),

  ('a1000000-0000-4000-8000-000000000013','Mission Fruit Share','community_agency','Elena Ruiz','+14155550113',
   37.7520,-122.4180,
   '["fridge"]'::jsonb,
   '["fruit","fresh_produce"]'::jsonb,
   '["meat","prepared","dry_goods"]'::jsonb, 300, 'midday', 0,
   'Tiny fruit / small-items agency; smallest volume in the network.'),

  -- ---- 3 x freezer + fridge ------------------------------------------------
  ('a1000000-0000-4000-8000-000000000007','Richmond District Pantry','pantry','Aaron Cho','+14155550107',
   37.7800,-122.4700,
   '["freezer","fridge","dry_storage"]'::jsonb,
   '["fresh_produce","fruit","canned","dry_goods","dairy","meat","prepared","beverages"]'::jsonb,
   '["baked"]'::jsonb, 3500, 'weekday mornings', 400, 'Full cold+frozen; does not take bakery items.'),

  ('a1000000-0000-4000-8000-000000000012','Glide Neighbors Program','community_agency','Renee Foster','+14155550112',
   37.7838,-122.4090,
   '["freezer","fridge"]'::jsonb,
   '["fresh_produce","fruit","canned","dairy","meat","prepared","beverages"]'::jsonb,
   '[]'::jsonb, 1000, 'afternoons', 150, 'Prepared-meals program with freezer.'),

  ('a1000000-0000-4000-8000-000000000014','Bayview Senior Meals','community_agency','Harold Simmons','+14155550114',
   37.7350,-122.3900,
   '["freezer","fridge"]'::jsonb,
   '["canned","dairy","meat","prepared","dry_goods","beverages"]'::jsonb,
   '["fresh_produce"]'::jsonb, 800, 'mornings', 300,
   'Close to the pickup; takes canned/frozen; skips loose produce.'),

  -- ---- 4 x dry storage only ------------------------------------------------
  ('a1000000-0000-4000-8000-000000000003','Oak Avenue Pantry','pantry','Walter Boyd','+14155550103',
   37.7790,-122.4310,
   '["dry_storage"]'::jsonb,
   '["canned","dry_goods","beverages"]'::jsonb,
   '["fresh_produce","fruit","dairy","meat","prepared","baked"]'::jsonb, 1500, 'weekday mornings', 200,
   'Canned / dry-goods only; no refrigeration.'),

  ('a1000000-0000-4000-8000-000000000006','Excelsior Family Table','pantry','Nina Patel','+14155550106',
   37.7240,-122.4300,
   '["dry_storage"]'::jsonb,
   '["canned","dry_goods","beverages"]'::jsonb,
   '["fresh_produce","fruit","dairy","meat","prepared"]'::jsonb, 1200, 'afternoons', 0,
   'Shelf-stable only; never served this cycle.'),

  ('a1000000-0000-4000-8000-000000000010','Visitacion Valley Pantry','pantry','Diego Morales','+14155550110',
   37.7130,-122.4080,
   '["dry_storage"]'::jsonb,
   '["canned","dry_goods","beverages","baked"]'::jsonb,
   '["fresh_produce","fruit","dairy","meat","prepared"]'::jsonb, 900, 'mornings', 0,
   'Near the pickup but dry-only — cannot take refrigerated strawberries.'),

  ('a1000000-0000-4000-8000-000000000015','SoMa Outreach Collective','community_agency','Kim Nguyen','+14155550115',
   37.7785,-122.4056,
   '["dry_storage"]'::jsonb,
   '["canned","dry_goods","beverages"]'::jsonb,
   '["fresh_produce","fruit","dairy","meat","prepared","baked"]'::jsonb, 500, 'weekday mornings', 0,
   'Shelf-stable agency, under-served — strong equity pick for the canned beans.')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- OPTIONAL — RLS + grants (only if you expose tables to anon/authenticated
-- clients instead of the admin api key). The Donna demo uses the admin key,
-- which bypasses RLS, so this block is commented out by default.
-- ============================================================================
-- ALTER TABLE recipients     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE donations      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE donation_items ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE history_events ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE agent_config   ENABLE ROW LEVEL SECURITY;
-- -- Example: read-only exposure to the anon role (writes stay admin-only).
-- GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- GRANT SELECT ON recipients, donations, donation_items, history_events, agent_config
--   TO anon, authenticated;
-- CREATE POLICY read_recipients ON recipients FOR SELECT TO anon, authenticated USING (true);
-- CREATE POLICY read_donations  ON donations  FOR SELECT TO anon, authenticated USING (true);
-- -- ...repeat per table as your exposure model requires.
