# HiveSAT Browser Swarm Roadmap

## Summary

HiveSAT will evolve from the current simulated UI into an anonymous, public browser-compute SAT platform built around CaDiCaL WebAssembly, per-job Durable Objects, R2 formula storage, and a credit-free fair scheduler.

Every phase is one independently mergeable branch and PR:

1. Update `main`.
2. Create `codex/hivesat-NN-description`.
3. Implement the phase with tests, documentation, and any append-only Durable Object migration.
4. Merge only after CI passes.
5. Let the connected Cloudflare project automatically deploy `main`, smoke-test production, then begin the next phase.

Phases 6–11 in this implementation run use a stacked-branch delivery override:
each phase starts from the immediately preceding phase branch.
No additional pull requests are created; the stack is left for manual
integration in reverse order.

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

- [x] Pin Node 24 across local development and CI, fix the current jsdom/localStorage mismatch, and retain the existing lint/type/build baseline. Local pins live in `.nvmrc`, `.node-version`, and `package.json`; JSDOM uses an explicit non-opaque origin.
- [x] Replace the hand-written Worker `Env` with committed `wrangler types` output and a CI drift check (`pnpm wrangler:types:check`).
- [x] Add `nodejs_compat`, structured log/trace sampling, explicit `/api/*` assets-first routing, production feature flags, and append-only SQLite migration conventions. The convention is documented in `docs/durable-object-migrations.md` before the first namespace is introduced.
- [x] Add separate JSDOM, Workers-runtime, and browser-E2E test configurations using Vitest, Cloudflare's Workers pool, and Playwright respectively.
- [x] Split the monolithic UI into an app shell with home, job, and `/swarm` route placeholders. Public job and swarm functionality remains clearly disabled.
- [x] Extend CI with the Phase 1 validation gates. The existing Cloudflare Git integration—not GitHub Actions—owns automatic production deployment after a successful merge to `main`.

Phase 1 implementation note: GitHub Actions intentionally has no production deployment job or Cloudflare secrets. Production deployment is configured in Cloudflare against `main` and should be verified through that integration after merge.

Exit gate: existing behavior remains unchanged, all test environments run, Wrangler dry-run succeeds, and a feature-flagged production deployment is verified.

### Phase 2 — CaDiCaL WebAssembly feasibility gate

Branch: `codex/hivesat-02-cadical-wasm`

