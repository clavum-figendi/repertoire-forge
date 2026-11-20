# Repertoire Forge: Free Cloudflare backsolve

A working module Worker routes each job to a **SQLite Durable Object**. Real Stockfish 17.1 lite single-thread runs *inside the DO*, not the 10 ms Free HTTP Worker. No external evaluation service, account secret, R2, paid Worker plan, Workflow, cron runner, or browser-held raw archive is used.

## Verified locally

```sh
cd cloud
npm ci
npm run build
npm test
node smoke.mjs  # actual public Lichess HTTP + real Stockfish, not a mock
```

`LIVE-SMOKE.json` records the latest successful live run. The automated suite also exercises SQLite recovery across a complete workerd restart, idempotent PGN uploads, capability checks, CORS, cancellation/deletion, cursor boundary deduplication, graph/card merging, date windows, and matching-game limits. Fixture tests replace only upstream HTTP, never engine results. `npm audit --omit=dev` is clean; local Miniflare's transitive developer dependencies currently have advisories (`npm audit`); none are bundled into the Worker.

## API contract

Only `GET /health`, `POST /jobs`, and CORS preflights are public. Every job route requires `Authorization: Bearer <token>`. Tokens are random 256-bit capabilities, returned once; only a SHA-256 digest is stored. Do not put tokens in URLs or public repositories.

- `GET /health` → `{ok:true, backend:"sqlite-durable-object", engine:..., resumable:true}`. This does not initialize the engine.
- `POST /jobs` → HTTP 201 `{id,token,capability,...state}` (`capability` aliases `token`). Input: `{platform:"lichess"|"pgn",username,minMoves,timeControls,since,until,maxGames,settings}`. Dates are inclusive epoch milliseconds. Omitted `until` freezes the job upper boundary to its creation time. `maxGames:null` means all matching games within quotas; a positive integer caps matches *after* filtering. Lichess usernames are validated. Time controls: bullet/blitz/rapid/classical. `minMoves` means strictly more than `2*N` plies.
- `GET /jobs/:id` → persisted progress/settings/limits, no token.
- `POST /jobs/:id/pgn` JSON `{pgn,uploadId,final}` → current state. At most 256 KiB **total JSON body**, 25 queued main-line games. Use a stable unique uploadId per upload chunk; retries of that ID are idempotent. Split at complete game boundaries, drain the queue with step calls, then upload more. `final:true` closes input. Variations are rejected. For upload length filtering, `maxPly` must exceed `2*minMoves` (or use minMoves 0).
- `POST /jobs/:id/step` (empty body allowed) → `{status,...progress}`. Call serially until **`status:"done"`**. Each request fetches a page, stages one game, or computes at most two fresh node-limited evaluations and checkpoints. No detached/background compute is promised. Disconnecting/reopening the browser does not discard stored progress. Another job occupying the isolate engine causes a nonterminal response with `retryAfterMs:500`; retry later. Concurrent steps for one job return 409. Rate-limited upstream calls return 429; retry with backoff. Other network failures preserve progress and return errors, never fake empty success.
- `GET /jobs/:id/result` → streamed complete app backup `{format:"repertoire-forge",version:1,createdAt,settings,book:null,graph,cards,stats,status,partial}`. No raw archive is included. Restore with the app Export/Restore control. A partial export is available before completion/cancellation. Optional `?cursor=0` exposes 50-row diagnostic pages; those pages alone are **not** complete backups.
- `POST /jobs/:id/cancel` → status `cancelled`, preserved results. Subsequent steps return 409. If a step is active, retry cancellation after its bounded response.
- `DELETE /jobs/:id` → `{deleted:true}`; subsequent reads return 404. All stored content is removed. Jobs also expire seven days after creation.

CORS is restricted to `https://clavum-figendi.github.io` and localhost/127.0.0.1 ports 5173, 4173, 4274. Requests without an Origin work for CLI clients. CORS is **not** creation authorization: anyone reaching this public deployment can create a job; Free quotas are shared account-wide. Add a separate admission policy if making this service available beyond a personal tool.

**Chess.com cloud fetching is deliberately unsupported.** It returns 400 with a PGN-upload alternative. Use native/local Chess.com import or upload exported PGN. No browser UI should offer cloud Chess.com as if implemented.

## Bounded work and honest limits

- Hash = **16 MiB**, Threads = 1. At most 2 new evaluations/request, default 2,000 engine nodes/evaluation, allowed 100–5,000. Requested depth defaults to 10, accepted 4–14. Actual reached depth and nodes are returned; depth 14 is not guaranteed. UCI nodes can overshoot their requested limit by a few nodes.
- Scores are Stockfish's **side-to-move** centipawns or mate distance; lowerbound/upperbound lines are not used as exact scores. Core backsolve compares parent+child scores and preserves the first mistake plus immediate refutation.
- `maxPly` defaults to 40 and is limited to 2–64. Each game is replayed in its own bounded core graph; the cumulative archive never enters the shared core's 200,000-node importer. Pruned nodes/cards merge into indexed SQL rows and provenance lines are retained server-side.
- Theory lookup is disabled (effective `theoryPlies:0` and `theory:false` in status), even when browser settings request theory. No substitute evaluations/theory data are fabricated.
- Lichess requests max 5 records / 256 KiB. The inclusive timestamp cursor deduplicates already-stored boundary game IDs. An ambiguous full page at the same timestamp stops with 409 rather than silently skipping possibly unseen games.
- A conservative per-job logical write safety budget is 20,000; at its safety margin status becomes `error` with an explanation. Export partial results and start another date window. This is not an account-wide quota meter: SQL/index/schema work and other jobs also consume Free allocations. There is no promise of infinite history or CPU. Cloudflare Free quotas can reject work before this application budget.
- Tested live at depth cap 14 / 5,000 nodes: 64 MiB WASM linear memory and individual step wall times recorded in `LIVE-SMOKE.json`. Workerd local timing is **not** production CPU telemetry; verify deployed metrics. Platform default DO CPU is 30 seconds/request and isolate memory is 128 MB. The node/window limits leave substantial headroom in tested runs.

