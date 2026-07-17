# Donna — UI Redesign + Live-Key Wiring (v1.1)

> Binding contract for the v1.1 fix pass. Supersedes ARCHITECTURE §13 for the
> frontend. Everything else in ARCHITECTURE.md still holds unless amended in §D.

## A. Why (user feedback, verbatim priorities)

1. **"Way too much text / no one wants so much bs on their screen."** The console
   must become minimal. The MAP is good — make it the hero; everything else gets
   out of its way.
2. **"All this information must be stored in the DB, come from the DB, go to the DB."**
   The UI must be DB-first: it *renders* server state, never owns it. Intake is
   not a giant always-on form — donations *arrive* (via channels → DB) and appear
   in a feed. When VAPI inbound goes live, calls land in the DB via webhook and
   appear in the same feed with ZERO frontend changes.
3. **"Call logs must go directly to the DB."** Attempts/transcripts are already
   persisted on items; the UI must read them from fetches only, and a dedicated
   call-log endpoint makes them first-class.
4. **The offer script is a data dump.** It recites the recipient's DB row
   (Infrastructure: …, Prefers: …, Does not take: …). Forbidden. Scripts become
   short and human.

## B. Design language (hard rules)

- **Map full-bleed hero.** It renders edge-to-edge under everything; panels float
  over it as compact overlays with translucent dark surfaces (backdrop-blur ok).
- **One accent color** (keep the orange) for actions/pickup. Status is dots only:
  green=matched/accepted, red=declined/unplaceable, grey=pending/infeasible.
  KILL the 5-color stacked bars from the default view (breakdown lives behind an
  expand interaction).
- **Text budget:** any visible entity gets ≤2 lines by default. No ALL-CAPS
  section shouting ("INTAKE", "DECISION" headers: gone). No raw enum tokens in
  UI copy (`fresh_produce` → "fresh produce", `walk_in_fridge` → "walk-in fridge")
  — add a `humanize()` util and use it EVERYWHERE user-visible.
- Header shrinks to 44px: wordmark · Dispatch|Equity segmented control · a single
  status dot w/ tooltip (mode) · reset icon-button. No text chips.

## C. Layout spec

```
┌────────────────────────────────────────────────────────────┐
│ Donna        [Dispatch|Equity]                    ● ↻      │ 44px
├──────────┬────────────────────────────────┬────────────────┤
│ Feed     │                                │ (only when an  │
│ 300px    │        FULL-BLEED MAP          │ item selected) │
│ overlay  │  pickup pin + scored pins      │ Detail 340px   │
│          │                                │ overlay        │
│ [+ New]  │                                │                │
└──────────┴────────────────────────────────┴────────────────┘
```

**Left — Live feed (300px floating panel):**
- Title: "Live feed" + subtle channel legend. Content = `GET /api/donations`
  polled every 3s (silent refetch; no spinners after first load).
- Donation card (≤2 lines): `donor · channel icon · time` / item pills
  (status-dot + short name only). Click item pill → select item (map + detail).
- Bottom: one primary button **“+ Donation”** → opens a **modal** containing what
  used to be the intake panel: channel tabs, textarea, Parse & score, and a small
  "Play canned demo" text-button. The modal is the ONLY place intake UI exists.
- Empty state: one quiet line ("Waiting for donations…").

**Right — Detail overlay (340px, mounts only on selection, closable ✕):**
1. **Item strip:** `fresh strawberries · 5,000 lb · ❄ · spoils in 48h` +
   status dot. One line.
2. **Ranked matches (compact):** each row = `#n  Name  ······  0.80` with a thin
   single-color score bar underneath. Max 5 rows visible; hard-fails collapsed
   under one muted row: "7 not feasible ▸". Clicking a row expands IN PLACE:
   five labeled micro-bars (term breakdown), drive time, one "why" sentence
   (from `/api/items/:id/rank` explanation). Only one row expanded at a time.
3. **Tune (hidden by default):** a small `⚙` icon-button reveals the 5 weight
   sliders inline (debounced live re-rank, as today). Collapsed on mount.
4. **Dispatch** — the one primary button (confirm modal when autopilot off).
5. **Activity (after dispatch):** ONE LINE per attempt:
   `✗ Richmond District Larder — still overstocked on baked` /
   `✓ Chinatown Community Pantry — accepted`. Click a line → expands the full
   transcript (chat bubbles, as today but 13px). Donor callback = one compact
   SMS-style bubble "To Marcus:" at the end, collapsed to 2 lines + "more".
- Everything in this panel renders exclusively from fetched DB state; after any
  action → refetch donation; NO domain data held in component state.

**Equity view:** unchanged charts, tightened: stat tiles row (nearest vs donna
gini + min/max), then the two charts. Remove any explanatory paragraphs — one
caption line each.

