#!/bin/sh
set -eu

HIVESAT_REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HIVESAT_TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$HIVESAT_TEMP_DIR"' EXIT INT TERM

HIVESAT_SOLVER_OUTPUT_DIR="$HIVESAT_TEMP_DIR/output" \
HIVESAT_SOLVER_BUILD_DIR="$HIVESAT_TEMP_DIR/build" \
  "$HIVESAT_REPO_ROOT/solver/build.sh"

(cd "$HIVESAT_REPO_ROOT/public/solver" && shasum -a 256 -c SHA256SUMS)
cmp "$HIVESAT_REPO_ROOT/public/solver/cadical.mjs" "$HIVESAT_TEMP_DIR/output/cadical.mjs"
cmp "$HIVESAT_REPO_ROOT/public/solver/cadical.wasm" "$HIVESAT_TEMP_DIR/output/cadical.wasm"
cmp "$HIVESAT_REPO_ROOT/public/solver/lrat-check.mjs" "$HIVESAT_TEMP_DIR/output/lrat-check.mjs"
cmp "$HIVESAT_REPO_ROOT/public/solver/lrat-check.wasm" "$HIVESAT_TEMP_DIR/output/lrat-check.wasm"
cmp "$HIVESAT_REPO_ROOT/solver/THIRD_PARTY_NOTICES.md" "$HIVESAT_TEMP_DIR/output/THIRD_PARTY_NOTICES.md"
node "$HIVESAT_REPO_ROOT/solver/verify-artifact.mjs"
printf 'Committed solver artifacts are reproducible.\n'
