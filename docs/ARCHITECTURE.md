# Donna — Architecture & Contracts (v1)

> This document is the **single source of truth** for the build. Every implementation
> agent reads this before writing code. If code and this doc disagree, this doc wins.
> Companion doc: `docs/BUILD_PLAN.md` (work packages & ownership).

---

## 0. Design principles

1. **AI at the edges, deterministic math in the middle.** The allocation decision is
   pure code (`core/scoring`). LLMs only parse, draft, converse, and explain.
2. **Adapter everything with keys.** VAPI, InsForge DB, and LLM providers sit behind
   interfaces with a **mock/simulated implementation that is the default**. The app
   runs end-to-end TODAY with zero API keys. Live mode is an env-var flip.
3. **Items are first-class.** One donation → N line-items; each item is scored,
   dispatched, and resolved independently. Partial placement is normal.
4. **Every outcome writes back to memory.** Declines teach the system.
5. **The donor always hears back.** Pipeline is not done until the callback composes.

## 1. Repository layout

```
Donna/
├── PRD.md · README.md
├── docs/
│   ├── ARCHITECTURE.md          ← this file
│   ├── BUILD_PLAN.md            ← work packages
│   └── INSFORGE_SETUP.md        ← produced by WP-H (live-mode runbook)
├── backend/                     ← npm package "donna-backend" (TypeScript, ESM)
│   ├── package.json  tsconfig.json  vitest.config.ts  .env.example
│   ├── src/
│   │   ├── core/
│   │   │   ├── types.ts         ← ALL shared types (§3). No type defined elsewhere.
│   │   │   ├── scoring/
│   │   │   │   ├── engine.ts    ← scoreItem(), rankRecipients()
│   │   │   │   ├── terms.ts     ← the five term functions (§4)
│   │   │   │   ├── equity.ts    ← ledger math, fairness metrics, A/B simulation
│   │   │   │   └── explain.ts   ← numeric breakdown → plain-English (LLM w/ mock)
│   │   │   ├── memory/
│   │   │   │   ├── store.ts     ← MemoryStore interface (§5) + createStore() factory
│   │   │   │   ├── jsonStore.ts ← default impl: in-memory + persisted to data/db.json
│   │   │   │   └── insforgeStore.ts ← InsForge REST impl (live mode)
│   │   │   ├── agents/
│   │   │   │   ├── llm.ts       ← LlmClient interface + factory (§6)
│   │   │   │   ├── llmMock.ts   ← deterministic mock (heuristic intake parser incl.)
│   │   │   │   ├── llmAnthropic.ts   ← Anthropic Messages API (env key)
│   │   │   │   ├── llmOpenAICompat.ts← OpenAI-compatible chat (InsForge AI/OpenRouter)
│   │   │   │   ├── intake.ts    ← Agent 1: raw text → ParsedDonation
│   │   │   │   ├── offer.ts     ← Agent 2: item+recipient → OfferDraft
│   │   │   │   ├── manager.ts   ← Agent 4: chat → ConfigPatch[] + reply
│   │   │   │   └── callback.ts  ← Agent 5: resolved donation → DonorMessage
│   │   │   ├── voice/
│   │   │   │   ├── caller.ts    ← Agent 3 orchestration: call loop (§7)
│   │   │   │   ├── vapi.ts      ← real VAPI client (outbound call, webhook parse)
│   │   │   │   └── simulator.ts ← simulated recipient persona (§7.2)
│   │   │   └── pipeline.ts      ← orchestrates intake→score→dispatch→callback (§8)
│   │   ├── server.ts            ← Hono app; all routes (§9); serves on :8787
│   │   ├── config.ts            ← env parsing (§10); DEFAULT_WEIGHTS
│   │   └── seed/
│   │       ├── recipients.ts    ← 15 recipients (§11)
│   │       └── scenarios.ts     ← canned demo scenario + cached agent outputs (§12)
│   ├── data/                    ← runtime JSON persistence (gitignore contents)
│   └── test/                    ← vitest specs (colocated per module also fine)
├── frontend/                    ← npm package "donna-frontend" (Vite + React + TS)
│   └── src/ (§13)
└── insforge/
    ├── schema.sql               ← tables mirroring §5 for live mode
    └── functions/               ← edge-function wrappers around core modules
```

