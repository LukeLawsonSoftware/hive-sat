# Formula runtime and HiveCnfV1

Phase 3 keeps the complete formula pipeline in the browser. A dedicated formula
worker reads plain `.cnf` or gzip-compressed `.cnf.gz` input, validates strict
DIMACS, creates a canonical encoding, hashes and compresses it, and caches the
verified result. A separate dedicated worker owns the single-threaded CaDiCaL
instance.

## Input rules and limits

The parser accepts ASCII DIMACS with one `p cnf <variables> <clauses>` header,
comment lines whose first token is `c`, whitespace-separated signed literals,
and a `0` terminator for every clause. Clause tokens may span lines. Empty
clauses are valid. Header counts, literal ranges, clause counts, and final
termination must match exactly. Errors report a one-based line and column plus
a zero-based byte offset.

The formula worker enforces all limits while streaming, before unbounded data is
materialized:

| Limit | Value |
| --- | ---: |
| Compressed input or canonical transfer | 5 MiB |
| Decompressed DIMACS input | 32 MiB |
| Uncompressed HiveCnfV1 encoding | 32 MiB |
| Literal occurrences | 2,000,000 |

The decompressed-input limit is separate from the canonical-size limit so large
comments or whitespace cannot turn a small gzip input into a decompression bomb.

## HiveCnfV1 byte layout

HiveCnfV1 preserves the parsed clause and literal order. All numeric values are
fixed-width little-endian integers.

| Offset | Width | Value |
| ---: | ---: | --- |
| 0 | 8 bytes | ASCII `HIVECNF1` magic and version |
| 8 | 4 bytes | unsigned variable count |
| 12 | 4 bytes | unsigned clause count |
| 16 | 4 bytes | unsigned literal-occurrence count |
| 20 | remaining | signed 32-bit literals, with signed `0` after each clause |

SHA-256 covers the complete uncompressed HiveCnfV1 byte sequence, including its
header and clause terminators. Gzip is only the transfer/storage representation;
it is not part of the formula identity.

## Cache and solver boundary

The `hivesat-formulas` IndexedDB database stores canonical and gzip bytes keyed
by the lowercase SHA-256 hex digest. Every cache read decodes the canonical
format and recomputes the digest before returning a record. Corrupt entries are
deleted and treated as misses; inability to use IndexedDB does not prevent a
local solve.

Clause-aligned `Int32Array` batches are transferred, not copied, from the formula
worker through the app runtime to the solver worker. Each batch ends at a clause
terminator as required by the HiveSAT CaDiCaL ABI. CaDiCaL solves in bounded
conflict slices and yields to the worker event loop between slices, which makes
pause/cancel messages prompt while retaining solver state for resume.

For SAT, the app does not trust the solver result alone. It independently checks
that the returned signed model assigns every declared variable and satisfies
every parsed clause in TypeScript. A bad or incomplete model fails closed. A
verified model can be downloaded for the lifetime of the result as DIMACS-style
solver output with `s SATISFIABLE` and signed `v` literals ending in `0`; durable
model artifacts remain Phase 7 work. Local UNSAT is displayed as a CaDiCaL
verdict; distributed proof-backed certification remains Phase 10 work.