## D. Backend amendments (ARCHITECTURE stays authoritative + these)

1. **Gemini LLM provider.** `createLlm()` gains `'gemini'`: reuse
   `llmOpenAICompat.ts` pointed at Google's OpenAI-compatible endpoint
   `https://generativelanguage.googleapis.com/v1beta/openai` with
   `GEMINI_API_KEY`, model `GEMINI_MODEL` (default `gemini-2.5-flash`).
   Update config.ts env matrix + `.env.example` (LLM_PROVIDER adds `gemini`;
   GEMINI_API_KEY, GEMINI_MODEL). Update ARCHITECTURE §6/§10 accordingly.
2. **.env loading.** config.ts loads `backend/.env` at boot via
   `process.loadEnvFile` (Node ≥20.12) inside try/catch (absent file = fine).
   No new dependency. Real env vars win over file values.
3. **Offer scripts become human** (mock template AND live prompt): ≤2 sentences,
   spoken register. Structure: greeting w/ contact first name → what + how much
   + spoilage urgency → AT MOST ONE contextual clause drawn from memory (e.g.
   "I know you've got walk-in fridge space") → the ask. NEVER enumerate
   infrastructure/accepts/rejects lists; never print raw enum tokens. Same rule
   for donor-callback copy (already close; verify).
4. **Canned demo stays instant:** `/api/demo/canned` ALWAYS uses the mock LLM
   path regardless of LLM_PROVIDER (it is the stage-insurance path). Normal
   `POST /api/donations` uses the configured provider with graceful degrade to
   mock on error/timeout (8s cap) + `warnings[]` as today.
5. **Call log endpoint:** `GET /api/calls` → flattened, newest-first
   `[{donationId, itemId, itemName, ...CallAttempt}]` from the DB (derived from
   items' attempts). The UI may use it later; it makes call logs first-class.
6. **VAPI key validation (no calls placed!):** a small
   `backend/scripts/vapi-check.ts` (run: `npx tsx scripts/vapi-check.ts`) that
   GETs `https://api.vapi.ai/phone-number` with VAPI_API_KEY, prints status +
   any phone-number ids. Integrator runs it once and reports; if exactly one
   number exists, write its id into `.env` VAPI_PHONE_NUMBER_ID. Placing real
   calls remains out of scope for this pass.
7. **Live-Gemini smoke:** with the provided key, POST a fresh non-canned
   donation text through `POST /api/donations` under `LLM_PROVIDER=gemini` and
   assert ≥1 item parses sanely (network test, integrator-only, not vitest).

## E. Non-negotiables / guardrails

- `.env` is NEVER committed (already gitignored) and keys NEVER appear in
  frontend code or in any committed file. tests stay green with zero env vars
  (mock default when .env absent).
- Map behavior, scoring engine, pipeline, and API contract (beyond §D additions)
  DO NOT CHANGE in this pass.
- All 120 existing tests keep passing (offer-template tests may be UPDATED to
  assert the new humane script shape — that's a legitimate spec change, not
  test-gaming; same for any snapshot-ish string assertions).
- `tsc` + `vitest` + `vite build` green; canned e2e still <1s.

## F. v1.2 — Inbound / Outbound split (user feedback)

The two docks become directional. "Left shows inbound, right shows outbound."

**Left dock (300px) — retitle "Inbound".** Content as today: DB-polled donation
feed + "+ Donation" modal button. No other changes.

**Right dock (340px) — new default view "Outbound".** Always mounted (no longer
only-on-selection). A DB-first feed of everything Donna sends OUT, newest first:
- **Call attempts** from `GET /api/calls` (polled every 3s, silent): one row per
  attempt — status dot (green accepted / red declined / grey no-answer),
  recipient name, item name, time. Click row → expand transcript inline
  (one-at-a-time, as the detail activity list today).
- **Donor callbacks** interleaved: derived client-side from resolved donations
  with a `donorMessage` (timestamp = latest attempt `at` on that donation, else
  `receivedAt`). Row: ✉ "To {donorName}" + first line; click → full message.
- Empty state: one quiet line ("No outbound activity yet.").

**Item detail becomes a swap, not a separate panel.** Clicking an item pill in
Inbound swaps the right dock's content to the item Detail view (item strip,
ranked rows, ⚙ tune, Dispatch, per-item activity — unchanged from §C). A
"← Outbound" back control (and ✕) returns to the Outbound feed. After a
dispatch, returning to Outbound shows the fresh attempts via the poll.

Frontend-only change (plus `getCalls()` + `CallLogEntry` in the typed api
client). §B design rules (one accent, ≤2-line rows, humanized copy) apply
unchanged. tsc + vite build must stay green.
