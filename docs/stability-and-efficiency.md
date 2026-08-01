# Stability and efficiency design

This document records the large-instance redesign introduced with public
protocol version 4. The goal is deliberately modest: keep one authoritative
coordinator per job, make browser ownership explicit, and send messages only
when useful work or durable state changes.

## Three separate user experiences

HiveSAT does not mix local solving and public contribution in one runtime:

- **Home (`/`)** parses and solves a formula entirely in this browser. It does
  not upload the formula or volunteer the device to another job.
- **Swarm (`/swarm`)** is the explicit opt-in public contribution experience.
  It owns the directory assignment and job WebSocket and stops when the user
  pauses or leaves the route.
- **Jobs (`/jobs` and `/jobs/:jobId`)** is status and owner control. It lists
  submissions made by this browser, shows a monotonic public state, and exposes
  owner-only cancel, token rotation, and proof-check actions when available.

This separation removes the old owner-versus-swarm worker arbitration path.
A local solver cannot accidentally hold public leases, and enabling local
workers cannot strand a directory assignment.

## Protocol v4: stable slots and coordinator-pushed work

A browser session creates a bounded set of stable slot IDs and sends all of
them in its initial `HELLO`. A lease is owned by `(sessionId, slotId)`, not by a
transient timer or request. The coordinator persists resumed and initial
idle-slot assignments before replying and carries them together in
`WELCOME.activeLeases`. Later assignments are persisted before it pushes
`WORK` to the matching slot.

There is no normal per-slot `REQUEST_WORK` polling loop. When a slot becomes
idle, the coordinator already knows because it accepted that slot's `SPLIT`,
`YIELD`, or `RESULT`, or because a lease expired. It pushes the next eligible
task immediately. Reconnecting with the same session and slot IDs resumes
unexpired leases; slots omitted by the reconnect are safely requeued.

Mutations have stable message IDs and are retained until the coordinator
acknowledges them. A slot is not made available locally before that ACK. This
removes the premature-release race that caused much of the one/two-worker
flicker; legitimate acknowledged ownership changes can still update the count.

## One heartbeat per session

Once per minute, one `SESSION_HEARTBEAT` carries bounded counters for every
slot. This replaces one timer and one heartbeat exchange per active lease. The
coordinator renews only leases whose active-compute counter advanced.

Each renewal gives a rolling five-minute lease, capped at 60 minutes from the
lease's original issue time and by job expiry. The cap ensures abandoned work
eventually returns to the frontier. Expiry or an explicit yield always returns
a non-terminal cube to `READY`; lease count is telemetry, not a correctness
budget. There is no attempt-count transition to `UNKNOWN`, so intermittent
browsers cannot permanently poison a large search merely by churning.

## Adaptive, coordinator-granted splitting

The coordinator, not each browser independently, decides whether more
parallelism is useful. It computes the desired frontier as:

```text
target frontier = min(2 × connected slots, 16)
```

Here the frontier is ready tasks plus active search leases and outstanding
split permits. A search slot becomes eligible for a short-lived split permit
after at least one second of active computation. The coordinator grants only
enough permits to fill idle capacity up to the target. A browser with no permit
keeps conquering its current cube; it does not repeatedly ask whether it should
split.

With a permit, CaDiCaL's `lookahead()` proposes one literal `l`. The browser
sends only that literal and the permit ID. The coordinator rechecks current
capacity and then atomically replaces cube `C` with exactly `C ∧ l` and
`C ∧ ¬l`. A permit can be rejected as no longer needed without losing the
current lease. Depth 64 and 10,000 tasks remain hard safety caps, not target
sizes.

This rule prevents eager exponential expansion while still producing enough
work for the connected swarm. It also makes partitioning independent of
network latency: a solver performs useful CDCL work while waiting for a rare
control decision.

## Result path

A valid SAT candidate still requires independent model verification against
the exact canonical formula and cube.

The first structurally valid UNSAT candidate now moves that exact cube directly
to proof finishing. Repeating the same solve in a second anonymous browser is
not a trust boundary and no longer delays proof production. Proof work is
assigned only to a proof-capable slot. That slot discards its search solver,
creates a fresh CaDiCaL instance, enables LRAT tracing before loading clauses,
and then loads the formula and cube unit clauses.