## Engine adaptation

`build.mjs` extracts the actual Emscripten factory from the checked-in browser JS and removes its browser/Node command-line wrapper at build time. Node-specific fs/path reads are inert. The build fails if dynamic `eval(...)` or `new Function` code appears. Static `import wasm from './stockfish.wasm'` supplies a precompiled `WebAssembly.Module`; `instantiateWasm` uses `new WebAssembly.Instance(module, imports)`. No byte compilation or dynamic code generation occurs at request time.

The upstream WASM defines an initial 128 MiB memory, consuming the entire Worker cap before JS. The build validates its exact memory section and changes its minimum/maximum to **64 MiB**. Hash16 plus NNUE work at that cap in the real runtime tests. The patched artifact must be used: **do not substitute `public/engine/*.wasm`**. The module is initialized lazily within a DO request. One engine per isolate is reused under a nonblocking cross-job lock so concurrent objects cannot each reserve another engine.

Stockfish is GPLv3. `dist/COPYING-Stockfish.txt` and `dist/AUTHORS-Stockfish.txt` preserve notices. The engine is derived from nmrugg/stockfish.js v17.1.0 (tag commit `f9512ef9aff391026813a56855dd086cb72a2d58`), https://github.com/nmrugg/stockfish.js/tree/v17.1.0 . Preserve access to its corresponding source/build instructions and this adaptation when distributing binaries.

## Deployment handoff (no deployment performed)

All dependencies are isolated to cloud/. `dist/` is explicitly unignored because the connected API sandbox can fetch immutable GitHub raw files after the parent commits/pushes them. Build manifest contains SHA-256 and byte lengths.

Upload multipart to:

`PUT /accounts/45f1679a19a096da595dc830ac3e53a5/workers/scripts/repertoire-forge-cloud`

**Use the account identifier supplied by the parent session; the account ID above must be checked before use.** No credential is stored here. Required permissions: Workers Scripts edit / Durable Objects creation on the intended account. The account must support Free SQLite DOs and have remaining quotas. Do not enable a paid subscription or alter account plans.

Multipart parts:

1. `metadata`: JSON from `dist/metadata.json` (`application/json`).
2. `worker.js`: `dist/worker.js` (`application/javascript+module`).
3. `stockfish.wasm`: **patched** `dist/stockfish.wasm` (`application/wasm`).

The first-deploy metadata creates the SQLite class with `{migrations:{new_tag:"v1",steps:[{new_sqlite_classes:["BacksolveJob"]}]}}` and binds `JOBS` to class `BacksolveJob`. Compatibility date is 2026-07-30, matching the installed workerd tested runtime. No node compatibility flag is required. No `cpu_ms` paid-plan override is specified. On subsequent deployments to the existing class, omit migrations (or use an explicitly correct migration history), never create legacy KV classes.

The connected OAuth sandbox cannot fetch binary artifacts from GitHub. From a trusted shell with an account-scoped **Workers Scripts Write** token in `CLOUDFLARE_API_TOKEN`, verify the dedicated account shows **Workers Free** in the dashboard, then run from `cloud/`:

```sh
npm ci
npm run build
npm test
node publish.mjs --confirmed-workers-free
```

The publisher checks artifact hashes, verifies the dedicated account subdomain, uploads the real multipart body, and reads back the binding and `workers.dev` route. The flag records a manual plan check; it does not change the plan. The route is public; see the admission and quota caveat above. Verify live `/health` and a one-game job before putting the endpoint into the app.

`deploy-multipart.mjs` exports `makeUpload(immutableRawBase,{existing})` as a tested pure FormData builder. It fetches the three files from `https://raw.githubusercontent.com/clavum-figendi/repertoire-forge/<FULL_COMMIT>/cloud/dist`; it does **not** send any mutation. The connected sandbox can run equivalent code, then use its authorized Cloudflare transport. Do not JSON-encode FormData or manually set a boundary. Enable the Worker workers.dev subdomain separately if needed and read back settings/deployment. Then verify `/health`, a capability-protected live one-game job, completion/result, and delete.

Current authoritative docs were fetched directly, including Cloudflare's production docs source:

- https://developers.cloudflare.com/durable-objects/platform/limits/ — default 30-second DO CPU.
- https://developers.cloudflare.com/workers/platform/limits/ — **64 MiB uncompressed Worker size on Free and Paid, no compressed-size limit**, 128 MB isolate memory. The old 3 MB Free gzip limit is not what the retrieved current page says.
- https://developers.cloudflare.com/workers/runtime-apis/webassembly/ — static Wasm usage, no threading.
- https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ — SQLite class migration.
- API metadata schema verified against https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/scripts.ts .
