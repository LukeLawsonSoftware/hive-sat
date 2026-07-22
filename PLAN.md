# HiveSAT Browser Swarm Roadmap

## Summary

HiveSAT will evolve from the current simulated UI into an anonymous, public browser-compute SAT platform built around CaDiCaL WebAssembly, per-job Durable Objects, R2 formula storage, and a credit-free fair scheduler.

Every phase is one independently mergeable branch and PR:

1. Update `main`.
2. Create `codex/hivesat-NN-description`.
3. Implement the phase with tests, documentation, and any append-only Durable Object migration.
4. Merge only after CI passes.
5. Automatically deploy `main`, smoke-test production, then begin the next phase.

Incomplete user-facing behavior remains behind feature flags. The architecture is intentionally conservative because Workers Free permits 100,000 dynamic requests/day and 10 ms CPU per Worker request; Durable Objects and R2 have separate free allowances. Static assets should remain assets-first, while parsing, hashing, SAT solving, and large verification happen in browsers or bounded verifier Durable Objects. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Target Architecture and Interfaces

- Browser runtime:
  - React routes for home, job status, and `/swarm`.
  - An app-level external store controls personal-job solving, swarm participation, WebSockets, browser workers, telemetry, and IndexedDB.
  - One single-threaded CaDiCaL instance per Dedicated Worker; multiple workers provide multicore use without Wasm pthreads or `SharedArrayBuffer`.
  - Web Locks plus `BroadcastChannel` elect one active runtime per browser profile to prevent tabs from oversubscribing the device.

