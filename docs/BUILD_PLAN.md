# Donna — Build Plan & Agent Work Packages

> Companion to `docs/ARCHITECTURE.md` (the contract). This file defines WHO builds
> WHAT, in what order, and the rules that keep parallel agents from colliding.

## Ground rules for every implementation agent

1. **Read `docs/ARCHITECTURE.md` first.** It wins over any assumption.
2. **Touch only the files you own** (matrix below). Never edit another package's files.
3. **Never edit `package.json`, lockfiles, or tsconfig after scaffold.** If you need a
   dependency that isn't installed, DO NOT add it — list it in your report under
   `depsNeeded` and code as if it exists (the integrator installs & reconciles).
4. **Types come from `core/types.ts` only.** Don't redeclare shared shapes.
5. **Mock mode is sacred.** Your module must work with zero env vars. Live-mode code
   paths must compile but may be unexercised.
6. **Verify before returning:** run `npx tsc --noEmit` in `backend/` (or `frontend/`)
   and your own vitest specs. Report actual results honestly.
7. Match the existing code style; comments only where logic is non-obvious.

## Phases

```
Phase 1  SCAFFOLD   (1 agent, sequential)   — skeleton, types, stubs, deps installed
Phase 2  BUILD      (8 agents, parallel)    — disjoint work packages WP-A..WP-H
Phase 3  INTEGRATE  (1 agent)               — install reported deps, fix drift, e2e green
Phase 4  VERIFY     (3 reviewers, parallel) — adversarial review vs contract + PRD
Phase 5  FIX + SMOKE (1–2 agents)           — apply confirmed findings, final e2e run
```

## Phase 1 — WP-0 Scaffold (sequential; everything depends on it)

Create the full tree from ARCHITECTURE §1 with:
- `backend/package.json` (ESM, scripts: `dev`=tsx watch src/server.ts, `build`=tsc,
  `test`=vitest run, `start`=node dist/server.js) with deps: `hono`,
  `@hono/node-server`, dev: `typescript`, `tsx`, `vitest`, `@types/node`.
- `frontend/` via Vite react-ts template + deps: `leaflet`, `react-leaflet`,
  `recharts`, dev `@types/leaflet`. Vite proxy `/api` → `localhost:8787`.
- `core/types.ts` transcribed **verbatim** from ARCHITECTURE §3.
- Every module file from §1 as a compiling stub: exported functions with correct
  signatures throwing `new Error('NOT_IMPLEMENTED: <module>')` (server routes may
  return 501). `config.ts` fully implemented (env parsing + DEFAULT_WEIGHTS —
  it's trivial and everyone needs it).
- `.env.example` (§10), root `.gitignore` (node_modules, dist, data/db.json, .env),
- `npm install` run in both packages; `tsc --noEmit` green in both; commit nothing.

## Phase 2 — parallel work packages

| WP | Owner scope (ONLY these paths) | Deliverable |
|----|-------------------------------|-------------|
| **A — Scoring** | `backend/src/core/scoring/**`, `backend/test/scoring*.test.ts` | engine, 5 terms, equity math, simulateAB (seeded mulberry32), explain.ts; unit tests for every §4/§15 property |
| **B — Memory & seeds** | `backend/src/core/memory/**`, `backend/src/seed/**`, `backend/test/memory*.test.ts` | MemoryStore iface + jsonStore (debounced persist, seed-on-empty, reset), insforgeStore (compiles keyless), 15 recipients per §11, canned scenario per §12 |
| **C — LLM & language agents** | `backend/src/core/agents/**`, `backend/test/agents*.test.ts` | LlmClient + mock/anthropic/openai-compat impls, extractJson, Agents 1/2/4/5 per §6; mock heuristic parser passes §12 exact expectations; manager patch validation |
| **D — Voice & dispatch loop** | `backend/src/core/voice/**`, `backend/test/voice*.test.ts` | caller.ts dispatchItem loop (§7.1), simulator persona (§7.2, deterministic), vapi.ts live client + webhook normalization (§7.3; consult current VAPI docs) |
| **E — Pipeline** | `backend/src/core/pipeline.ts`, `backend/test/pipeline*.test.ts` | ingestDonation / dispatchDonation / rankItem with injected deps (§8); tests with stubbed deps |
| **F — Server** | `backend/src/server.ts`, `backend/test/server*.test.ts` | all routes §9 wired to pipeline/store/agents, CORS, error envelope, warnings degradation, webhook sink |
| **G — Frontend** | `frontend/src/**`, `frontend/index.html` | full console per §13 — intake, map, decision panel w/ live sliders, transcripts, callback card, equity tab, manager drawer. Must `vite build` clean. Make it genuinely beautiful (dark dispatch-console; this demos on stage) |
| **H — InsForge & live-mode docs** | `insforge/**`, `docs/INSFORGE_SETUP.md` | schema.sql mirroring §3/§5 (+seed inserts), edge-function wrappers, exact live-mode runbook incl. VAPI webhook pointing |

Notes:
- E and F code against stub signatures — contract-first, drift fixed in Phase 3.
- D's vapi.ts: fetch current VAPI API reference (WebFetch https://docs.vapi.ai) —
  do not guess payload shapes from memory; isolate ALL VAPI specifics in that file.
- G may not call the backend at build time; use the §9 contract and typed fetch
  helpers; include a small `src/api.ts` typed client.

## Phase 3 — WP-I Integrate (one strong agent)

1. Install every dep listed in build reports' `depsNeeded` (dedupe).
2. `tsc --noEmit` both packages → fix ALL drift (imports, signatures) — prefer
   fixing call sites to match ARCHITECTURE, not the reverse.
3. `vitest run` → all green.
4. Boot server mock-mode; run the §15 integration script via curl:
   canned → dispatch → assert strawberries matched / bread unplaceable /
   donorMessage present; manager chat freezer update; re-rank shift; equity sim.
5. `vite build` green; spot-check dev server proxy.
6. Write `scripts/demo.sh` (boot both, open browser) + fill README "Run it" section.

## Phase 4 — Verify (parallel, adversarial)

- **R1 Contract & math reviewer:** diff implementation vs ARCHITECTURE §3–§10 line
  by line; re-derive scoring properties; check seeded-PRNG determinism; flag ANY
  silent contract deviation.
- **R2 Demo-script walkthrough:** execute PRD §13 demo beats end-to-end via API
  (and frontend build) — every beat must be reachable; measure canned-path latency (<1s).
- **R3 PRD-completeness critic:** what in PRD v1 scope (§12 real-vs-sim table) is
  missing, stubbed, or dishonestly reported? Also: does mock mode leak any network call?

Findings → structured list with severity; only CONFIRMED findings go to Phase 5.

## Phase 5 — Fix + final smoke

Fixer agent applies confirmed findings (owns whatever files the findings name).
Smoke agent re-runs: tsc ×2, vitest, e2e curl script, vite build → final report
`{green: boolean, evidence}`.

## Report schema (every agent returns)

```json
{ "wp": "A", "status": "done|partial|blocked",
  "filesCreated": [], "filesModified": [],
  "depsNeeded": ["pkg@^ver (backend|frontend)"],
  "checks": { "tsc": "pass|fail: …", "tests": "12 passed|fail: …" },
  "deviations": ["contract deviations, if any, with reason"],
  "notes": "anything the integrator must know" }
```

## Acceptance = PRD §14 success criteria + ARCHITECTURE §15 test bar, all in mock mode with zero keys.
