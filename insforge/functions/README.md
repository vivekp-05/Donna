# Donna InsForge Functions

Live-mode edge functions (WP-H). Owned by `insforge/**`. Not exercised in v1 CI —
these compile and are documented honestly; treat runtime as **verify-on-deploy**.

## What's here

| File | Role |
|------|------|
| `donna.ts` | Single edge function that delegates every ARCHITECTURE §9 route to the backend Hono `app` (`backend/src/server.ts`). Deployed as one function named `donna`. |
| `dist/` | Bundle output (gitignored). Produced by esbuild — see below. |

There is **one** function, not one-per-route: Donna's whole HTTP surface is
already a single Hono app, and Hono is Deno/edge-native. Re-implementing 14
routes as 14 functions would duplicate logic and invite drift. `donna.ts` just
runs `app.fetch(request)`.

## Platform shape (researched — current InsForge)

Confirmed against the InsForge skill docs + `docs.insforge.dev`:

- **Runtime:** Deno Subhosting. A function is one ESM file exporting
  `export default async (req: Request) => Response`. Env via `Deno.env.get()`.
- **Deploy:** `npx @insforge/cli functions deploy <slug> --file <path>`
  (creates on first deploy, updates thereafter). The CLI uploads **one file** →
  bundling is mandatory for our multi-module import.
- **Invoke:** SDK `insforge.functions.invoke('donna', { method, body })` →
  hits `/functions/donna`. Raw HTTP: `POST /api/functions/donna` (GET/PUT/…
  variants supported). **[TO-VERIFY]** the exact path the runtime hands the
  handler — `donna.ts::normaliseUrl()` is defensive about the prefix.
- **Database REST:** PostgREST-style; the `insforgeStore` (WP-B) talks to it via
  `@insforge/sdk` `createAdminClient({ baseUrl, apiKey })`. Raw paths are
  PostgREST-style (`/api/database/...` / `/api/records`) — **[TO-VERIFY]** exact
  base; prefer the SDK so the path is the SDK's concern, not ours.
- **AI gateway:** InsForge exposes an **OpenAI-compatible** Model Gateway. Two
  shapes exist in the wild — pick per your project:
  - Newer guidance: call OpenRouter directly at
    `https://openrouter.ai/api/v1/chat/completions` with the project's
    provisioned `OPENROUTER_API_KEY` (`npx @insforge/cli ai setup`).
  - ARCHITECTURE §10 matrix: `INSFORGE_AI_BASE_URL` =
    `https://<project>.insforge.app/api/ai/v1` + `INSFORGE_AI_KEY`, model
    `anthropic/claude-sonnet-4.5`.
  `llmOpenAICompat.ts` (WP-C) is OpenAI-compatible, so it works against either —
  just set `INSFORGE_AI_BASE_URL` to whichever gateway you use.
  **[TO-VERIFY]** which base your specific InsForge project serves.

## Bundling step (required)

```bash
# from repo root
npx esbuild insforge/functions/donna.ts \
  --bundle --format=esm --platform=neutral \
  --external:node:* --external:npm:* \
  --outfile=insforge/functions/dist/donna.bundle.js
```

Notes:
- `--format=esm` — Deno wants ESM.
- `--external:node:*` — keep `node:fs` / `node:url` (used by `jsonStore.ts` and
  `server.ts`) as Deno node-compat imports rather than trying to inline them.
  The json store is imported by the `createStore()` factory but **never
  instantiated** when `DB_PROVIDER=insforge`, so `node:fs` is never called.
- `--external:npm:*` — `@insforge/sdk` (and Hono, if you install it as `npm:`)
  resolve through Deno's npm compatibility at runtime.
- `esbuild` is a **dev dependency to add** (`depsNeeded`) — the integrator
  installs it; do not edit package.json here.

If your InsForge/Deno runtime does **not** mirror `Deno.env` into `process.env`
(config.ts reads `process.env`), the `bootstrapEnv()` shim in `donna.ts` copies
the needed secrets across on first request. **[TO-VERIFY]** on your version;
it's an idempotent no-op if the runtime already bridges them.

## Deploy

```bash
npx @insforge/cli functions deploy donna \
  --file insforge/functions/dist/donna.bundle.js \
  --name "Donna API" \
  --description "Donna dispatch API (ARCHITECTURE §9)"

npx @insforge/cli functions list   # confirm status: active
```

Full end-to-end runbook (project create → schema → secrets → deploy → VAPI
webhook → env flip → smoke test): see **`docs/INSFORGE_SETUP.md`**.

## The VAPI webhook

`POST /api/vapi/webhook` is just another Hono route inside `app`, so it ships
with the `donna` function automatically. Point VAPI's `serverUrl` at the
function's public webhook URL — e.g.
`https://<app>.<region>.insforge.app/functions/donna/api/vapi/webhook`
(**[TO-VERIFY]** exact public prefix for your runtime; the handler normalises
the path so both `/functions/donna/api/...` and `/api/functions/donna/api/...`
reach the route). See the setup doc for the exact string and how to flip
`VOICE_PROVIDER=vapi`.
