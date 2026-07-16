# Donna — InsForge Live-Mode Setup Runbook

> Produced by **WP-H**. This is the exact, ordered procedure to take Donna from
> the keyless mock demo to InsForge-backed **live mode** (real DB, real AI, real
> VAPI phone calls).
>
> **Honesty banner:** Live mode is **not exercised in v1 CI**. The mock demo
> (zero env vars) is the tested, stage-ready path. Everything below compiles and
> is documented from current InsForge platform docs, but steps marked
> **[UNTESTED]** / **[TO-VERIFY]** have not been run against a live project.
> Budget time to verify the two platform-specific unknowns: the function invoke
> path prefix, and which AI gateway base URL your project serves.

---

## 0. Prerequisites

- Node ≥ 20, this repo checked out, `npm install` run in `backend/` and `frontend/`.
- An InsForge account (`https://insforge.dev`).
- `@insforge/cli` (invoked via `npx @insforge/cli …`; no global install needed).
- `esbuild` available (`depsNeeded` — add as a backend dev dep; the integrator
  installs it). Needed only to bundle the edge function.
- (Optional, for live calls) a VAPI account with a purchased phone number.

Mock mode needs **none** of this — `npm run dev` in `backend/` + `frontend/`
runs the whole demo offline.

---

## 1. Create / link the InsForge project

```bash
# creates a project and writes .insforge/project.json (contains oss_host)
npx @insforge/cli create
# ...or link an existing one:
# npx @insforge/cli link
```

Record two values you'll reuse:

- **Base URL** = the `oss_host` field in `.insforge/project.json`
  (e.g. `https://donna.us-east.insforge.app`).
- **Admin API key**:
  ```bash
  npx @insforge/cli secrets get API_KEY      # full-access admin key
  ```
  The `insforgeStore` writes with this key (`createAdminClient`), which bypasses
  RLS — that's why `schema.sql` leaves RLS off by default.

> **[TO-VERIFY]** exact key names on your CLI version (`API_KEY` vs
> `SERVICE_ROLE_KEY`, `ANON_KEY`). `npx @insforge/cli secrets list`.

---

## 2. Apply the schema

```bash
npx @insforge/cli db query --file insforge/schema.sql
```

This creates `recipients`, `donations`, `donation_items`, `history_events`,
`agent_config`, seeds the 15 SF recipients (§11) and the default `agent_config`
row. The file is **idempotent** (`CREATE TABLE IF NOT EXISTS`, seed
`ON CONFLICT DO NOTHING`) — safe to re-run.

Verify:

```bash
npx @insforge/cli db query "SELECT count(*) FROM recipients;"   # expect 15
npx @insforge/cli db query "SELECT id, weights FROM agent_config;"  # expect 'default'
```

> **Reconcile with `backend/src/seed/recipients.ts` (WP-B):** the mock demo seeds
> from that TS file; live mode seeds from this SQL. Keep names / coords / accepts
> / rejects / volumes / `received_recent_lbs` value-aligned so the two modes tell
> the same story. Diff them at integration time.

---

## 3. Set function secrets (ARCHITECTURE §10 env matrix)

Set the runtime secrets the deployed function will read. Choose your LLM and
voice providers:

```bash
# --- Database (required for live mode) ---
npx @insforge/cli secrets add DB_PROVIDER insforge
npx @insforge/cli secrets add INSFORGE_BASE_URL  https://<app>.<region>.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY   <admin-api-key-from-step-1>

# --- LLM: option A — InsForge AI (OpenAI-compatible gateway) ---
npx @insforge/cli secrets add LLM_PROVIDER        insforge
npx @insforge/cli secrets add INSFORGE_AI_BASE_URL https://<app>.<region>.insforge.app/api/ai/v1
npx @insforge/cli secrets add INSFORGE_AI_KEY      <ai-gateway-key>
npx @insforge/cli secrets add INSFORGE_AI_MODEL    anthropic/claude-sonnet-4.5

# --- LLM: option B — Anthropic direct ---
# npx @insforge/cli secrets add LLM_PROVIDER      anthropic
# npx @insforge/cli secrets add ANTHROPIC_API_KEY sk-ant-...

# --- Voice: keep sim until you're ready for real calls ---
npx @insforge/cli secrets add VOICE_PROVIDER sim
# later, to go live (step 6):
# npx @insforge/cli secrets add VOICE_PROVIDER       vapi
# npx @insforge/cli secrets add VAPI_API_KEY         <vapi-key>
# npx @insforge/cli secrets add VAPI_PHONE_NUMBER_ID <vapi-phone-id>
```