Only a checked LRAT proof can certify UNSAT. Browser agreement, session
reliability, and lease count never substitute for the checker. Complementary
leaf coverage is still required before a split parent, and ultimately the root,
can be certified.

## Why clause partitions cannot be intersected

Partitioning clauses by shared variables and intersecting each partition's
satisfying assignments is generally not a sound shortcut. Two clause groups
that share boundary variables are coupled: each group may be satisfiable under
different values for those variables even though their conjunction is UNSAT.
Enumerating every compatible boundary assignment restores correctness, but in
the worst case creates `2^b` combinations for `b` boundary variables and is
another form of the original SAT search.

A true variable-disconnected component is different. If no variable appears
in more than one component, the formula is SAT exactly when every component is
SAT, and their models can be combined. HiveSAT may detect such components as
preprocessing telemetry and a future optimization, but it does not use
overlapping clause partitions as a result rule. Component size and boundary
width are useful signals for choosing split variables; their local assignments
are not independently intersected.

## Storage boundary: Workers KV

Workers KV remains the required artifact store; R2 is not a deployment option
for HiveSAT. Public formulas are restricted to 5 MiB compressed, two million
literal occurrences, two million variables, and one million clauses. The count
caps make the effective maximum `HiveCnfV1` 12,000,020 bytes (about 11.45 MiB);
32 MiB is a defensive decoder ceiling rather than a reachable admitted size.
Formula, model, and proof values use unique immutable keys for the job lifetime.

KV can be eventually consistent across locations, so correctness never relies
on an unverified cache read. The uploading browser retains verified canonical
and gzip bytes in IndexedDB. Every participant cache hit is decoded and
SHA-256 checked, and every network download is bounded, decoded, and checked
against job metadata before a solver is initialized. A just-uploaded value
that is temporarily unavailable is retried with bounded backoff; it is not
interpreted as a missing or invalid formula.

## Why Cloudflare Queues are not the lease dispatcher

Cloudflare Queues are a poor match for interactive browser cube leasing. A
queue consumer is server-side, whereas browsers are intermittent pull/push
participants; task ownership, exact slot affinity, lease renewal, cancellation,
split-tree transactions, and reconnect recovery still require the per-job
Durable Object. Adding a Queue would introduce a second source of truth and
another delivery/acknowledgement loop without removing that coordinator.

Queues may be useful later for optional, lossy work that is not on the solving
critical path—for example aggregated telemetry export or offline analytics.
Dropping or delaying such a message must never affect a lease or verdict.

## Request and cost estimate

Let `N` be the number of slots in one connected browser session and ignore the
infrequent task/result transitions that both designs must send.

| Steady state | Previous client→coordinator messages | Protocol v4 |
| --- | ---: | ---: |
| all slots active, per minute | `N` lease heartbeats | `1` session heartbeat |
| all slots idle, per minute | up to `12N` work polls at a 5 s retry | `0` polls |
| all slots active, per hour | `60N` heartbeat requests | `60` heartbeat requests |
| all slots idle, per hour | up to `720N` poll requests | `0` poll requests |

Counting replies as wire messages doubles the heartbeat and idle-poll figures;
the ratio is unchanged. Work is now pushed after a known slot transition, so
each completed cube also avoids the extra `REQUEST_WORK`/response round trip.
For a two-slot browser, active heartbeat requests fall from 120 to 60 per hour,
and an hour with no eligible work avoids up to 1,440 work-poll requests (plus
1,440 `NO_WORK` replies). Formula KV reads are unchanged and should normally be
one verified cache miss per assigned formula, not per cube.

Public status pages are deliberately outside the solver control loop. They use
one single-flight request every 30 seconds while visible, abort stale requests,
reject state regressions, and stop polling terminal or locally expired jobs.
The jobs list refreshes active jobs in one observation generation so an older
response cannot make counters jump backwards; this relies on observed time and
state ordering rather than an exposed server sequence number.
