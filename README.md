# HiveSAT

HiveSAT is an experimental web-based SAT solver designed to distribute search
work across participating browsers. This repository currently contains the
interactive UI prototype; solve progress and verdicts are deliberately simulated.

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

No solver backend, file upload, or Durable Object binding is included yet. See
`docs/durable-object-migrations.md` before adding a Durable Object class.