> **[TO-VERIFY]** AI gateway base URL. Current InsForge guidance may instead have
> you call OpenRouter directly (`https://openrouter.ai/api/v1`) with an
> `OPENROUTER_API_KEY` from `npx @insforge/cli ai setup`. `llmOpenAICompat.ts` is
> OpenAI-compatible, so point `INSFORGE_AI_BASE_URL` at whichever gateway your
> project actually serves and set the matching key. Confirm with the InsForge
> dashboard → Model Gateway.

Full variable list (from `backend/.env.example` / ARCHITECTURE §10):
`LLM_PROVIDER, ANTHROPIC_API_KEY, INSFORGE_AI_BASE_URL, INSFORGE_AI_KEY,
INSFORGE_AI_MODEL, DB_PROVIDER, INSFORGE_BASE_URL, INSFORGE_API_KEY,
VOICE_PROVIDER, VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, PORT`.

---

## 4. Bundle + deploy the edge function

The CLI uploads a single file, so bundle first (see
`insforge/functions/README.md` for the why):

```bash
npx esbuild insforge/functions/donna.ts \
  --bundle --format=esm --platform=neutral \
  --external:node:* --external:npm:* \
  --outfile=insforge/functions/dist/donna.bundle.js

npx @insforge/cli functions deploy donna \
  --file insforge/functions/dist/donna.bundle.js \
  --name "Donna API" \
  --description "Donna dispatch API (ARCHITECTURE §9)"

npx @insforge/cli functions list          # confirm status: active
```

The `donna` function serves **all** §9 routes (it delegates to the Hono `app`),
including `POST /api/vapi/webhook`.

> **[UNTESTED]** the bundle + Deno-runtime execution. Likely follow-ups if it
> errors on first deploy: (a) `process.env` not populated — the `bootstrapEnv()`
> shim in `donna.ts` handles this, but verify it runs; (b) a transitive Node
> built-in that isn't node-compat-safe surfaces from `server.ts`/adapters — keep
> such imports behind the `DB_PROVIDER=insforge` lazy path; (c) Hono needs to be
> importable as `npm:hono` under Deno.

Smoke the deployed function directly:

```bash
curl https://<app>.<region>.insforge.app/functions/donna/api/health
# expect {"ok":true,"mode":{"llm":"insforge","db":"insforge","voice":"sim"}}
```

> **[TO-VERIFY]** the public invoke prefix (`/functions/donna/...` vs
> `/api/functions/donna/...`). The handler's `normaliseUrl()` accepts both; use
> whichever your `functions list` / dashboard reports.

---

## 5. Point the frontend / API consumer at live mode

The backend can also run **locally against InsForge** (skip the function deploy
entirely) — just export the same env vars and `npm run dev` in `backend/`:

```bash
DB_PROVIDER=insforge \
INSFORGE_BASE_URL=https://<app>.<region>.insforge.app \
INSFORGE_API_KEY=<admin-key> \
LLM_PROVIDER=insforge \
INSFORGE_AI_BASE_URL=https://<app>.<region>.insforge.app/api/ai/v1 \
INSFORGE_AI_KEY=<ai-key> \
npm --prefix backend run dev
```

This is the **recommended way to validate live mode first** — same code path as
the function, but with local logs and a debugger, before trusting the Deno
bundle. The frontend proxy (`/api` → `:8787`) is unchanged.

---

## 6. Go live on voice (VAPI) — optional

