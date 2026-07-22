# HiveSAT

HiveSAT is an experimental web-based SAT solver designed to distribute search
work across participating browsers. The current Phase 3 runtime strictly parses,
hashes, caches, and solves DIMACS formulas locally in browser workers. Public job
submission and swarm coordination remain feature-flagged for later phases.

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

The production environment keeps `FEATURE_PUBLIC_JOBS` and
`FEATURE_PUBLIC_SWARM` disabled. GitHub Actions owns validation only: lint,
type-checking, unit and Workers-runtime tests, browser E2E tests, the production
build, generated-type drift detection, and a Wrangler dry-run. The existing
Cloudflare Git integration owns production deployment after a successful merge
to `main`; GitHub Actions does not deploy and requires no Cloudflare secrets.

No solver backend, public file upload, or Durable Object binding is included yet.
See `docs/durable-object-migrations.md` before adding a Durable Object class.