**Language:** TypeScript everywhere, ESM (`"type":"module"`), strict tsconfig.
**Backend runtime:** Node ≥ 20 (dev machine has 23). Dev runner: `tsx`.
**Server framework:** Hono + `@hono/node-server` (edge-compatible → closest to
InsForge functions). **Tests:** vitest. **Frontend:** Vite + React 18 + TS,
`leaflet` + `react-leaflet`, `recharts`.

## 2. Modes & runtime matrix

| Concern | Mock/sim (default, keyless) | Live (env-flipped) |
|---|---|---|
| LLM | `llmMock.ts` — deterministic | `LLM_PROVIDER=anthropic\|insforge` |
| DB | `jsonStore.ts` (data/db.json) | `DB_PROVIDER=insforge` |
| Voice calls | `simulator.ts` persona | `VOICE_PROVIDER=vapi` |
| Donor callback delivery | rendered on screen | VAPI call / SMS |

The **demo never depends on network**. Mock mode must pass the full e2e canned
scenario (§12) with zero env vars set.

## 3. Shared types — `core/types.ts` (verbatim contract)

Implement exactly these (add narrowly if needed; never rename):

```ts
export type Channel = 'voice' | 'sms' | 'email' | 'walk_in' | 'web_form';
export type ItemCategory =
  | 'fresh_produce' | 'fruit' | 'canned' | 'dry_goods' | 'baked'
  | 'dairy' | 'meat' | 'prepared' | 'beverages' | 'other';
export type ItemStatus = 'pending' | 'matched' | 'unplaceable';
export type DonationStatus = 'received' | 'parsed' | 'scored' | 'dispatching' | 'resolved';
export type RecipientType = 'pantry' | 'community_agency';
export type Infrastructure = 'walk_in_fridge' | 'fridge' | 'freezer' | 'dry_storage' | 'loading_dock';
export type CallOutcome = 'accepted' | 'declined' | 'no_answer';

export interface Donation {
  id: string; sourceChannel: Channel; sourceContact: string;
  receivedAt: string; rawText: string; status: DonationStatus;
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: DonationItem[];
  donorMessage?: string;            // Agent 5 output once resolved
}
export interface DonationItem {
  id: string; donationId: string;
  item: string; qtyLbs: number; category: ItemCategory;
  hoursToSpoil: number; needsRefrigeration: boolean;
  status: ItemStatus;
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
  receivedRecentLbs: number;        // rolling ledger total — fuels equity term
  notes?: string;
}
export interface HistoryEvent {
  id: string; recipientId: string; itemId: string;
  outcome: CallOutcome; reason?: string; at: string;
}
export interface Weights {
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;    // each 0..1; engine normalizes by sum
}
export interface AgentConfig {
  weights: Weights;
  autopilot: boolean;               // false ⇒ human-confirm gate before calls
  avgSpeedMph: number;              // default 30
}
export interface ScoreBreakdown {
  recipientId: string;
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;    // each 0..1
  total: number;                    // 0..1 weighted
  hardFail?: 'infeasible_time' | 'no_cold_chain' | 'category_rejected';
  driveTimeHours: number; distanceMiles: number;
}
export interface RankedRecipient { recipient: Recipient; score: ScoreBreakdown; }
export interface ParsedDonation {
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: Array<Pick<DonationItem,'item'|'qtyLbs'|'category'|'hoursToSpoil'|'needsRefrigeration'>>;
}
export interface OfferDraft { itemId: string; recipientId: string; script: string; summary: string; }
export interface CallAttempt {
  recipientId: string; recipientName: string;
  outcome: CallOutcome; reason?: string;
  transcript: Array<{ speaker: 'agent' | 'recipient'; text: string }>;
  at: string; simulated: boolean;
}
export interface ConfigPatch {                       // Agent 4 output — declarative only
  op: 'set_accepts' | 'add_infrastructure' | 'remove_infrastructure'
    | 'set_rejects' | 'set_weights' | 'set_autopilot' | 'set_note' | 'set_volume';
  recipientId?: string;             // required for recipient-targeted ops
  value: unknown;
}
export interface ManagerReply { reply: string; patches: ConfigPatch[]; applied: boolean; }
export interface EquitySimResult {
  drops: number;
  nearest: { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  donna:   { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  series: Array<{ drop: number; nearestGini: number; donnaGini: number }>;
}
```

## 4. Scoring engine — `core/scoring` (the IP)