- [x] Pin CaDiCaL 3.0.1 and Emscripten 4.0.10, including source checksums and MIT license notices. The lock is `solver/versions.env`; notices are in `solver/THIRD_PARTY_NOTICES.md`.
- [x] Build a single-threaded ES-module Wasm artifact behind a HiveSAT C ABI for batched clause loading, assumptions, bounded solve, interrupt, model extraction, metrics, lookahead, and LRAT tracing. The artifact verifier rejects imported memory, pthread glue, and pthread worker output.
- [x] Check in the reproducible Wasm artifact and build scripts; CI rebuilds it and byte-compares both generated files after checking their committed checksums.
- [x] Validate repeated conflict-bounded solving, cancellation latency, model extraction, `lookahead()` splitting, memory growth, and an externally checked generated proof in current Chrome, Firefox, Safari-compatible WebKit, and Edge. CI owns all four browser projects; Safari itself remains a post-deploy manual smoke test because it has no Playwright channel.
- [x] Avoid generic IPASIR as the complete interface because it does not standardize budgets, proof output, metrics, or cubing. The committed HiveSAT ABI explicitly covers each of those feasibility requirements. [CaDiCaL source/API](https://github.com/arminbiere/cadical), [IPASIR interface](https://satcompetition.github.io/2021/track_incremental.html), [Emscripten pthread requirements](https://emscripten.org/docs/porting/pthreads.html).

Phase 2 implementation note: CaDiCaL calls are synchronous, so Dedicated Workers must solve in short conflict-bounded slices and yield to their event loop between calls. Cancellation is an immediate latch checked before each slice; a posted Worker message cannot interrupt the middle of synchronous Wasm execution. The text-LRAT RUP checker added here is a feasibility checker only. The independently pinned production checker, proof size limits, and proof correctness pipeline remain Phase 10 work.

Exit gate: all required capabilities work without Wasm pthreads. If portability, resumable budgets, cube semantics, or proof output fails, stop and re-plan before defining the distributed protocol.

### Phase 3 — Formula pipeline and real browser solving

Branch: `codex/hivesat-03-formula-runtime`

- [x] Implement strict DIMACS parsing in a browser worker with useful line/offset errors, progress, cancellation, and decompression-bomb limits. Plain `.cnf` and gzip `.cnf.gz` streams report one-based line/column plus zero-based byte offsets and yield often enough for cancellation without quadratic long-line buffering.
- [x] Define `HiveCnfV1`: deterministic little-endian integer encoding preserving parsed clause order, with SHA-256 over the uncompressed encoding and gzip for transfer. The byte-level contract is documented in `docs/formula-runtime.md`.
- [x] Enforce 5 MiB compressed, 32 MiB encoded, and two million literal-occurrence limits. Decompressed source text is independently capped at 32 MiB so comments and whitespace cannot form a gzip bomb.
- [x] Cache verified formulas by hash in IndexedDB and transfer typed arrays to solver workers in batches. Cache reads re-decode and re-hash canonical bytes; corrupt entries fail closed and are deleted.
- [x] Replace filename-derived mock verdicts with real bounded CaDiCaL solving and an independent TypeScript model verifier. Dedicated solver workers retain CaDiCaL state across pause/resume, the UI displays only SAT models that satisfy every parsed clause, and verified assignments can be downloaded as DIMACS-style `s`/`v` output.
- [x] Add brute-force differential tests for random small formulas and known SAT/UNSAT fixtures. Browser coverage also exercises gzip input/cache hits, malformed locations, decompression limits, and bounded cancellation/resume.

Phase 3 implementation note: verified local SAT assignments are retained only for the active result and can be downloaded as text containing `s SATISFIABLE` and signed `v` literals terminated by `0`. Local UNSAT is a CaDiCaL verdict, not a public proof-certified result. Proof production and independent UNSAT certification remain Phase 10 work; durable model artifacts remain Phase 7, and public upload and swarm behavior remain disabled. The exact formula format, cache trust boundary, and resource limits are documented in `docs/formula-runtime.md`.

Exit gate: the browser correctly parses, solves, cancels, resumes, and verifies representative formulas without server computation.

### Phase 4 — Public job submission and storage

Branch: `codex/hivesat-04-job-platform`

- [x] Add anonymous device IDs, Turnstile-protected job creation, unguessable job IDs, and cryptographic owner/upload tokens. Store only token digests server-side. Device identity is retained in IndexedDB; network identifiers use an HMAC digest before admission storage.
- [x] Store the owner token in IndexedDB and an owner-only URL fragment; public share links exclude it.
- [x] Stream formulas to job-scoped R2 keys and verify their declared hash in every solver browser after download. Downloads are gzip-expanded under the canonical-size cap, decoded as HiveCnfV1, and SHA-256 checked before use.
- [x] Create `JobCoordinatorDO` and `SwarmDirectoryDO` SQLite schemas, root-task initialization, public status reads, cancellation, and 24-hour alarms. The append-only namespace migration is `v0001_job_platform`.
- [x] Enforce one active job and three creations per rolling day per device/network digest, plus a configurable global active-job ceiling.
- [x] Require explicit consent that every submitted formula is public to swarm participants; there is no private server-job mode. The existing browser-only solver remains separate and uploads nothing.

Phase 4 implementation note: local development uses Cloudflare's published
Turnstile test widget/secret and enables public jobs. Production stays disabled
until the R2 bucket, production Turnstile widget, `TURNSTILE_SECRET`, and
`NETWORK_DIGEST_KEY` are configured and the exit-gate smoke test is performed.
The public API and trust boundary are documented in
`docs/public-job-platform.md`.

Exit gate: a valid public formula can be created, uploaded, inspected, cancelled, expired, and safely deleted without buffering it in the Worker.

### Phase 5 — Leasing and coordinator protocol

Branch: `codex/hivesat-05-leasing`

- [x] Implement hibernating Job Coordinator WebSockets and versioned `HELLO`, `REQUEST_WORK`, `HEARTBEAT`, `SPLIT`, `YIELD`, `RESULT`, and cancellation messages. Both protocol directions use bounded runtime validation; application `PING`/`PONG` uses a hibernation auto-response.
- [x] Persist a lease before sending work. Use unpredictable lease IDs, bounded attempts, and atomic task transitions. Leases use 192-bit random IDs, five-attempt fail-closed recovery, and SQLite transactions for lease/task changes plus duplicate-response recording.
- [x] Target roughly ten-minute desktop tasks with 15-minute leases; use 60-second batched heartbeats and persist only authoritative transitions or an exceptional lease extension. Ordinary telemetry heartbeats do not write lease progress; one bounded five-minute extension may be persisted near expiry.
- [x] Consolidate lease recovery and job expiry into the object’s single earliest-deadline alarm. The alarm recomputes the earlier deadline after every authoritative transition.
- [x] Accept valid decisive evidence from stale leases, but reject stale splits and ordinary progress mutations. Phase 5 stores structurally valid stale SAT/UNSAT candidates without promoting them to a terminal verdict; independent evidence verification remains Phase 7.
- [x] Add socket attachments, reconnect/backoff, duplicate-message handling, and bounded alarm batches. Stable sessions resume active leases after hibernation, the browser transport uses capped jittered exponential backoff, and alarms recover at most 64 leases per invocation.

Phase 5 implementation note: the coordinator's append-only internal SQLite
schema migration 2 adds lease history, candidate evidence, processed-message
replay, task attempts, and active-lease ownership. No Wrangler namespace
migration was added because the existing `JobCoordinatorDO` class remains in
`v0001_job_platform`. The wire contract and trust boundaries are documented in
`docs/coordinator-protocol.md`.

Exit gate: fault-injection tests cover disconnects, hibernation, expiry, reassignment, duplicated results, stale clients, and coordinator restart.

### Phase 6 — Cube-and-conquer browser runtime

Branch: `codex/hivesat-06-distributed-cubes`

- [x] Add a browser worker pool with conservative defaults: up to two desktop workers and one mobile worker, bounded by user preference and detected capacity. `DistributedCubeRuntime` owns the external-store snapshot and one single-threaded CaDiCaL Dedicated Worker per slot.
- [x] Use CaDiCaL `lookahead()` to split only into exact complementary children `C ∧ l` and `C ∧ ¬l`; the coordinator independently validates coverage. Browsers send only the literal; the coordinator constructs and persists both children atomically.
- [x] Use queue watermarks of approximately 1×/3×/8× active workers, a maximum cube depth of 64, and a 10,000-task ceiling. Every WORK message carries the coordinator-derived queue snapshot used to decide whether lookahead splitting is appropriate.
- [x] When a budget expires without a safe split, yield and restart the cube later; do not migrate CDCL state. Cube assumptions are reapplied on every bounded slice and yielded cubes return to READY.
- [x] Give a user’s active job first claim on every local worker. Only workers for which no owner task is ready request public swarm work. The owner-first claim policy is explicit and unit tested; the job page exposes the owner runtime while public-swarm admission remains Phase 8.
- [x] Cache formulas locally and never send full formulas or proof data through WebSockets. Public downloads revalidate IndexedDB hits and cache newly verified canonical/gzip bytes by SHA-256.

Phase 6 implementation note: the sequential learning guide begins at
`docs/guide/README.md` and includes SAT/CNF fundamentals, the canonical formula
pipeline, and an illustrated cube-and-conquer walkthrough. Coordinator tests
exercise complementary leases across several browser sessions, expiry, and
exact cube reassignment after churn. The production bundle includes the
dedicated cube worker; terminal server-side result verification remains Phase
7, and public directory assignment remains Phase 8.

Exit gate: several browser contexts can solve complementary cubes, recover from churn, avoid duplicate coverage, and terminate early on a verified SAT candidate.

### Phase 7 — Result correctness pipeline

Branch: `codex/hivesat-07-results`

- [x] Encode SAT models as compact bitsets with formula, cube, path, and solver-version metadata. `HSMODL01` artifacts carry bounded JSON metadata plus one truth bit per variable and are uploaded under their lease ID.
- [x] Verify final SAT models independently inside a `ResultVerifierDO`; invalid results quarantine that session and requeue the task. The verifier re-reads and hashes both R2 objects, decodes both formats, and checks the cube and every clause.
- [x] Treat browser-reported UNSAT as a candidate only. Require an independent repeated solve before requesting proof production, but never promote consensus alone to final UNSAT.
- [x] Propagate task completion through the tree only when complementary coverage is intact. Upward propagation requires exactly two completed children with the parent prefix and opposite final literals.
- [x] Define invalid-formula, invalid-model, verification-timeout, exhausted-budget, and conflicting-result behavior explicitly. The fail-closed state table and SAT/UNSAT asymmetry are documented in the sequential guide.
- [x] Track session reliability only for lease sizing and abuse containment; it never affects job priority. Invalid-model sessions are quarantined; verifier timeouts are recorded separately.

Phase 7 implementation note: the append-only Wrangler migration
`v0002_result_verifier` introduces the short-lived verifier namespace, while
Job Coordinator internal schema migration 3 adds candidate manifests,
verification state, and session reliability. Detailed diagrams, artifact
layout, examples, and failure semantics are in
`docs/guide/04-result-correctness.md`. Repeated UNSAT is deliberately retained
as `UNSAT_CANDIDATE`; proof-backed terminal UNSAT remains Phase 10.

Exit gate: no malformed, stale, incomplete, or unverified result can produce a terminal job verdict.

### Phase 8 — Public swarm and equal-service scheduling

Branch: `codex/hivesat-08-public-swarm`

- [x] Connect opted-in browsers to `SwarmDirectoryDO`, assign a job, then move the browser to that job’s coordinator so only one DO socket is active. Directory sockets are one-shot and close before `PublicSwarmRuntime` starts the job runtime.
- [x] Schedule the active job with the lowest equal-weight virtual worker runtime. New jobs enter at the current minimum so they receive service without monopolizing the swarm.
- [x] Reconcile reserved versus actual active worker time; use hour-scale assignment quanta to avoid excessive WebSocket handshakes.
- [x] Use capability calibration for task sizing and lease length, not priority. Calibration selects 50/100/200-conflict slices and bounded 10/15/20-minute leases; the fair selection function cannot see it.
- [x] Apply aging and a per-job concurrency ceiling so all eligible jobs progress; no credits, contribution register, paid priority, or long-term contributor advantage.
- [x] Allow non-contributors to submit and receive the same public scheduling weight as contributors. The scheduling schema has no contributor or owner weight field.

Phase 8 implementation note: Swarm Directory internal schema migration 2 adds
eligibility, virtual worker-time accounting, active reservations, aging inputs,
and an eight-worker per-job ceiling. `PublicSwarmRuntime` performs the
directory-to-coordinator handoff and reports measured active worker time on its
next directory connection. Deterministic simulations cover unequal tasks,
heterogeneous capacities, churn, new arrivals, and concurrency saturation.
The illustrated scheduling walkthrough is
`docs/guide/05-fair-swarm-scheduling.md`.

Exit gate: deterministic simulations demonstrate bounded fairness under unequal task durations, worker churn, new-job arrival, and heterogeneous devices.

### Phase 9 — Real Swarm Mode experience

Branch: `codex/hivesat-09-swarm-ui`

- [x] Build `/swarm` as a scoped dark, moody dashboard using the existing lime/amber HiveSAT visual language.
- [x] Default contribution to paused. Public work runs only while `/swarm` is active; “pause when hidden” defaults on.
- [x] Provide start/pause, maximum worker count, visibility policy, and clear unsupported/throttled/reconnecting/no-work states.
- [x] Show:
  - current task and connection state;
  - active worker count and configured capacity;
  - active compute time and throughput;
  - conflicts, decisions, propagations, and cubes accepted;
  - unique jobs helped;
  - decisive verified SAT or certified UNSAT contributions;
  - formula bytes transferred;
  - Wasm linear-memory current and high-water values;
  - global active jobs/workers and a bounded rolling activity graph.
- [x] Persist session and device-lifetime totals in IndexedDB with a reset action.
- [x] Label CPU and memory honestly: configured worker share, active compute time, and Wasm allocation—not unavailable OS-level CPU or process-memory claims.
- [x] Use aggregate statistics only; omit the search-tree visualization.

Phase 9 implementation note: `SwarmPage` owns `PublicSwarmRuntime`, so leaving
the route stops public work. Solver workers report operation counters and Wasm
linear-memory current/high-water values through the existing sparse telemetry;
network bytes count verified formula cache misses only. The dashboard uses a
bounded 24-point aggregate activity series and persists aggregate lifetime
totals in `hivesat-swarm-stats` IndexedDB. Responsive, mobile-fallback,
reduced-motion, control, and honest-label behavior is covered in unit and
Playwright tests. The annotated walkthrough is
`docs/guide/06-swarm-mode.md`.

Exit gate: responsive and accessible behavior is verified on modern desktop browsers, with a one-worker mobile fallback and reduced-motion support.

### Phase 10 — Proof-carrying UNSAT

Branch: `codex/hivesat-10-unsat-proofs`

- [x] Reassign an UNSAT candidate to a fresh proof-finisher CaDiCaL instance with tracing enabled before clauses are loaded.
- [x] Produce gzip-compressed LRAT for `F ∧ cube`, with a manifest binding the proof to the formula hash, cube assumptions, path hash, clause IDs, solver version, and artifact hash.
- [x] Stream proofs to R2 under lease-scoped upload tokens. Cap each job at 32 MiB compressed and 128 MiB decompressed proof data; split further or return `UNKNOWN` when exceeded.
- [x] Pin and compile the independent MIT-licensed `lrat-check.c` checker from DRAT-trim for browser and bounded Durable Object use. [DRAT-trim/LRAT checker](https://github.com/marijnheule/drat-trim).
- [x] Server-certify small proofs within conservative verifier limits. Larger allowed proofs are checked in the owner’s browser:
  - successful local checks produce `UNSAT_OWNER_VERIFIED`;
  - public status distinguishes this from server-side `UNSAT_CERTIFIED`;
  - certificates remain downloadable for independent checking.
- [x] Verify every certified leaf and complementary split before propagating UNSAT to the root. Oversized, timed-out, missing, or invalid proofs result in `UNKNOWN`, never UNSAT.

Phase 10 implementation note: Job Coordinator internal schema migration 5
adds proof-required tasks and proof artifact state without changing the
deployed Durable Object namespace. A proof finisher always allocates a new
CaDiCaL instance, enables LRAT before loading canonical clauses, appends cube
assumptions as unit clauses with recorded IDs, and uploads gzip evidence under
its lease. The job-wide limits are 32 MiB compressed and 128 MiB decompressed;
the conservative server checker limits are 2 MiB/8 MiB. Larger allowed proofs
remain `OWNER_CHECK_REQUIRED` until the owner runs the pinned C checker in a
Dedicated Worker. Server and owner certification remain distinct public
states, and only exact complementary certified leaves propagate. The pinned
checker build, artifact layout, state transitions, examples, and failure
semantics are documented in `docs/guide/07-proof-carrying-unsat.md`.

Exit gate: known UNSAT formulas complete only with valid proof coverage; proof corruption, omitted branches, checker timeout, and proof-size overflow all fail closed.

### Phase 11 — Security, cost, and launch hardening

Branch: `codex/hivesat-11-launch-hardening`

- [x] Fuzz DIMACS, decompression, WebSocket, API, model, and proof parsers; enforce message, assumption, task, upload, and artifact limits.
- [x] Add session quarantine, Turnstile replay prevention, HMACed network identifiers, token rotation, CSP/security headers, and structured error responses.
- [x] Load-test several hundred intermittent clients with realistic 60-second heartbeats and long task leases; verify DO request, duration, row-write, and R2-operation projections remain below configurable safety margins.
- [x] Add admission and swarm kill switches, maximum active connections/jobs, exponential client backoff, quota dashboards, and operator runbooks.
- [x] Test expiry and R2 cleanup, schema migration, rolling deployment, older-client rejection, and recovery from partial deployment.
- [x] Remove simulation copy, enable the public swarm flag, and publish privacy/trust limitations.
- [ ] Perform the final production smoke test after manual integration. This delivery run explicitly forbids deployments, so no production mutation or smoke test is performed from these stacked branches.

Phase 11 implementation note: the public protocol advances to version 2 and
rejects older clients before allocation. Swarm Directory internal migration 3
adds a single-use Turnstile replay ledger and its alarm cleanup. Owner tokens
can be rotated atomically; invalid models and proofs quarantine sessions;
production responses carry a Turnstile- and Wasm-compatible restrictive CSP.
Configurable ceilings default to 100 active jobs, 32 sockets per job, 128
directory handoff sockets, and an 80% alert margin. `/api/v1/health` exposes a
bounded quota/configuration snapshot, while both public features remain
operator kill switches. Deterministic tests cover 600 intermittent clients,
fuzzed parser inputs, migration ledgers, hibernation recovery, replay, old
clients, cleanup, and connection saturation. The detailed learning page is
`docs/guide/08-launch-hardening.md`; operational and trust guidance is in
`docs/operator-runbook.md` and `docs/privacy-and-trust.md`.

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
