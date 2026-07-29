# Public job platform

HiveSAT's anonymous public-job lifecycle remains controlled by
`FEATURE_PUBLIC_JOBS`. Production configuration enables it for launch, while
the same variable remains the immediate admission kill switch.

## Trust and privacy boundary

There is no private server job. A submitter must check an explicit consent box
confirming that the formula will be downloadable by public swarm participants.
The existing browser-only solver remains available, but anything sent to
`POST /api/v1/jobs` is public for the job's lifetime.

The browser creates one anonymous 192-bit device ID and retains it in
IndexedDB. Job IDs are independent random 192-bit values. Owner and one-use
upload tokens are independent random 256-bit values; only their SHA-256 digests
are stored in the job coordinator. The owner token is retained in IndexedDB and
included only in an `#owner=...` URL fragment, which browsers do not send in
HTTP requests. Public share links omit the fragment.

Network identifiers are HMAC-SHA-256 digests of `CF-Connecting-IP`; the HMAC
key is a Worker secret. Raw device IDs, owner/upload tokens, and network
addresses are not persisted by Durable Objects.

## API lifecycle

All JSON job requests use `protocolVersion: 2`. Older versions fail with
`UPGRADE_REQUIRED` before Turnstile validation or allocation.

1. `POST /api/v1/jobs` validates bounded metadata, explicit public consent,
   and a single-use Turnstile token. `SwarmDirectoryDO` atomically applies
   admission limits before a job coordinator is initialized.
2. `PUT /api/v1/jobs/{jobId}/formula` requires the upload bearer token and an
   exact `Content-Length`. The request body is passed directly to R2 at
   `jobs/{jobId}/formula.hivecnf.gz`; the Worker does not buffer it.
3. A successful upload consumes the upload digest and changes the job from
   `UPLOADING` to `QUEUED`. The root cube task is created as `READY` with an
   empty assumption list.
4. `GET /api/v1/jobs/{jobId}` is public and returns aggregate metadata only.
   `GET /api/v1/jobs/{jobId}/formula` streams the public gzip object.
5. `POST /api/v1/jobs/{jobId}/cancel` requires the owner bearer token, cancels
   the root task, deletes the R2 object, and releases admission capacity.
6. `POST /api/v1/jobs/{jobId}/rotate-owner` atomically replaces the owner-token
   digest and invalidates the previous owner URL.
7. `GET /api/v1/jobs/{jobId}/socket` upgrades to the hibernating, versioned
   coordinator protocol documented in [coordinator-protocol.md](coordinator-protocol.md).

Every solver-browser formula download compares the response hash with public
job status, expands gzip under the 32 MiB cap, validates the HiveCnfV1 encoding,
and computes SHA-256 over the uncompressed canonical bytes. A mismatch fails
closed before solver loading.

## Durable state and expiry

`JobCoordinatorDO` is one SQLite-backed object per job. Its `jobs` table owns
state and formula metadata; its `tasks` table starts with the root task.
`SwarmDirectoryDO` uses a single `global-v1` instance for Phase 4 admission and
stores only active-job and rolling creation records. Later scheduling work must
remain shard-ready and must not route solver heartbeats through this directory.

Both objects use `_sql_schema_migrations`; the Wrangler namespace migration is
the append-only `v0001_job_platform` entry. A job alarm is scheduled for exactly
24 hours after creation. It deletes the R2 object, releases the directory row,
and atomically deletes coordinator storage. The directory maintains its own
earliest-expiry alarm as a fail-safe.

Admission is fail-closed:

- one active job per device digest and per network digest;
- three creations in any rolling 24-hour window per device or network digest;
- `MAX_ACTIVE_JOBS` active jobs globally.

## Deployment configuration

Create/configure the `hivesat-formulas` R2 Standard bucket and a production
Turnstile widget. Set secrets outside version control:

```bash
pnpm exec wrangler secret put TURNSTILE_SECRET --env production
pnpm exec wrangler secret put NETWORK_DIGEST_KEY --env production
```

Set the production `TURNSTILE_SITE_KEY` variable to that widget's public site
key. The values in
the top-level development config are Cloudflare's published always-pass test
keys and a local-only digest key; they are not production credentials.