1. In VAPI, note your API key and `phoneNumberId`.
2. Set the webhook (VAPI calls this `serverUrl`) to the deployed function's
   webhook route:
   ```
   https://<app>.<region>.insforge.app/functions/donna/api/vapi/webhook
   ```
   Set it on the assistant or account level per your VAPI config.
   **[TO-VERIFY]** exact public prefix (see step 4).
3. Flip the secrets and redeploy is **not** needed for secrets — the function
   reads them at runtime — but set them before the next invocation:
   ```bash
   npx @insforge/cli secrets add VOICE_PROVIDER       vapi
   npx @insforge/cli secrets add VAPI_API_KEY         <vapi-key>
   npx @insforge/cli secrets add VAPI_PHONE_NUMBER_ID <vapi-phone-id>
   ```
4. `vapi.ts` (WP-D) owns the outbound-call payload and the `parseWebhook`
   normalisation. In live mode `placeCall` returns a promise resolved by the
   webhook (90 s timeout ⇒ `no_answer`). Confirm the current VAPI
   end-of-call-report payload shape at build time — all VAPI specifics live in
   `backend/src/core/voice/vapi.ts`.

> **Cost/safety:** real calls dial real numbers. The seed phones are fake
> (`+1 415 555 01xx`); replace with numbers you control before dispatching, or
> keep `VOICE_PROVIDER=sim`.

---

## 7. Smoke-test checklist

Run against the live base URL (function or local-backend-on-InsForge). Mirrors
ARCHITECTURE §15 integration script.

- [ ] `GET /api/health` → `mode.db == "insforge"` (+ expected llm/voice).
- [ ] `GET /api/recipients` → 15 recipients, names match §11 / seed file.
- [ ] `GET /api/config` → weights = DEFAULT_WEIGHTS, autopilot false.
- [ ] `POST /api/demo/canned` → donation with **3 items** (strawberries 5000 lb /
      beans 200 lb / bread 80 lb); returns enriched rankings; completes quickly.
- [ ] `POST /api/donations/:id/dispatch` → resolves: strawberries **matched** to
      a walk-in-fridge recipient, bread **unplaceable**, `donorMessage` mentions
      all three items.
- [ ] `POST /api/manager/chat` `{ "message": "St. Mary's just got a new walk-in
      freezer" }` → St. Mary's `infrastructure` gains a freezer (verify in DB:
      `SELECT infrastructure FROM recipients WHERE name LIKE 'St. Mary%';`).
- [ ] Re-rank a refrigerated item → St. Mary's now viable where it wasn't.
- [ ] `GET /api/equity/simulate?drops=30` → deterministic (`donnaGini <
      nearestGini`); re-running gives identical numbers (seeded PRNG).
- [ ] `POST /api/demo/reset` → recipients/config restored to seed values.
- [ ] (VAPI only) trigger a dispatch to a number you control → VAPI places the
      call → end-of-call webhook hits `/api/vapi/webhook` → attempt recorded with
      the real transcript, `simulated:false`.

---

## 8. What is honestly untested

| Area | Status |
|------|--------|
| `schema.sql` DDL + seeds | Written to current InsForge Postgres conventions. **[UNTESTED]** against a live `db query` apply. |
| `insforgeStore.ts` REST/SDK wiring | Owned by **WP-B**; must implement the §5 interface over `@insforge/sdk`. WP-H only provides the schema it targets. |
| Edge function bundle + Deno execution | Wrapper written to the documented Deno-Subhosting contract. **[UNTESTED]** end-to-end; see step 4 caveats. |
| Function invoke path prefix | **[TO-VERIFY]** — handler is defensive; confirm the real prefix. |
| AI gateway base URL | **[TO-VERIFY]** — `/api/ai/v1` (ARCHITECTURE) vs OpenRouter-direct (current InsForge guidance). |
| VAPI webhook shape | Owned by **WP-D** (`vapi.ts`); verify current payload at build time. |
| RLS | Intentionally **off** (admin-key writes). Turn on the commented block in `schema.sql` only if exposing tables to anon clients. |

The keyless mock demo is the source of truth for the stage; treat live mode as a
"flip the env vars and verify against this checklist" exercise, not a
guaranteed-green path.
