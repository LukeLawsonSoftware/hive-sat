# HiveSAT

HiveSAT is an experimental web-based SAT solver designed to distribute search
work across participating browsers. This repository currently contains the
interactive UI prototype; solve progress and verdicts are deliberately simulated.

## Development

Requirements: Node.js 20.19+ and pnpm.

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

## Cloudflare deployment

The app uses the Cloudflare Vite plugin and Workers Static Assets. After
authenticating Wrangler, deploy the `hive-sat` Worker with:

```bash
pnpm deploy
```

No solver backend, file upload, or Durable Object binding is included yet.
