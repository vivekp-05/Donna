# Donna

**An autonomous dispatcher for food-bank donations.**

Food comes in through any channel → an AI agent structures it → a transparent
scoring engine matches each item to the fairest capable recipient using
persistent memory → voice agents make the calls → the donor always hears back →
the manager tunes it all by chatting.

Built for the AI Supply Chain Hackathon.

## The idea in one line
**AI at the edges, deterministic fairness math in the middle** — so allocation is
fast *and* explainable *and* provably equitable over time.

## Stack
- **VAPI + Twilio** — real-time voice (inbound donor intake + outbound offers)
- **Gemini 2.5 Flash** — agent brains (intake parsing, offers, manager chat,
  donor callback) *and* the model that talks on the phone. Transcription is
  Deepgram, VAPI's default
- **Deterministic scoring engine** — the auditable core that picks recipients.
  No LLM touches the allocation decision
- **JSON store** behind a pluggable `MemoryStore` interface — a food bank points
  it at their own database by implementing one class
- *(InsForge code paths exist but are inert — see PRD §11 for why)*

## The agents
1. **Intake Parser** — any channel → structured, multi-item donation
2. **Offer Drafter** — writes the pitch / call script
3. **Recipient Caller** — voice-calls pantries *and* community-agency leads
4. **Manager Copilot** — manager tunes the system by chatting
5. **Donor Callback** — itemized "here's what we could and couldn't take"

Plus a deterministic **Scoring Engine** (feasibility · cold-chain · capacity ·
equity · preferences) and **persistent recipient memory** that learns from every
call.

## Run it

**Everything runs in mock mode by default — zero API keys, zero network calls.**
The full canned demo scenario works entirely offline.

### One command

```bash
./scripts/demo.sh
```

This installs deps if needed, boots the backend (`:8787`) and the Vite frontend
(`:5173`), waits for the backend health check, and opens the browser. Press
`Ctrl-C` to stop both. In the UI, click **▶ Canned demo** to run the scenario:
strawberries land at a walk-in-fridge pantry, canned beans go to a small agency,
day-old bread finds no home (partial placement), and the donor gets an itemized
callback.

### Manual (two terminals)

```bash
# terminal 1 — backend (Hono API on :8787). Entry is src/main.ts, not server.ts:
# server.ts is runtime-neutral so the Cloudflare Worker can share it.
cd backend && npm install && npm run dev

# terminal 2 — frontend (Vite dev server on :5173, proxies /api → :8787)
cd frontend && npm install && npm run dev
```

To run the backend the way it runs in production — on the Workers runtime with a
local D1 instead of the JSON file:

```bash
cd backend
npx wrangler d1 execute donna --local --file=d1/schema.sql   # once
npm run cf:dev                                                # workerd on :8787
```

Open <http://localhost:5173>.

### Verify without the UI

```bash
cd backend && npm test            # 166 unit/integration tests, all mock-mode
npm run build                     # backend tsc → dist/
npm run typecheck:worker          # the Workers program (separate tsconfig)
cd ../frontend && npm run build   # tsc + vite build
```

Quick end-to-end smoke via the API:

```bash
curl -s localhost:8787/api/health
curl -s -XPOST localhost:8787/api/demo/canned            # parse 3 items
curl -s -XPOST localhost:8787/api/donations/<id>/approve  # human gate → dispatch (202)
curl -s "localhost:8787/api/equity/simulate?drops=30"    # donna gini < nearest gini
```

### Live mode (optional — flip env vars)

Mock adapters sit behind interfaces; live mode is a pure env-var flip. Copy
`backend/.env.example` to `backend/.env` and set only what you need:

| Capability | Env flip | Extra vars |
|---|---|---|
| **LLM** (real agents) | `LLM_PROVIDER=gemini` | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| | `LLM_PROVIDER=anthropic` | `ANTHROPIC_API_KEY` |
| | ~~`LLM_PROVIDER=insforge`~~ | dead — the gateway 404s, see PRD §11 |
| **Database** | `DB_PROVIDER=json` (default) | none — file on disk |
| | `DB_PROVIDER=d1` | Cloudflare only; D1 is a binding, not an env var |
| **Voice** (real calls) | `VOICE_PROVIDER=vapi` | `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `PUBLIC_WEBHOOK_URL`, `VAPI_WEBHOOK_SECRET` |

> **`PUBLIC_WEBHOOK_URL` is required for live calls.** It is where VAPI posts the
> call report, and the report is the ONLY thing that resolves a call. Unset, a
> call still rings and a human still answers — and the outcome is dropped, then
> swept to `no_answer` a few minutes later regardless of what they said.
>
> Locally that means your own tunnel (`ngrok http 8787`, or a Cloudflare Tunnel).
> Two people cannot share one: whichever URL is on the assistant gets the
> webhooks. `LIVE_CALL_PHONE_OVERRIDE` should be set to your own number for any
> live test — the seeded pantry numbers are fake but not guaranteed unrouted.

Any unset provider stays on its mock/sim implementation, so you can flip one axis
at a time.

> `docs/INSFORGE_SETUP.md` is **stale** — InsForge is not used (PRD §11).

## Deployed

| Piece | Where | Notes |
|---|---|---|
| API + agents + scoring | **Cloudflare Worker** — <https://api.vivek-patel.com> | `backend/wrangler.toml`; `npm run cf:deploy` |
| Database | **Cloudflare D1** (`donna`, WNAM) | schema in `backend/d1/schema.sql` |
| Stale-call sweep | Worker cron, every minute | see below |
| Dashboard | **Vercel** — <https://donna-dashboard-brown.vercel.app> | `frontend/vercel.json` rewrites `/api/*` → the Worker |

Nothing runs on a laptop. A call is Twilio → VAPI → Cloudflare → D1, and the
dashboard only needs a browser.

**Why the dashboard proxies `/api` instead of calling the Worker directly:** it
keeps `api.ts` on `BASE='/api'` unchanged from dev, and the browser only ever
talks to one origin, so CORS never applies — otherwise the Worker's allowed-origin
list would need every Vercel preview URL added to it.

**Secrets** live in Cloudflare (`wrangler secret put`), never in the repo:
`VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `GEMINI_API_KEY`, `VAPI_WEBHOOK_SECRET`.
Non-secret config is in `wrangler.toml` under `[vars]`.

**Two things about the Workers runtime that are easy to get wrong:**

- Background work is **cancelled when the response returns** unless handed to
  `c.executionCtx.waitUntil()`. A bare `void somePromise()` in a route will place
  a phone call and then have its database writes killed mid-flight.
- **No timer survives an invocation**, so the per-call timeout that used to catch
  a dropped webhook is a cron trigger (`sweepStaleCalls`) instead. Without it one
  lost webhook strands a donation at `dispatching` forever.

The call flow is a state machine over the store (`core/voice/dispatchMachine.ts`),
not a blocking loop — that is what makes any of the above possible. `approve`
places one call and returns `202`; each webhook decides what happens next.

## → Full spec: [PRD.md](PRD.md)
