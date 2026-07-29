# Coordinator leasing protocol

Phase 5 adds the versioned, hibernating WebSocket protocol at
`GET /api/v1/jobs/{jobId}/socket`. The stateless Worker validates the job and
the WebSocket upgrade before forwarding the connection to that job's
`JobCoordinatorDO`.

## Connection lifecycle

Every JSON control message contains `protocolVersion`, `messageId`, and
`jobId`. Task-scoped messages also contain `taskId` and `leaseId`. Both browser
and coordinator validate the discriminated unions at runtime and reject an
unsupported protocol with `UPGRADE_REQUIRED`.

The first client message must be `HELLO`, containing a stable reconnect
`sessionId` and bounded `WorkerCapabilities`. The coordinator replies with
`WELCOME`, including any unexpired leases already owned by that session. A
browser may then send `REQUEST_WORK`, `HEARTBEAT`, `SPLIT`, `YIELD`, or
`RESULT`. Server responses are `WORK`, `NO_WORK`, `ACK`, `ERROR`, and
`JOB_CANCELLED`.

Connections use the Durable Objects WebSocket Hibernation API. The coordinator
stores the job and session identity in a serialized socket attachment, so it
does not depend on in-memory connection state after hibernation. Application
`PING`/`PONG` is configured as a platform auto-response and does not wake a
hibernated object. Disconnecting a socket does not immediately revoke its
leases: a browser can reconnect with the same session, while the alarm remains
the authoritative recovery mechanism.

`JobCoordinatorSocket` is the browser transport. It resends `HELLO` with the
same session after a disconnect and uses jittered exponential backoff from
roughly one second to a 30-second cap. An `UPGRADE_REQUIRED` response
stops reconnection.

## Lease and task rules

- A `READY` task is atomically changed to `LEASED` and its unpredictable
  192-bit lease ID is inserted in SQLite before `WORK` is sent.
- `WORK` includes a bounded queue snapshot: READY tasks, active sessions,
  1×/3×/8× watermarks, total task count, and `canSplit`. Browsers use it only
  to decide whether lookahead is useful. The coordinator accepts a split
  literal—not browser-authored children—and constructs both children itself
  after enforcing depth 64 and 10,000-task caps.
- `WORK.task.purpose` distinguishes ordinary search from a fresh
  `PROOF_FINISHER`. Proof-finisher work cannot split and must enable LRAT before
  loading clauses.
- The default lease is 15 minutes, capped by job expiry. Attempts are capped at
  five. A task whose fifth lease expires becomes `UNKNOWN` instead of being
  retried indefinitely.
- Solver work should target about ten minutes. The browser batches its solver
  counters into one `HEARTBEAT` payload per lease every 60 seconds. Ordinary
  heartbeats are validated and acknowledged without a SQLite write.
- One exceptional five-minute extension may be requested in the final two
  minutes of a lease. That authoritative deadline change is persisted and is
  still capped by job expiry.
- `SPLIT` is accepted only from the active lease and creates the exact
  complementary children `C ∧ l` and `C ∧ ¬l` atomically. `YIELD` closes the
  lease and returns the task to `READY`.
- A structurally valid SAT or UNSAT candidate is retained even when its lease
  has expired or been superseded. Stale `HEARTBEAT`, `SPLIT`, and `YIELD`
  messages are rejected. Candidate evidence is not a terminal verdict;
  independent verification remains Phase 7.

Mutating messages and their serialized responses are recorded under
`(sessionId, messageId)`. Re-delivery returns the original response and cannot
create a second lease, split, yield, or result row. The table is pruned to a
bounded recent window by alarms.

## One earliest-deadline alarm

The coordinator keeps one alarm at the earlier of the 24-hour job expiry and
the earliest active lease deadline. Each invocation recovers at most 64
expired leases, then schedules an immediate continuation when more are due.
Otherwise it recomputes the next earliest deadline.

At job expiry the same alarm broadcasts cancellation, removes KV artifacts in bounded batches,
releases directory capacity, and deletes coordinator storage. Owner
cancellation atomically cancels active leases/tasks, broadcasts
`JOB_CANCELLED`, and leaves the existing expiry alarm to perform final durable
cleanup.

The existing Wrangler namespace migration remains
`v0001_job_platform` because no Durable Object class was added. Coordinator
internal migrations remain append-only. The current ledger includes leasing,
result verification, calibrated profiles, and proof-required artifact state.