`rankRecipients(item, donation, recipients, config): RankedRecipient[]` — scores all,
sorts desc by `total`, hard-fails included at bottom with `total: 0` and `hardFail` set.

Distance: haversine(pickup → recipient), miles. `driveTimeHours = miles / config.avgSpeedMph`.
If donation lacks coordinates, geocode is NOT attempted — seed scenarios always carry
lat/lng; fallback = city center (37.7749, -122.4194).

**Terms (each returns 0..1):**

1. **feasibility** — HARD GATE. If `driveTimeHours * 2 + 1 >= hoursToSpoil` (round
   trip + 1h handling) ⇒ `hardFail='infeasible_time'`, total 0. Else
   `1 - driveTimeHours / hoursToSpoil` (clamped 0..1).
2. **coldchain** — if `needsRefrigeration` and recipient has none of
   `walk_in_fridge|fridge|freezer` ⇒ `hardFail='no_cold_chain'`, total 0. Else 1
   when refrigeration matched (or not needed); `walk_in_fridge` counts 1.0, plain
   `fridge` 0.85 for refrigerated items (still passes).
3. **capacity** — let `r = qtyLbs / typicalWeeklyVolumeLbs`. Score
   `exp(-((r - 0.6) ** 2) / (2 * 0.35 ** 2))`. Required properties (unit-tested):
   peak near r≈0.6; r=0.1 and r=2.0 both score < 0.5·peak; monotonic decline on
   both sides of the peak.
4. **equity** — let `avg` = mean of `receivedRecentLbs` across ALL recipients;
   `x = (avg - recipient.receivedRecentLbs) / max(avg, 1)` clamped to [-1,1];
   score `(x + 1) / 2`. Property: a recipient below network average scores > 0.5;
   above average scores < 0.5.
5. **prefs** — category in `rejects` ⇒ `hardFail='category_rejected'`, total 0.
   In `accepts` ⇒ 1.0. Not listed either way ⇒ 0.5. If a `HistoryEvent` shows this
   recipient DECLINED this category within the last 7 days ⇒ multiply by 0.5.

`total = Σ(w_t · term_t) / Σ(w_t)` over the five terms (skip none; hard fails
short-circuit to 0). `DEFAULT_WEIGHTS = { feasibility:.30, coldchain:.15,
capacity:.20, equity:.20, prefs:.15 }`.

**Equity module** (`equity.ts`):
- `gini(values: number[]): number` (0 = perfectly equal).
- `minMaxRatio(values): number` (min/max, 1 = equal; guard div-by-zero).
- `simulateAB(recipients, drops=30, seed=42): EquitySimResult` — seeded PRNG
  (mulberry32; NEVER `Math.random`) generates `drops` random donations (varying
  category/qty/spoilage/pickup point) and allocates each under two policies:
  **nearest** = closest recipient passing hard gates; **donna** = top of
  `rankRecipients` with default weights, updating `receivedRecentLbs` as it goes
  (both policies mutate their own cloned state). Returns cumulative ledgers +
  fairness metrics + per-drop gini series.

**Explain** (`explain.ts`): `explainRanking(item, ranked): Promise<string>` — takes
top-2, produces 2 plain sentences on why #1 beat #2. Uses LlmClient; the mock
returns a template built from the actual breakdown numbers (still informative).

## 5. Memory — `core/memory/store.ts`

```ts
export interface MemoryStore {
  init(): Promise<void>;                       // load/create; seed if empty
  // donations
  saveDonation(d: Donation): Promise<void>;
  getDonation(id: string): Promise<Donation | null>;
  listDonations(): Promise<Donation[]>;
  // recipients
  listRecipients(): Promise<Recipient[]>;
  getRecipient(id: string): Promise<Recipient | null>;
  updateRecipient(id: string, patch: Partial<Recipient>): Promise<Recipient>;
  // history & ledger
  addHistory(e: HistoryEvent): Promise<void>;
  listHistory(recipientId?: string): Promise<HistoryEvent[]>;
  creditReceived(recipientId: string, lbs: number): Promise<void>;
  // config
  getConfig(): Promise<AgentConfig>;
  setConfig(patch: Partial<AgentConfig>): Promise<AgentConfig>;
  reset(): Promise<void>;                      // restore seeds (demo reset)
}
export function createStore(): MemoryStore;    // env DB_PROVIDER: 'json'(default)|'insforge'
```