- Cloudflare runtime:
  - The stateless Worker handles `/api/v1/*`, Turnstile, validation, token checks, streaming R2 transfers, and routing.
  - `JobCoordinatorDO`: one SQLite-backed object per job; owns task state, leases, cube coverage, aggregate status, WebSockets, and expiry.
  - `SwarmDirectoryDO`: one lightweight directory for admission and equal-service job selection. It never handles solver heartbeats or task queues and remains shard-ready.
  - `ResultVerifierDO`: one short-lived object per bounded SAT/proof verification so expensive checking never blocks job coordination.
  - R2 Standard stores compressed formulas, models, and proof artifacts; all are deleted after 24 hours.
  - Hibernating WebSockets, attachments, auto-responses, and sparse messages are mandatory. [Cloudflare WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

- Public HTTP surface:
  - `POST /api/v1/jobs`: validate Turnstile and metadata; return `jobId`, one-use upload token, owner token, and expiry.
  - `PUT /api/v1/jobs/{jobId}/formula`: stream the compressed canonical formula into R2.
  - `GET /api/v1/jobs/{jobId}`: public aggregate status without owner secrets.
  - `POST /api/v1/jobs/{jobId}/cancel`: owner-token protected.
  - `GET /api/v1/jobs/{jobId}/socket`: lease-scoped Job Coordinator WebSocket.
  - `GET /api/v1/swarm/socket`: Swarm Directory assignment WebSocket.
  - `GET /api/v1/artifacts/{artifactId}`: lease-, owner-, or public-result-authorized streaming download.

- Versioned shared contracts:
  - `HiveCnfV1`, `JobState`, `TaskState`, `CubeTask`, `WorkerCapabilities`, `Lease`, `ResultManifest`, `ProofManifest`, and `SwarmSnapshot`.
  - JSON control messages use discriminated unions and runtime validation; large payloads live in R2.
  - Every message includes `protocolVersion`, `messageId`, `jobId`, and applicable `taskId`/`leaseId`.
  - Unsupported clients receive `UPGRADE_REQUIRED`; duplicate messages and results are idempotent.

- State semantics:
  - Jobs: `UPLOADING → QUEUED → RUNNING → SAT_VERIFIED | UNSAT_CERTIFIED | UNSAT_OWNER_VERIFIED | UNKNOWN`, plus cancellation, invalidation, and expiry.
  - Tasks: `READY → LEASED → SPLIT | SAT_CANDIDATE | UNSAT_CANDIDATE | YIELDED`, followed by verification/certification where applicable.
  - Replicated UNSAT is never presented as definitive. Until a proof is checked, it remains `UNSAT_CANDIDATE` or ultimately `UNKNOWN`.

## Delivery Phases

### Phase 1 — Engineering and Cloudflare foundation

Branch: `codex/hivesat-01-foundation`

- Pin Node 24 across local development and CI, fix the current jsdom/localStorage mismatch, and retain the existing lint/type/build baseline.
- Replace the hand-written Worker `Env` with committed `wrangler types` output and a CI drift check.
- Add `nodejs_compat`, structured log/trace sampling, explicit `/api/*` assets-first routing, production feature flags, and append-only SQLite migration conventions.
- Add separate JSDOM, Workers-runtime, and browser-E2E test configurations.
- Split the monolithic UI into an app shell with home, job, and `/swarm` route placeholders.
- Extend CI so a successful merge to `main` deploys automatically using protected Cloudflare secrets.

Exit gate: existing behavior remains unchanged, all test environments run, Wrangler dry-run succeeds, and a feature-flagged production deployment is verified.

### Phase 2 — CaDiCaL WebAssembly feasibility gate

Branch: `codex/hivesat-02-cadical-wasm`

- Pin CaDiCaL 3.0.1 and an Emscripten version, including source checksums and MIT license notices.
- Build a single-threaded ES-module Wasm artifact behind a HiveSAT C ABI for batched clause loading, assumptions, bounded solve, interrupt, model extraction, metrics, lookahead, and LRAT tracing.
- Check in the reproducible Wasm artifact and build scripts; CI rebuilds it and compares checksums.
- Validate repeated conflict-bounded solving, cancellation latency, model extraction, `lookahead()` splitting, memory growth, and at least one externally checked proof in current Chrome, Firefox, Safari, and Edge.
- Avoid generic IPASIR as the complete interface because it does not standardize budgets, proof output, metrics, or cubing. [CaDiCaL source/API](https://github.com/arminbiere/cadical), [IPASIR interface](https://satcompetition.github.io/2021/track_incremental.html), [Emscripten pthread requirements](https://emscripten.org/docs/porting/pthreads.html).

Exit gate: all required capabilities work without Wasm pthreads. If portability, resumable budgets, cube semantics, or proof output fails, stop and re-plan before defining the distributed protocol.

### Phase 3 — Formula pipeline and real browser solving

Branch: `codex/hivesat-03-formula-runtime`

- Implement strict DIMACS parsing in a browser worker with useful line/offset errors, progress, cancellation, and decompression-bomb limits.
- Define `HiveCnfV1`: deterministic little-endian integer encoding preserving parsed clause order, with SHA-256 over the uncompressed encoding and gzip for transfer.
- Enforce 5 MiB compressed, 32 MiB encoded, and two million literal-occurrence limits.
- Cache verified formulas by hash in IndexedDB and transfer typed arrays to solver workers in batches.
- Replace filename-derived mock verdicts with real bounded CaDiCaL solving and an independent TypeScript model verifier.
- Add brute-force differential tests for random small formulas and known SAT/UNSAT fixtures.

Exit gate: the browser correctly parses, solves, cancels, resumes, and verifies representative formulas without server computation.

### Phase 4 — Public job submission and storage

Branch: `codex/hivesat-04-job-platform`

- Add anonymous device IDs, Turnstile-protected job creation, unguessable job IDs, and cryptographic owner/upload tokens. Store only token digests server-side.
- Store the owner token in IndexedDB and an owner-only URL fragment; public share links exclude it.
- Stream formulas to job-scoped R2 keys and verify their declared hash in every solver browser after download.
- Create `JobCoordinatorDO` and `SwarmDirectoryDO` SQLite schemas, root-task initialization, public status reads, cancellation, and 24-hour alarms.
- Enforce one active job and three creations per rolling day per device/network digest, plus a configurable global active-job ceiling.
- Require explicit consent that every submitted formula is public to swarm participants; there is no private or local-only job mode.

Exit gate: a valid public formula can be created, uploaded, inspected, cancelled, expired, and safely deleted without buffering it in the Worker.

### Phase 5 — Leasing and coordinator protocol

Branch: `codex/hivesat-05-leasing`

- Implement hibernating Job Coordinator WebSockets and versioned `HELLO`, `REQUEST_WORK`, `HEARTBEAT`, `SPLIT`, `YIELD`, `RESULT`, and cancellation messages.
- Persist a lease before sending work. Use unpredictable lease IDs, bounded attempts, and atomic task transitions.
- Target roughly ten-minute desktop tasks with 15-minute leases; use 60-second batched heartbeats and persist only authoritative transitions or an exceptional lease extension.
- Consolidate lease recovery and job expiry into the object’s single earliest-deadline alarm.
- Accept valid decisive evidence from stale leases, but reject stale splits and ordinary progress mutations.
- Add socket attachments, reconnect/backoff, duplicate-message handling, and bounded alarm batches.

Exit gate: fault-injection tests cover disconnects, hibernation, expiry, reassignment, duplicated results, stale clients, and coordinator restart.

### Phase 6 — Cube-and-conquer browser runtime

Branch: `codex/hivesat-06-distributed-cubes`

- Add a browser worker pool with conservative defaults: up to two desktop workers and one mobile worker, bounded by user preference and detected capacity.
- Use CaDiCaL `lookahead()` to split only into exact complementary children `C ∧ l` and `C ∧ ¬l`; the coordinator independently validates coverage.
- Use queue watermarks of approximately 1×/3×/8× active workers, a maximum cube depth of 64, and a 10,000-task ceiling.
- When a budget expires without a safe split, yield and restart the cube later; do not migrate CDCL state.
- Give a user’s active job first claim on every local worker. Only workers for which no owner task is ready request public swarm work.
- Cache formulas locally and never send full formulas or proof data through WebSockets.

Exit gate: several browser contexts can solve complementary cubes, recover from churn, avoid duplicate coverage, and terminate early on a verified SAT candidate.

### Phase 7 — Result correctness pipeline

Branch: `codex/hivesat-07-results`

- Encode SAT models as compact bitsets with formula, cube, path, and solver-version metadata.
- Verify final SAT models independently inside a `ResultVerifierDO`; invalid results quarantine that session and requeue the task.
- Treat browser-reported UNSAT as a candidate only. Require an independent repeated solve before requesting proof production, but never promote consensus alone to final UNSAT.
- Propagate task completion through the tree only when complementary coverage is intact.
- Define invalid-formula, invalid-model, verification-timeout, exhausted-budget, and conflicting-result behavior explicitly.
- Track session reliability only for lease sizing and abuse containment; it never affects job priority.

Exit gate: no malformed, stale, incomplete, or unverified result can produce a terminal job verdict.

### Phase 8 — Public swarm and equal-service scheduling

Branch: `codex/hivesat-08-public-swarm`

- Connect opted-in browsers to `SwarmDirectoryDO`, assign a job, then move the browser to that job’s coordinator so only one DO socket is active.
- Schedule the active job with the lowest equal-weight virtual worker runtime. New jobs enter at the current minimum so they receive service without monopolizing the swarm.
- Reconcile reserved versus actual active worker time; use hour-scale assignment quanta to avoid excessive WebSocket handshakes.
- Use capability calibration for task sizing and lease length, not priority.
- Apply aging and a per-job concurrency ceiling so all eligible jobs progress; no credits, contribution register, paid priority, or long-term contributor advantage.
- Allow non-contributors to submit and receive the same public scheduling weight as contributors.

Exit gate: deterministic simulations demonstrate bounded fairness under unequal task durations, worker churn, new-job arrival, and heterogeneous devices.

### Phase 9 — Real Swarm Mode experience

Branch: `codex/hivesat-09-swarm-ui`

- Build `/swarm` as a scoped dark, moody dashboard using the existing lime/amber HiveSAT visual language.
- Default contribution to paused. Public work runs only while `/swarm` is active; “pause when hidden” defaults on.
- Provide start/pause, maximum worker count, visibility policy, and clear unsupported/throttled/reconnecting/no-work states.
- Show:
  - current task and connection state;
  - active worker count and configured capacity;
  - active compute time and throughput;
  - conflicts, decisions, propagations, and cubes accepted;
  - unique jobs helped;
  - decisive verified SAT or certified UNSAT contributions;
  - formula bytes transferred;
  - Wasm linear-memory current and high-water values;
  - global active jobs/workers and a bounded rolling activity graph.
- Persist session and device-lifetime totals in IndexedDB with a reset action.
- Label CPU and memory honestly: configured worker share, active compute time, and Wasm allocation—not unavailable OS-level CPU or process-memory claims.
- Use aggregate statistics only; omit the search-tree visualization.

Exit gate: responsive and accessible behavior is verified on modern desktop browsers, with a one-worker mobile fallback and reduced-motion support.

### Phase 10 — Proof-carrying UNSAT

Branch: `codex/hivesat-10-unsat-proofs`

- Reassign an UNSAT candidate to a fresh proof-finisher CaDiCaL instance with tracing enabled before clauses are loaded.
- Produce gzip-compressed LRAT for `F ∧ cube`, with a manifest binding the proof to the formula hash, cube assumptions, path hash, clause IDs, solver version, and artifact hash.
- Stream proofs to R2 under lease-scoped upload tokens. Cap each job at 32 MiB compressed and 128 MiB decompressed proof data; split further or return `UNKNOWN` when exceeded.
- Pin and compile the independent MIT-licensed `lrat-check.c` checker from DRAT-trim for browser and bounded Durable Object use. [DRAT-trim/LRAT checker](https://github.com/marijnheule/drat-trim).
- Server-certify small proofs within conservative verifier limits. Larger allowed proofs are checked in the owner’s browser:
  - successful local checks produce `UNSAT_OWNER_VERIFIED`;
  - public status distinguishes this from server-side `UNSAT_CERTIFIED`;
  - certificates remain downloadable for independent checking.
- Verify every certified leaf and complementary split before propagating UNSAT to the root. Oversized, timed-out, missing, or invalid proofs result in `UNKNOWN`, never UNSAT.

Exit gate: known UNSAT formulas complete only with valid proof coverage; proof corruption, omitted branches, checker timeout, and proof-size overflow all fail closed.

### Phase 11 — Security, cost, and launch hardening

Branch: `codex/hivesat-11-launch-hardening`

- Fuzz DIMACS, decompression, WebSocket, API, model, and proof parsers; enforce message, assumption, task, upload, and artifact limits.
- Add session quarantine, Turnstile replay prevention, HMACed network identifiers, token rotation, CSP/security headers, and structured error responses.
- Load-test several hundred intermittent clients with realistic 60-second heartbeats and long task leases; verify DO request, duration, row-write, and R2-operation projections remain below configurable safety margins.
- Add admission and swarm kill switches, maximum active connections/jobs, exponential client backoff, quota dashboards, and operator runbooks.
- Test expiry and R2 cleanup, schema migration, rolling deployment, older-client rejection, and recovery from partial deployment.
- Remove simulation copy, enable the public swarm flag, publish privacy/trust limitations, and perform the final production smoke test.

Exit gate: production remains usable when quotas are approached, malicious clients cannot forge terminal results, and all retained artifacts disappear after 24 hours.

## Test and Acceptance Strategy

- Every PR must pass lint, type-check, unit tests, JSDOM tests, Workers-runtime tests, production build, Wasm reproducibility checks where applicable, and Wrangler dry-run.
- Parser and solver tests include randomized small formulas compared with brute force, known benchmark fixtures, malformed DIMACS, cancellations, repeated assumptions, and out-of-memory handling.
- Durable Object tests cover schema isolation, atomic splits, alarms, hibernation, late messages, duplicate delivery, lease expiry, stale results, and task-tree certification.
- Browser E2E tests use several independent contexts to exercise upload, public participation, cross-tab leader election, churn, SAT early termination, proof-backed UNSAT, local stats, and mobile fallback.
- Fairness tests measure worker-time received per job rather than task count.
- Security tests attempt forged leases, omitted split branches, invalid models/proofs, oversized payloads, decompression bombs, token replay, and excessive reconnects.
- Production rollout remains feature-flagged until the phase-specific exit gate passes after deployment.

## Locked Assumptions and Exclusions

- All submitted server jobs are public to swarm participants; confidential formulas are explicitly unsupported.
- Anonymous device identity plus Turnstile is sufficient; there are no accounts, private cohorts, cross-device history, payments, credits, or contributor-priority rules.
- Users may submit jobs without contributing. Other-user computation is explicit opt-in and runs only on `/swarm`.
- Personal jobs preempt public work on the same device.
- The roadmap stops at a robust proof-capable core. Learned-clause sharing, full solver checkpoints, adaptive portfolio selection, research-grade scheduling, and a full search-tree UI are deferred.
- R2 Standard must be enabled through Cloudflare’s subscription flow, although usage is intended to remain inside the free allowance.
- Free-plan operation is a fail-closed target, not a guarantee: capacity is rejected or work returns `UNKNOWN` instead of silently incurring unsupported behavior or weakening correctness.
