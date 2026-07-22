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
```

## Cloudflare deployment

The app uses the Cloudflare Vite plugin and Workers Static Assets. After
authenticating Wrangler, deploy the `hive-sat` Worker with:

```bash
pnpm deploy
```

The production environment keeps `FEATURE_PUBLIC_JOBS` and
`FEATURE_PUBLIC_SWARM` disabled. A push to `main` deploys only after validation
and browser E2E jobs pass, using the protected `production` GitHub environment.
Configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as environment
secrets and `HIVESAT_PRODUCTION_URL` as an environment variable; CI then checks
`/api/v1/health` after deployment.

No solver backend, file upload, or Durable Object binding is included yet. See
`docs/durable-object-migrations.md` before adding a Durable Object class.
