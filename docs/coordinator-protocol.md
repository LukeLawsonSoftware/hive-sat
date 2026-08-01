# Coordinator leasing protocol v4

The hibernating WebSocket protocol is served at
`GET /api/v1/jobs/{jobId}/socket`. The stateless Worker validates the upgrade
and forwards it to that job's `JobCoordinatorDO`, which is the single authority
for slots, tasks, leases, split coverage, and terminal state.

## Connection and slot lifecycle

Every JSON control message contains `protocolVersion: 4`, `messageId`, and
`jobId`. Task mutations also contain `slotId`, `taskId`, and `leaseId`. Both
directions use bounded runtime validation; a different protocol version fails
with `UPGRADE_REQUIRED`.

The first client message is `HELLO`:

- `sessionId` is stable across reconnects;
- `assignmentId`, when present, binds a public directory assignment;
- `slotIds` declares the session's stable, bounded worker slots; and
- `capabilities` includes solver identity, capacity, and proof-generation
  support.

The coordinator replaces an older socket for the same session and reconciles
its active leases against the declared slots. Before replying, it persists
initial assignments for any idle declared slots. `WELCOME.activeLeases` then
carries both resumed and newly assigned leases with their slot IDs. This saves
an extra frame and lets the browser create every worker handle from the
authoritative handshake state. Work owned by a slot omitted from the reconnect
is safely requeued.

After `HELLO`, normal browser messages are `SESSION_HEARTBEAT`, `SPLIT`,
`YIELD`, and `RESULT`. The coordinator sends `WORK`, `SPLIT_PERMIT`, `ACK`,
`ERROR`, `JOB_CANCELLED`, `JOB_SUSPENDED`, or `JOB_RESULT`. After the handshake,
subsequent assignments are pushed as `WORK` to known idle slots; protocol v4
has no normal per-slot work-poll loop.

The Durable Objects WebSocket Hibernation API retains a serialized attachment
containing the job, session, assignment, and slot identities. Application
`PING`/`PONG` uses a platform auto-response and does not wake a hibernated
object. An unexpected disconnect retains leases for session resumption and
leaves the alarm as the recovery authority. An explicit clean client stop is
authoritative and immediately yields that socket's leases.

The browser reconnects with capped jittered backoff and the same session and
slots. `UPGRADE_REQUIRED` is terminal. Mutating client messages retain a stable
message ID until acknowledged, and the slot remains locally occupied while its
mutation is in flight. Re-delivery receives the recorded response and cannot
create a second split, yield, result, or lease transition.

## Lease rules

- The coordinator changes a `READY` task to `LEASED` and inserts an
  unpredictable 192-bit lease before sending `WORK`.
- Each lease is bound to exactly one `(sessionId, slotId)`. `WORK.task.purpose`
  is either ordinary `SEARCH` or a fresh `PROOF_FINISHER`.
- A lease starts with a five-minute deadline. Once per minute, one
  `SESSION_HEARTBEAT` reports bounded cumulative counters for all slots. A
  lease whose `activeMs` advanced receives a rolling five-minute renewal.
- Renewals are capped at 60 minutes from `issuedAt`, at the split permit's
  lease deadline where applicable, and at job expiry. A paused or dead client
  therefore cannot retain a cube indefinitely.
- Lease expiry, shutdown, or safe yield closes the lease and returns a
  non-terminal cube to `READY`. `leaseCount` is operational telemetry only;
  there is no attempt ceiling and churn cannot turn a cube into `UNKNOWN`.
- A stale progress or tree mutation is rejected. Mathematically decisive,
  correctly bound evidence may still be checked after a lease race; lease age
  alone does not make a model or proof false.

The per-session heartbeat replaces one timer and message exchange per slot.
It is persisted only when it advances an authoritative lease deadline; metric
counters themselves are not a stream of task-row updates.

## Coordinator-granted splits

Browsers do not infer queue pressure from a frequently refreshed snapshot.
The coordinator observes connected slots and the durable frontier and grants a
short-lived `SPLIT_PERMIT` only when more work is useful:

```text
target frontier = min(2 × connected slots, 16)
```

The frontier includes ready tasks, active search leases, and outstanding
permits. A search lease must have recorded at least one second of active
compute before it is eligible. A permit is bound to its slot, task, and lease;
proof-finisher tasks cannot split.

With a permit, the browser calls CaDiCaL `lookahead()` and sends only
`splitLiteral` plus `permitId`. The coordinator rechecks idle capacity and
frontier pressure, validates the active lease and literal, and atomically
constructs the exact children `C ∧ l` and `C ∧ ¬l`. It enforces a depth-64
cap and 10,000-task cap. If demand disappeared, `SPLIT_NOT_NEEDED` leaves the
lease running; a transient scheduling decision does not throw useful solver
state away.

## Result transitions

A SAT result carries a bounded model manifest. The candidate cannot become
`SAT_VERIFIED` until `ResultVerifierDO` reads the exact KV artifacts, rechecks
their hashes and encodings, and verifies every cube literal and formula clause.

The first structurally valid UNSAT result changes the same task directly to
proof-required work. A proof-capable slot receives a new
`PROOF_FINISHER` lease and reinitializes CaDiCaL with LRAT enabled before the
formula is loaded. Independent browser agreement is not required and is never
treated as proof. Only a checked LRAT artifact can certify a leaf; the
coordinator then propagates completion only through exact complementary
children.

## Earliest-deadline alarm

One alarm tracks the earliest of job expiry, active lease deadlines, and other
durable cleanup deadlines. Each invocation recovers at most 64 expired leases,
cancels their split permits, returns non-terminal tasks to `READY`, dispatches
new work to connected idle slots, and schedules an immediate continuation when
more rows are due.

At the 24-hour job expiry, the alarm broadcasts cancellation, deletes bounded
Workers KV artifact batches, releases directory capacity, and deletes
coordinator storage. Owner cancellation stops active work immediately and
leaves the expiry path as the cleanup backstop.

The Wrangler namespace migration remains append-only because protocol v4 does
not add a Durable Object class. Internal SQLite migrations are likewise
append-only; see [durable-object-migrations.md](durable-object-migrations.md).
The design rationale and request estimate are in
[stability-and-efficiency.md](stability-and-efficiency.md).
