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

All JSON job requests use `protocolVersion: 4`. Older versions fail with
`UPGRADE_REQUIRED` before Turnstile validation or allocation.

1. `POST /api/v1/jobs` validates bounded metadata, explicit public consent,
   and a single-use Turnstile token. `SwarmDirectoryDO` atomically applies
   admission limits before a job coordinator is initialized.
2. `PUT /api/v1/jobs/{jobId}/formula` requires the upload bearer token and an
   exact `Content-Length`. The request body streams through the job coordinator
   to a unique, expiring Workers KV key; the Worker does not buffer it.
3. A successful upload consumes the upload digest and changes the job from
   `UPLOADING` to `QUEUED`. The root cube task is created as `READY` with an
   empty assumption list.
4. `GET /api/v1/jobs/{jobId}` is public and returns aggregate metadata only.
   `GET /api/v1/jobs/{jobId}/formula` streams the public gzip value through the
   same coordinator consistency boundary.
5. `POST /api/v1/jobs/{jobId}/cancel` requires the owner bearer token, cancels
   the root task, starts bounded KV cleanup, and releases admission capacity.
6. `POST /api/v1/jobs/{jobId}/rotate-owner` atomically replaces the owner-token
   digest and invalidates the previous owner URL.
7. `GET /api/v1/jobs/{jobId}/socket` upgrades to the hibernating, versioned
   coordinator protocol documented in [coordinator-protocol.md](coordinator-protocol.md).

Public formula declarations and uploads are rejected above 5 MiB compressed,
two million literal occurrences, two million variables, or one million
clauses. Those count caps imply a maximum 12,000,020-byte canonical
`HiveCnfV1` (about 11.45 MiB). The separate 32 MiB encoded check is a defensive
decoder ceiling for malformed, cached, or network input. These are part of the
Workers KV design boundary, not tunable hints: HiveSAT does not require or
support R2.

Every solver-browser formula download compares the response hash with public
job status, expands gzip under the 32 MiB cap, validates the HiveCnfV1 encoding,
and computes SHA-256 over the uncompressed canonical bytes. A mismatch fails
closed before solver loading. IndexedDB hits receive the same decode-and-hash
check; a locally cached byte sequence is never trusted merely because its key
matches. Unique artifact keys avoid overwrites, and a temporarily unavailable
fresh KV value is retried with bounded backoff rather than treated as proof that
the job is corrupt.

## Browser routes and status reads

The three browser experiences have separate ownership:

- `/` is local-only solving and never joins the public swarm;
- `/swarm` is the explicit, page-scoped contribution runtime; and
- `/jobs` plus `/jobs/:jobId` provide status and owner controls without
  starting solver workers.

Job status uses 30-second polling only while visible and non-terminal. Each
page permits one in-flight request, aborts it on unmount or mutation, and
ignores a response from an older observation or one that would regress the
known state. The owned-jobs view groups
`UPLOADING`, `QUEUED`, and `RUNNING` records as active and verified, stopped,
cancelled, expired, invalid, or unavailable records as finished. A transient
network error retains the last known status; only an explicit not-found
response marks a retained job unavailable.

## Durable state and expiry

`JobCoordinatorDO` is one SQLite-backed object per job. Its `jobs` table owns
state and formula metadata; its `tasks` table starts with the root task.
`SwarmDirectoryDO` uses a single `global-v1` instance for admission and coarse
equal-service assignment. It stores active jobs, rolling creation records, and
assignment reservations, but never receives solver heartbeats or manages cube
leases. The selected job's coordinator is the sole lease dispatcher.

Both objects use `_sql_schema_migrations`; the Wrangler namespace migration is
the append-only `v0001_job_platform` entry. A job alarm is scheduled for exactly
24 hours after creation. Every KV value also carries that absolute expiration;
the alarm deletes committed values in bounded batches, releases the directory
row, and atomically deletes coordinator storage. The directory maintains its own
earliest-expiry alarm as a fail-safe.

Admission is fail-closed:

- one active job per device digest and per network digest;
- three creations in any rolling 24-hour window per device or network digest;
- `MAX_ACTIVE_JOBS` active jobs globally.

## Deployment configuration

Wrangler automatically provisions the `JOB_ARTIFACTS` KV namespace declared in
`wrangler.jsonc`. Configure a production Turnstile widget and set secrets outside
version control:

```bash
pnpm exec wrangler secret put TURNSTILE_SECRET --env production
pnpm exec wrangler secret put NETWORK_DIGEST_KEY --env production
```

Set the production `TURNSTILE_SITE_KEY` variable to that widget's public site
key. The values in
the top-level development config are Cloudflare's published always-pass test
keys and a local-only digest key; they are not production credentials.
