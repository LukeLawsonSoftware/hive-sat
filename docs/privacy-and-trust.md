# Privacy and trust limitations

HiveSAT is an anonymous public-compute service, not a confidential solver.

## Public formulas

Every server-submitted formula is intentionally public to participating
browsers for up to 24 hours. Do not submit secrets, personal data, proprietary
instances, credentials, or material you are not permitted to share. The local
browser solver is separate and uploads nothing unless the user explicitly
creates a public job and completes the consent checkbox.

## Data retained

- Workers KV stores the canonical gzip formula and any model or proof artifacts
  under unique job-scoped keys with the job's absolute expiration.
- Job coordinator SQL stores formula metadata, cube tasks, leases, candidate
  manifests, verification state, and aggregate session reliability.
- The directory stores HMACed network identifiers, SHA-256 device identifiers,
  admission history, fair-scheduling reservations, and short-lived Turnstile
  replay digests.
- Browser IndexedDB stores anonymous device identity, owner credentials for
  that browser, verified formula cache entries, and aggregate swarm totals.

Bearer owner, upload, and lease credentials are not stored in plaintext on the
server. Public share links exclude the owner token.

## Retention

Jobs and their KV artifacts are designed to expire after 24 hours. KV expiration
is the backstop, while coordinator alarms delete formula, model, proof,
coordinator, and directory state. Local browser
caches and aggregate contribution totals remain on that device until their
normal cache lifecycle or the user's reset action.

## Result meanings

- `SAT_VERIFIED` means a separate verifier checked a complete model against the
  exact canonical formula and cube.
- `UNSAT_CERTIFIED` means bounded server verification checked complete LRAT
  leaf coverage.
- `UNSAT_OWNER_VERIFIED` means at least one required proof was checked in the
  submitting owner's browser with the pinned independent checker.
- `UNKNOWN` means a hard formula, artifact, verification, or platform safety
  limit prevented a certificate. Lease churn and ordinary expiry do not spend
  an attempt budget and cannot create this result. It is never silently
  displayed as UNSAT.

Anonymous participants are untrusted. Reliability signals contain abuse and
support operator diagnosis; they never replace model/proof verification or
affect job priority. Equal-service scheduling provides no credits, payments,
contributor advantage, or account history.

## Browser contribution

Public work is opt-in, starts paused, and runs only while the user remains on
`/swarm`. “Pause when hidden” defaults on. HiveSAT reports configured workers,
active compute time, solver counters, network bytes, and Wasm allocation. It
does not claim access to OS-level CPU percentage or process memory.

Local solving on `/` never starts public contribution. `/jobs` and individual
job pages read status and expose owner controls without starting any solver
worker. Their visible, non-terminal status polling is single-flight and no more
frequent than every 30 seconds.

## No guarantee of service

Capacity is bounded and intended to fail closed near configured quota margins.
Jobs may be rejected or return `UNKNOWN`. HiveSAT provides no confidentiality,
availability, completion-time, or free-tier guarantee.
