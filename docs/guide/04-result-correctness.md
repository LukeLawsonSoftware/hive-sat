# Why results are not trusted on arrival

A distributed solver asks anonymous browsers to do useful work. That creates a
simple but important rule:

> A browser may propose an answer, but it cannot declare the public answer.

A browser can be buggy, out of date, interrupted halfway through a calculation,
or deliberately dishonest. HiveSAT therefore treats every incoming result as
untrusted data. This page follows a result from CaDiCaL to a public job state
and explains why SAT and UNSAT need different evidence.

![The result trust pipeline](images/result-trust-pipeline.svg)

## SAT and UNSAT are asymmetric

For a Boolean formula `F`, a SAT answer is an existence claim:

```text
"Here is one assignment x for which F(x) is true."
```

That witness is cheap to check. Walk through every clause and confirm at least
one literal is true. If the formula has two million literal occurrences, the
checker performs at most about two million literal tests.

UNSAT is a universal claim:

```text
"No assignment among all 2ⁿ possibilities makes F true."
```

Two browsers agreeing does not prove that claim. They could share the same
solver bug or both stop too early. Repeating anonymous work therefore adds
latency without crossing a trust boundary. HiveSAT sends the first
structurally valid UNSAT candidate directly to a fresh proof finisher; only an
independently checked LRAT proof can certify the public result.

| Browser report | Coordinator meaning | Can it end the public job? |
| --- | --- | --- |
| SAT plus a model | A checkable candidate | Yes, after server verification |
| First valid UNSAT report | Reinitialize a proof-capable worker for this cube | No |
| More browsers reporting UNSAT | Redundant candidates, not stronger evidence | No |
| Checked UNSAT proof | A certificate for exactly this cube | Yes, after complete tree coverage |

## The compact SAT model artifact

Sending a JSON array such as `[1, -2, 3, ...]` wastes bytes. The variable
position already tells us the variable number, so HiveSAT stores only one truth
bit per variable:

```text
byte 0                         byte 8       byte 12
┌─────────────────────────────┬────────────┬──────────────────────┬──────────┐
│ "HSMODL01" magic + version  │ JSON bytes │ bounded JSON metadata│ bitset   │
└─────────────────────────────┴────────────┴──────────────────────┴──────────┘
  8 bytes                       uint32 LE     formula/cube/path      ⌈n/8⌉
```

For one million variables, the assignment is about 125 KiB instead of a
multi-megabyte JSON list. The complete artifact is capped at 512 KiB.

The metadata binds the bits to the exact computation:

- `formulaHash`: SHA-256 of canonical, uncompressed `HiveCnfV1`;
- `taskId` and `cube`: the leased subtree and its assumptions;
- `pathHash`: SHA-256 of the ordered, little-endian cube literals;
- `solverVersion`: the CaDiCaL build that proposed the model;
- `variableCount`: the precise number of truth bits;
- artifact byte length and SHA-256: protection against truncation or swapping.

Suppose a task has cube `[4, -9]`. The model must make variable 4 true and
variable 9 false, in addition to satisfying every formula clause. A valid model
for the formula but not for this cube is rejected.

## Step by step: a SAT candidate

```mermaid
sequenceDiagram
  participant C as "CaDiCaL worker"
  participant B as "Browser runtime"
  participant K as "Workers KV"
  participant J as "JobCoordinatorDO"
  participant V as "ResultVerifierDO"

  C->>B: "SAT + ordered model"
  B->>B: "Check every clause and cube literal"
  B->>B: "Encode bitset; hash artifact"
  B->>K: "Lease-scoped bounded model upload"
  B->>J: "RESULT + manifest"
  J->>J: "Validate lease, formula, task, cube, path"
  J->>V: "Verify immutable formula + model objects"
  J->>K: "Read model and gzip formula"
  J->>V: "Stream immutable artifacts"
  V->>V: "Re-hash, decode, check cube and clauses"
  V-->>J: "VALID_SAT"
  J->>J: "Atomically set SAT_VERIFIED"
  J-->>B: "Broadcast terminal result"
```

There are two independent model checks. The browser check catches local solver
or transfer mistakes early. The server verifier is decisive because it does
not trust the browser's memory, parser, claimed hash, or previous check.

The coordinator stores `VERIFYING_SAT` before calling the verifier. This matters
because Durable Objects may release their input gate while awaiting Workers KV or
another Durable Object. A second message cannot quietly turn an in-flight
candidate into a terminal result.

## Step by step: an UNSAT candidate

The first structurally valid UNSAT report closes its search lease and changes
the same exact cube to proof-required work. The next eligible lease goes only
to a proof-capable slot. That slot discards its search solver, creates a fresh
CaDiCaL instance, enables LRAT before loading clauses, then solves the canonical
formula plus the cube assumptions as unit clauses.

The candidate itself never moves completion up the tree. A checked proof may
certify the leaf, and completion may then move up only when both children are
present, exactly complementary, and certified:

```mermaid
flowchart TD
  P["parent cube C"]
  L["C ∧ x₇<br/>checked LRAT"]
  R["C ∧ ¬x₇<br/>checked LRAT"]
  P --> L
  P --> R
  L --> CHECK["coverage check"]
  R --> CHECK
  CHECK --> CAND["parent certified"]
```

The coordinator reconstructs and stores split children itself. During upward
propagation it checks that there are exactly two children, both preserve the
parent prefix, and their last literals are opposites. A missing, duplicated, or
unrelated branch cannot cover the parent search space.

## Failure behavior is part of correctness

Failing closed means uncertainty produces more work or an honest non-answer,
never a convenient verdict.

| Condition | Coordinator behavior | Public meaning |
| --- | --- | --- |
| Invalid formula object, hash, or encoding | Mark job `INVALID`; stop leases | Input cannot be trusted |
| Missing, corrupt, swapped, or false model | Delete model, quarantine session, requeue cube | No verdict |
| Verifier unavailable or transient budget exhausted | Record timeout and requeue without spending a lease-attempt budget | No verdict |
| Repeated lease expiry or browser churn | Return the exact cube to `READY`; retain `leaseCount` only as telemetry | No verdict |
| SAT conflicts with an unproved UNSAT candidate | Independently verified SAT wins because it has a witness | `SAT_VERIFIED` |
| Any number of UNSAT reports without proof | Keep proof work pending | Never display final UNSAT |
| Stale but correctly bound SAT artifact | It may be verified; lease age cannot invalidate mathematics | Terminal only if valid |
| Malformed or wrongly bound manifest | Reject before verification | No state promotion |

An invalid model increments session reliability data and quarantines that
session from reconnecting. Timeouts are counted separately because a timeout
does not prove dishonesty. These signals are for abuse containment and bounded
operator diagnosis only; they never change lease tenure or buy/remove
scheduling priority.

## The terminal invariant

At the end of Phase 7, the only new terminal path is:

```text
well-formed manifest
  + exact formula/task/cube/path binding
  + present bounded artifacts
  + matching cryptographic hashes
  + valid encodings
  + every cube literal true
  + every formula clause satisfied
  = SAT_VERIFIED
```

Everything else remains a candidate, is requeued, hits an explicit platform or
artifact safety limit, or marks the input invalid. Ordinary lease churn never
creates `UNKNOWN`. That invariant lets scheduling improve throughput without
weakening the meaning of an answer.

Next: [How the public swarm shares compute fairly →](05-fair-swarm-scheduling.md)
