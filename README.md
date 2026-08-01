# HiveSAT

New to SAT solving or distributed browser compute? Start with the sequential
[How HiveSAT works guide](docs/guide/README.md).

HiveSAT is an experimental web-based SAT solver that distributes explicitly
public search work across opted-in browsers. It strictly parses, hashes, caches,
and solves DIMACS formulas locally; public jobs add cube-and-conquer leasing,
equal-service swarm scheduling, independent SAT-model verification, and
proof-carrying UNSAT with downloadable LRAT certificates. Public contribution
runs only while the user has started the page-scoped Swarm Mode runtime.

The experiences are intentionally separate: `/` is local-only solving,
`/swarm` is opt-in public contribution, and `/jobs` is submission status and
owner controls. Public protocol v4 returns persisted handshake assignments and
pushes subsequent work to stable browser slots, uses one session heartbeat per
minute, and grants adaptive split permits to remain predictable on large
instances. The rationale and request estimate are in
[`docs/stability-and-efficiency.md`](docs/stability-and-efficiency.md).

## Development

Requirements: Node.js 24 and pnpm 11.9. The Node version is pinned in
`.nvmrc`, `.node-version`, `package.json`, and CI.

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:worker
pnpm test:e2e
pnpm build
pnpm preview
pnpm wrangler:types:check
pnpm wrangler:dry-run
pnpm wasm:build
pnpm wasm:reproducible
```

## Solver feasibility artifact

Phase 2 adds a pinned, reproducible CaDiCaL 3.0.1 WebAssembly artifact behind
the HiveSAT-specific C ABI. Its source locks, licenses, build instructions,
runtime constraints, and proof-checking scope are documented in
[`solver/README.md`](solver/README.md).

## Local formula runtime

Plain `.cnf` and gzip `.cnf.gz` formulas are parsed in a dedicated worker and
canonicalized as HiveCnfV1. The canonical bytes are SHA-256 addressed, gzip
bounded for later transfer, verified on IndexedDB cache reads, and sent to the
CaDiCaL worker as transferable clause batches. SAT models receive a separate
TypeScript verification pass. The exact format and resource limits are in
[`docs/formula-runtime.md`](docs/formula-runtime.md).

## Cloudflare deployment

The app uses the Cloudflare Vite plugin and Workers Static Assets. After
authenticating Wrangler, deploy the `hive-sat` Worker with:

```bash
pnpm deploy
```

The production environment enables `FEATURE_PUBLIC_JOBS` and
`FEATURE_PUBLIC_SWARM`; both variables remain immediate operator kill switches.
Public jobs use a Workers KV binding plus SQLite-backed `JobCoordinatorDO` and
`SwarmDirectoryDO` namespaces. KV is the required artifact store; public
formulas are capped at 5 MiB compressed, while 32 MiB is a defensive decoder
ceiling. Literal/clause count caps make the effective maximum canonical value
12,000,020 bytes (about 11.45 MiB). Every browser cache/network read is decoded
and hash-verified, and admission plus every solver share ceilings of 2,000,000
variables and 1,000,000 clauses. Turnstile, token handling, streaming upload,
cancellation, and expiry are documented in
[`docs/public-job-platform.md`](docs/public-job-platform.md).
Launch controls, quota response, and rollback steps are in
[`docs/operator-runbook.md`](docs/operator-runbook.md). Privacy and trust
limitations are published in [`docs/privacy-and-trust.md`](docs/privacy-and-trust.md).

GitHub Actions owns validation only: lint,
type-checking, unit and Workers-runtime tests, browser E2E tests, the production
build, generated-type drift detection, and a Wrangler dry-run. The existing
Cloudflare Git integration owns production deployment after a successful merge
to `main`; GitHub Actions does not deploy and requires no Cloudflare secrets.

The browser still performs all parsing, hashing, and SAT solving. Formula and
evidence uploads stream through the job coordinator into KV without buffering;
the Worker does not solve formulas. See
`docs/durable-object-migrations.md` before changing a Durable Object class.
