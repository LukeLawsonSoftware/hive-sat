# HiveSAT operator runbook

This runbook is for the Cloudflare Worker, `JobCoordinatorDO`,
`SwarmDirectoryDO`, `ResultVerifierDO`, and the `JOB_ARTIFACTS` KV namespace. It favors
rejecting new work over weakening result verification or exceeding configured
safety margins.

## Before enabling public traffic

1. Confirm the production KV namespace and all three Durable Object bindings.
2. Configure the production Turnstile site key and secret.
3. Configure a high-entropy `NETWORK_DIGEST_KEY` as a secret.
4. Run lint, type-check, unit, Workers-runtime, browser, Wasm reproducibility,
   generated-type drift, production build, and Wrangler dry-run checks.
5. Review `GET /api/v1/health`: `configuration.publicJobsReady` is true,
   features are enabled, quota state is `NORMAL`, and active counts are expected.
   Confirm deployed browser assets and Durable Objects both speak protocol v4.
6. Submit a small SAT fixture and confirm `SAT_VERIFIED` plus model cleanup.
7. Submit a small UNSAT fixture and confirm checked leaf coverage, a
   downloadable LRAT certificate, and the correct certified state.
8. Cancel a job and force an expiry fixture; confirm its formula, models,
   proofs, SQL, and directory row disappear.

The current stacked delivery run intentionally performs no deployment. The
production smoke steps above must be executed after manual integration and the
Cloudflare Git deployment.

## Capacity response

| Signal | Action |
| --- | --- |
| `quota.state = NEAR_LIMIT` | Lower `MAX_ACTIVE_JOBS`; inspect assignments, Workers KV operations, and DO request/duration trends |
| Job socket 503s | Confirm genuine concurrency, reconnect storms, and one 60-second session heartbeat—not one per slot—before raising `MAX_JOB_CONNECTIONS` |
| Directory socket 503s | Keep client backoff; inspect one-shot sockets and handoff latency before raising `MAX_DIRECTORY_CONNECTIONS` |
| Workers KV operation or byte trend unsafe | Disable `FEATURE_PUBLIC_JOBS` first; existing jobs still expire |
| DO request/duration trend unsafe | Disable `FEATURE_PUBLIC_SWARM`; preserve public status and cleanup |
| Both margins unsafe | Disable both flags and reduce the active-job ceiling |

Never shorten evidence verification, skip hashes, accept consensus as UNSAT,
or raise limits without a revised load projection.

Workers KV is required; R2 is unsupported and must not be configured. Reject
formulas above 5 MiB compressed, 2,000,000 variables/literal occurrences, or
1,000,000 clauses. Those count caps limit canonical `HiveCnfV1` to 12,000,020
bytes (about 11.45 MiB); 32 MiB is the defensive decoder ceiling. Preserve
immutable job-scoped keys, and investigate cache-hit rate and orphan cleanup
when KV byte trends are unsafe.
Cloudflare Queues are likewise not a fallback lease dispatcher; the job Durable
Object must remain the only authority for slots, leases, splits, and
cancellation.

## Large-instance stability checks

Use durable state and message rates, not rapidly changing UI counters, to
diagnose a job:

1. Confirm `HELLO` declared stable slot IDs and that
   `WELCOME.activeLeases` contained both resumed leases and newly persisted
   initial idle-slot assignments. Subsequent assignments should arrive as
   pushed `WORK` messages.
2. Confirm one `SESSION_HEARTBEAT` arrives per connected session per minute and
   includes each active slot. A two-slot session should not produce two
   independent heartbeat timers.
3. Confirm advancing active-compute counters roll deadlines five minutes ahead,
   never beyond 60 minutes from lease issue or job expiry.
4. Confirm an expired lease returns its task to `READY` regardless of
   `leaseCount`; there is no retry-ceiling transition to `UNKNOWN`.
5. When capacity is idle, confirm the durable frontier tends toward
   `min(2 × connected slots, 16)` and that split permits appear only after at
   least one second of active search. Depth 64 and 10,000 tasks are hard caps.
6. When a split is no longer useful, confirm `SPLIT_NOT_NEEDED` leaves the
   original lease active. A missing permit must not cause the browser to yield.
7. On the first valid UNSAT candidate, confirm the same cube enters proof
   finishing and is pushed only to a proof-capable worker. LRAT verification,
   not a second browser report, is the certification boundary.

If `/jobs` counters flicker, verify the browser rejects older observations and
state regressions and polls single-flight every 30 seconds. A transient 5xx or
network error must retain the last known state; only `JOB_NOT_FOUND`/404 marks
a local history record unavailable.

## Suspected abuse

1. Identify structured error and quarantine counts, not raw formula content.
2. Confirm invalid evidence is isolated to sessions and no terminal transition
   occurred.
3. Disable new swarm assignment if invalid-result traffic is sustained.
4. Disable job creation if Turnstile replay or creation-rate rejection grows
   unexpectedly.
5. Rotate `NETWORK_DIGEST_KEY` only with an explicit incident plan: rotation
   changes future HMAC identifiers and temporarily weakens rolling continuity.
6. Retain only normal platform logs; do not copy formulas or bearer tokens into
   an incident ticket.

## Failed or partial rollout

1. Use the two feature variables as immediate kill switches.
2. Keep the newer server rejecting incompatible clients with
   `UPGRADE_REQUIRED`; do not restore permissive parsing.
3. Verify each internal `_sql_schema_migrations` ledger is ordered and complete.
4. Check alarm deadlines and allow existing 24-hour cleanup to finish.
5. Roll application code back through the normal Cloudflare/Git workflow only
   if its schema remains forward-compatible. Never rewrite a deployed migration.

## Expiry audit

For a sampled expired job, verify all of the following:

- no directory `active_jobs` row or active reservation;
- no coordinator SQL storage after its deletion alarm;
- no `jobs/{jobId}/formula/*` key;
- no `jobs/{jobId}/models/*` objects;
- no `jobs/{jobId}/proofs/*` objects; and
- public status returns not found.

An orphan is a cleanup incident. Disable admission if orphan growth threatens
the Workers KV safety margin, then investigate alarms and partial uploads.

## Post-deployment smoke record

Record the commit, deployment version, test job IDs, terminal states,
certificate hashes, cleanup time, health quota snapshot, and operator. Do not
record owner, upload, or lease tokens.
