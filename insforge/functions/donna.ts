// ============================================================================
// Donna — InsForge edge-function wrapper  (WP-H, live mode)
// ============================================================================
// InsForge Functions run on Deno Subhosting: a function is a single ESM file
// that `export default`s an async (Request) => Response handler. See
// docs/INSFORGE_SETUP.md for the deploy runbook.
//
// Design: Donna's entire HTTP surface (ARCHITECTURE §9) is already a Hono app
// (`backend/src/server.ts` exports `app`). Hono is edge/Deno-native, so we do
// NOT re-implement the routes here — we bundle the backend and delegate every
// request to `app.fetch(request)`. One function, all routes, zero drift.
//
// ── BUNDLING (required — the CLI uploads ONE file) ──────────────────────────
// The InsForge CLI (`functions deploy --file`) uploads a single source file, so
// this wrapper's `../../backend/src/server.js` import must be inlined first.
// Produce the deployable artifact with esbuild:
//
//   npx esbuild insforge/functions/donna.ts \
//     --bundle --format=esm --platform=neutral \
//     --external:node:* --external:npm:* \
//     --outfile=insforge/functions/dist/donna.bundle.js
//
//   npx @insforge/cli functions deploy donna \
//     --file insforge/functions/dist/donna.bundle.js \
//     --name "Donna API" --description "Donna dispatch API (ARCHITECTURE §9)"
//
// Caveats the bundle must satisfy (see functions/README.md for the full list):
//   * DB_PROVIDER=insforge at runtime  → the json store (node:fs) is imported
//     but never instantiated; keep the createStore() factory lazy.
//   * config.ts reads process.env — Deno's node-compat shim maps Deno.env into
//     process.env, so InsForge function secrets (below) are visible. If a given
//     runtime does NOT populate process.env, uncomment the Deno.env bridge in
//     `bootstrapEnv()` below.  [TO-VERIFY on your InsForge version]
//
// ── REQUIRED FUNCTION SECRETS (set via `npx @insforge/cli secrets add`) ─────
//   DB_PROVIDER=insforge
//   INSFORGE_BASE_URL   (this project's oss_host, e.g. https://<app>.<region>.insforge.app)
//   INSFORGE_API_KEY    (admin api key — insforgeStore writes bypass RLS)
//   LLM_PROVIDER=insforge|anthropic        + the matching AI key(s)
//   INSFORGE_AI_BASE_URL / INSFORGE_AI_KEY / INSFORGE_AI_MODEL   (if LLM_PROVIDER=insforge)
//   ANTHROPIC_API_KEY                                            (if LLM_PROVIDER=anthropic)
//   VOICE_PROVIDER=vapi + VAPI_API_KEY + VAPI_PHONE_NUMBER_ID    (live calls)
// ============================================================================

// NOTE: path is `.js` (ESM/NodeNext resolution); esbuild resolves it to the .ts
// source at bundle time. Until bundled, editors may flag this import — expected.
import { app } from '../../backend/src/server.js';

/**
 * Bridge InsForge/Deno function secrets into process.env if the node-compat
 * layer hasn't already. Safe no-op under Node. config.ts (and every adapter)
 * reads process.env, so this must run before the first request is served.
 * [TO-VERIFY] Some InsForge/Deno versions already mirror Deno.env → process.env;
 * this loop is idempotent and only fills gaps.
 */
function bootstrapEnv(): void {
  // @ts-ignore — Deno global only exists on the function runtime.
  const denoEnv = (typeof Deno !== 'undefined' && Deno?.env) ? Deno.env : undefined;
  if (!denoEnv) return;
  // eslint-disable-next-line no-undef
  const proc = (globalThis as any).process ?? ((globalThis as any).process = { env: {} });
  proc.env ??= {};
  for (const key of [
    'DB_PROVIDER', 'INSFORGE_BASE_URL', 'INSFORGE_API_KEY',
    'LLM_PROVIDER', 'ANTHROPIC_API_KEY',
    'INSFORGE_AI_BASE_URL', 'INSFORGE_AI_KEY', 'INSFORGE_AI_MODEL',
    'VOICE_PROVIDER', 'VAPI_API_KEY', 'VAPI_PHONE_NUMBER_ID',
  ]) {
    const v = denoEnv.get?.(key);
    if (v !== undefined && proc.env[key] === undefined) proc.env[key] = v;
  }
  // Force the DB provider on in the deployed function even if the secret is unset.
  proc.env.DB_PROVIDER ??= 'insforge';
}

/**
 * Normalise the incoming path so Hono (which registers `/api/*`) sees the route
 * regardless of how InsForge prefixes function invocations. Observed patterns:
 *   /functions/donna/api/health         (SDK invoke path)
 *   /api/functions/donna/api/health     (raw HTTP path)
 *   /api/health                         (already normalised)
 * We slice everything up to and including the FIRST `/api/` that is followed by
 * a known Donna route segment. [TO-VERIFY: confirm your runtime's exact prefix
 * and simplify if it always delivers a stable shape.]
 */
function normaliseUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const p = u.pathname;
  // Find the LAST occurrence of "/api/" — Donna's real routes all live under it,
  // and any function-slug prefix appears before it.
  const idx = p.lastIndexOf('/api/');
  if (idx > 0) {
    u.pathname = p.slice(idx); // keep from "/api/..." onward
  }
  return u.toString();
}

let envReady = false;

export default async function handler(request: Request): Promise<Response> {
  if (!envReady) { bootstrapEnv(); envReady = true; }

  // Preflight is also handled by Hono's cors(), but answer here too so the
  // function short-circuits without booting the app for OPTIONS.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const normalisedUrl = normaliseUrl(request.url);
  const forwarded = normalisedUrl === request.url
    ? request
    : new Request(normalisedUrl, request);

  try {
    return await app.fetch(forwarded);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error)?.message ?? 'internal_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