`jsonStore.ts`: single JSON document at `backend/data/db.json`, loaded to memory,
debounced write-through. Seeded from `seed/recipients.ts` when empty or on `reset()`.
`insforgeStore.ts`: same interface over InsForge records REST/SDK
(`Authorization: Bearer`, tables per `insforge/schema.sql`). Must compile without
keys; constructor throws only when actually selected without env.

## 6. LLM layer — `core/agents/llm.ts`

```ts
export interface LlmClient {
  complete(opts: { system?: string; prompt: string; json?: boolean }): Promise<string>;
}
export function createLlm(): LlmClient;  // env LLM_PROVIDER: 'mock'(default)|'anthropic'|'insforge'
export function extractJson<T>(raw: string): T;   // tolerant ```json / prose stripping
```

- `llmMock.ts` — deterministic. For **intake**: a heuristic extractor (regex/keyword)
  that genuinely parses quantities ("5 pallets" ⇒ 5×1000 lbs, "3 cases" ⇒ 3×30,
  bare numbers+lbs), spoilage ("48 hours", "2 days"), item keywords → category map,
  refrigeration by category (fresh_produce/dairy/meat/prepared ⇒ true). For
  **offer/callback/explain/manager**: template outputs built from real inputs.
  Mock manager understands the two canned demo phrases (§12) plus patterns:
  "got a new freezer/fridge", "only send/accepts X", "stop sending X".
- `llmAnthropic.ts` — Messages API, `claude-opus-4-8` default, `ANTHROPIC_API_KEY`.
- `llmOpenAICompat.ts` — POST `{base}/chat/completions` with Bearer; serves
  InsForge AI (OpenRouter-compatible) via `INSFORGE_AI_BASE_URL` + `INSFORGE_AI_KEY`,
  model from `INSFORGE_AI_MODEL` (default `anthropic/claude-sonnet-4.5`).

**Agents 1/2/4/5** are thin functions over `LlmClient` with strict JSON prompts +
`extractJson` + defensive fallbacks (a parse failure must degrade, never throw 500):
- `parseDonation(raw, channel): Promise<ParsedDonation>` (Agent 1)
- `draftOffer(item, donation, recipient, memoryContext): Promise<OfferDraft>` (Agent 2)
- `managerChat(message, store): Promise<ManagerReply>` (Agent 4) — LLM proposes
  `ConfigPatch[]`; **code validates each patch against types/known ids and applies
  via store**; unknown ops are rejected with a polite reply. Declarative only.
- `composeDonorMessage(donation): Promise<string>` (Agent 5) — itemized: what was
  placed where, what couldn't be and why, warm sign-off ≤120 words.

## 7. Voice — `core/voice`

### 7.1 `caller.ts` — the dispatch loop (Agent 3 orchestration)
```ts
export interface VoiceProvider {
  placeCall(offer: OfferDraft, recipient: Recipient, item: DonationItem): Promise<CallAttempt>;
}
export function createVoice(): VoiceProvider;   // env VOICE_PROVIDER: 'sim'(default)|'vapi'
export async function dispatchItem(item, donation, store, config, deps): Promise<DonationItem>;
```
`dispatchItem`: rank → for each candidate (max 3 attempts): draft offer →
`placeCall` → on `accepted`: set matched, `creditReceived(qtyLbs)`, addHistory,
stop. On `declined`: addHistory with reason; if reason maps to a category problem
(contains "full"/"overstocked"/"don't take"), record it (history drives the 7-day
prefs penalty automatically); continue to next candidate. Exhausted ⇒
`unplaceable` with `resolutionReason`. Every attempt appended to `item.attempts`.

### 7.2 `simulator.ts` — deterministic recipient persona
Decision rules (no randomness):
- category ∈ rejects ⇒ decline "we don't take {category}".
- `r = qtyLbs/typicalWeeklyVolumeLbs > 1.5` ⇒ decline "that's more than we can move this week".
- needs fridge & lacks one ⇒ decline "no cold storage available".
- declined same category in last 7 days ⇒ decline "we're still overstocked on {category}".
- else ⇒ accept.
Generates a 4–6 line transcript using the offer script + persona lines
(reference the recipient's actual infrastructure/preferences so it feels alive).
`simulated: true` on the attempt.

### 7.3 `vapi.ts` — live mode
- `placeCall` → POST `https://api.vapi.ai/call` (`Authorization: Bearer ${VAPI_API_KEY}`)
  with a transient assistant: firstMessage from offer script; system prompt
  instructs to secure accept/decline + reason; `phoneNumberId: VAPI_PHONE_NUMBER_ID`;
  customer number = recipient.phone. Store `providerCallId`.
