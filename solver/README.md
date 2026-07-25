# CaDiCaL WebAssembly feasibility build

This directory owns the Phase 2 solver gate. `versions.env` pins CaDiCaL
3.0.1 and Emscripten 4.0.10 by source URL and SHA-256. `build.sh` verifies
those archives, builds a single-threaded ES-module Wasm binary, and writes the
committed runtime to `public/solver`. The same build compiles the pinned
DRAT-trim `lrat-check.c` into a browser-compatible checker module. No pthread, Wasm Worker, or
`SharedArrayBuffer` build option is enabled.

Run:

```sh
pnpm wasm:build
pnpm wasm:reproducible
```

The first invocation downloads the locked source and SDK into
`.cache/solver`; both directories can be overridden with
`HIVESAT_SOLVER_CACHE_DIR` and `HIVESAT_EMSDK_DIR`. The reproducibility check
builds into a temporary directory, verifies the committed `SHA256SUMS`, and
byte-compares both artifacts.

## HiveSAT C ABI

`hivesat_cadical.h` is the stable boundary used by the small JavaScript
adapter in `public/solver/hivesat.mjs`. It deliberately goes beyond generic
IPASIR and exposes:

- zero-delimited batched clause loading and batched assumptions;
- a conflict budget that is reset for each solve call;
- an interrupt latch and explicit clearing;
- ranged model extraction;
- conflicts, decisions, propagations, active variables, clauses, and Wasm
  linear-memory telemetry;
- `lookahead()` split selection; and
- text LRAT tracing through Emscripten MEMFS.

CaDiCaL solving is synchronous. Browser cancellation therefore uses short,
conflict-bounded calls and yields to the Dedicated Worker event loop between
calls. The interrupt latch makes the next call return immediately; it cannot
process a Worker message in the middle of one synchronous Wasm call. Task
budgets in later phases must preserve this invariant. The portability test
requires the latched call to return in under 50 ms.

The module starts with 16 MiB of linear memory, grows as needed, and is capped
at 512 MiB. The browser gate forces growth and checks both current and
high-water telemetry.

## Proof and portability scope

The solver emits text LRAT for `F ∧ cube`. Phase 10 pins the upstream
DRAT-trim `lrat-check.c` commit and compiles it beside the solver. Browser
owner checks and bounded verifier checks share the fail-closed LRAT contract;
CI byte-compares both Wasm artifacts and checks the vendored source digest.

CI runs the same browser suite in current Google Chrome, Mozilla Firefox,
Microsoft Edge, and Playwright WebKit (the automation-compatible Safari
engine). A manual current Safari smoke test remains part of the post-deploy
exit gate because Safari itself does not expose a Playwright automation
channel.