- `parseWebhook(body)` → normalized `{ type:'end-of-call-report', callId, transcript,
  outcome, reason }`; the implementer verifies current payload shape against VAPI
  docs at build time and keeps ALL vapi-specific parsing inside this file.
- Server route `/api/vapi/webhook` correlates callId → pending attempt, completes
  the same promise path `dispatchItem` awaits (in live mode `placeCall` returns a
  promise resolved by webhook, with 90s timeout ⇒ `no_answer`).

## 8. Pipeline — `core/pipeline.ts`

```ts
export async function ingestDonation(input: {channel: Channel; contact: string; rawText: string;}, deps): Promise<Donation>;       // parse → store → status 'scored'
export async function dispatchDonation(donationId, deps): Promise<Donation>;      // all pending items → dispatchItem → Agent 5 → donorMessage → 'resolved'
export async function rankItem(itemId, weightsOverride?, deps): Promise<RankedRecipient[]>;  // stateless re-rank (slider preview)
```
`deps = { store, llm, voice, config }` injected for testability.

## 9. HTTP API — `server.ts` (Hono, port **8787**, CORS: allow localhost:5173)

| Method & path | Body → Response |
|---|---|
| `GET /api/health` | `{ ok, mode: {llm, db, voice} }` |
| `POST /api/donations` | `{channel, contact, rawText}` → full `Donation` (parsed + items; each item pre-ranked: response shape `{donation, rankings: Record<itemId, RankedRecipient[]>}`) |
| `GET /api/donations` / `GET /api/donations/:id` | list / one (same enriched shape for :id) |
| `POST /api/donations/:id/dispatch` | `{}` → resolved `Donation` (runs full call loop + callback) |
| `POST /api/items/:id/rank` | `{ weights? }` → `RankedRecipient[]` + `explanation: string` (live slider preview; does NOT persist weights) |
| `GET /api/recipients` / `GET /api/recipients/:id` | recipients (+`history` on :id) |
| `GET /api/config` / `PUT /api/config` | `AgentConfig` / partial patch |
| `POST /api/manager/chat` | `{message}` → `ManagerReply` |
| `GET /api/equity/simulate?drops=30` | `EquitySimResult` |
| `POST /api/demo/reset` | reseed store |
| `POST /api/demo/canned` | loads canned scenario (§12): ingests it and returns the enriched donation — instant, works offline |
| `POST /api/vapi/webhook` | live-mode webhook sink |

Errors: JSON `{error: string}` + proper status; agent failures degrade to mock
behavior with a `warnings: string[]` field rather than 5xx.

## 10. Config — `config.ts` + `.env.example`

```
LLM_PROVIDER=mock            # mock | anthropic | insforge
ANTHROPIC_API_KEY=
INSFORGE_AI_BASE_URL=        # e.g. https://<project>.insforge.app/api/ai/v1
INSFORGE_AI_KEY=
INSFORGE_AI_MODEL=anthropic/claude-sonnet-4.5
DB_PROVIDER=json             # json | insforge
INSFORGE_BASE_URL=
INSFORGE_API_KEY=
VOICE_PROVIDER=sim           # sim | vapi
VAPI_API_KEY=
VAPI_PHONE_NUMBER_ID=
PORT=8787
```

## 11. Seed data — `seed/recipients.ts`

15 recipients around San Francisco (realistic names, real-ish SF coords spread
across neighborhoods; 10 pantries + 5 community agencies). Vary meaningfully:
- 4 with `walk_in_fridge`, 4 with `fridge` only, 3 with `freezer`+`fridge`, 4 dry-only
- `typicalWeeklyVolumeLbs` from 300 (tiny agency) to 8000 (regional pantry)
- distinct personalities: one canned/dry-goods-only ("Oak Avenue Pantry"),
  one fresh-produce-only ("Mission Greens Collective"), one fruit/small-items
  agency, one "St. Mary's" (starts WITHOUT freezer — the manager-demo adds it)
- `receivedRecentLbs` skewed: 3 big pantries near pickup corridors start high
  (2000–4000), several outer recipients near 0 — so the equity term visibly matters
- phones are obviously fake (+1 415 555 01xx), contacts named people

## 12. Canned demo scenario — `seed/scenarios.ts`

`CANNED_SCENARIO`: voicemail transcript —
*"Hey, this is Marcus from Golden State Produce. We've got a rejected shipment:
five pallets of fresh strawberries — they'll spoil in about 48 hours — plus around
200 pounds of canned black beans, and 80 pounds of day-old bread. Dock 12 at
2200 Jerrold Ave. Someone needs to grab these today. Call me back at this number."*

Expected parse (the mock parser MUST produce): strawberries 5000 lbs,
fresh_produce, 48h, fridge; beans 200 lbs, canned, 2160h, no fridge; bread 80 lbs,
baked, 24h, no fridge. Pickup lat/lng ≈ (37.7455, -122.3934).
Seeds must make the story land: strawberries → a walk-in-fridge pantry wins (with
equity in play); beans → agency; **bread finds no feasible home** (24h + the only
bread-takers too far/full) ⇒ donor callback shows partial placement.
`POST /api/demo/canned` must complete < 1s in mock mode.

## 13. Frontend — `frontend/src`

Vite + React + TS, dark "dispatch console" aesthetic (this is a hackathon demo —
it must look striking, not bootstrap-default). Vite dev server proxies `/api` →
`http://localhost:8787`. Libraries: `react-leaflet` (CARTO dark basemap tiles),
`recharts`. No CSS framework needed; hand-rolled CSS is fine — pick a strong
palette (near-black bg, one hot accent for donations, cool accent for recipients).

Layout (single page, 3 columns + drawer):
- **Left — Intake:** channel selector (voice/sms/email/walk-in tabs), textarea
  ("paste transcript / message"), "▶ Canned demo" button, donation list with
  per-item status chips (pending/matched/unplaceable).
- **Center — Map:** Leaflet; pickup pin (pulsing), recipient pins colored by
  current score (viridis-ish ramp; hard-fails grey). Clicking a pin opens its
  breakdown card. Item tabs above the map switch which item's ranking is shown.
- **Right — Decision panel:** ranked list w/ horizontal stacked score-bars
  (5 term colors + legend), explanation sentence, weight sliders (5) that call
  `/api/items/:id/rank` live on drag(debounced), **Dispatch** button
  (respects autopilot toggle: confirm modal when off), call-transcript feed
  rendering `CallAttempt`s as chat bubbles (declines red w/ reason), donor
  callback card at the end (the itemized message, styled as an SMS bubble).
- **Equity tab:** recharts line chart (nearestGini vs donnaGini per drop),
  cumulative-lbs bar chart per recipient for both policies, min/max + gini stat
  tiles. Button "Run 30-drop simulation".
- **Manager drawer:** chat UI → `/api/manager/chat`; applied patches rendered as
  diff chips ("St. Mary's ➕ freezer"); config weight state shown.
Polling/refetch after actions is fine; no websockets needed.

## 14. InsForge live mode — `insforge/`

- `schema.sql`: tables `donations`, `donation_items`, `recipients`,
  `history_events`, `agent_config` mirroring §3 (snake_case columns, jsonb for
  arrays/transcripts), plus seed INSERT for the 15 recipients.
- `functions/`: thin handlers exposing the same routes for InsForge edge runtime,
  importing from `core/` (document what needs bundling).
- `docs/INSFORGE_SETUP.md`: exact runbook — create project, apply schema, set
  secrets, deploy functions, point VAPI webhook at the function URL, flip envs.
Live mode is NOT exercised in v1 CI; it must compile and be honestly documented.

## 15. Testing bar

- **Unit (vitest):** every scoring term's required properties (§4), equity
  gini/minMaxRatio known-values, simulateAB determinism (same seed ⇒ same result)
  + donna gini < nearest gini on default seeds, mock intake parser on the canned
  transcript (§12 exact expectations), manager patch validation (bad ids rejected),
  simulator persona rules, capacity peak property.
- **Integration:** boot server (mock mode) → canned scenario e2e:
  `POST /api/demo/canned` → assert 3 items, strawberries matched to a
  walk-in-fridge recipient, bread unplaceable, donation resolved after
  `/dispatch`, `donorMessage` mentions all three items; `/api/manager/chat`
  "St. Mary's just got a new walk-in freezer" → recipient updated; re-rank shifts.
- All tests pass with **zero env vars**.
