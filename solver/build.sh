#!/bin/sh
set -eu

HIVESAT_REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$HIVESAT_REPO_ROOT/solver/versions.env"

HIVESAT_CACHE_DIR=${HIVESAT_SOLVER_CACHE_DIR:-"$HIVESAT_REPO_ROOT/.cache/solver"}
HIVESAT_BUILD_DIR=${HIVESAT_SOLVER_BUILD_DIR:-"$HIVESAT_REPO_ROOT/.build/solver"}
HIVESAT_OUTPUT_DIR=${HIVESAT_SOLVER_OUTPUT_DIR:-"$HIVESAT_REPO_ROOT/public/solver"}
HIVESAT_EMSDK_DIR=${HIVESAT_EMSDK_DIR:-"$HIVESAT_CACHE_DIR/emsdk-$HIVESAT_EMSCRIPTEN_VERSION"}
HIVESAT_SOURCE_DIR="$HIVESAT_BUILD_DIR/cadical-$HIVESAT_CADICAL_VERSION"

mkdir -p "$HIVESAT_CACHE_DIR" "$HIVESAT_BUILD_DIR" "$HIVESAT_OUTPUT_DIR"

hivesat_fetch() {
  hivesat_url=$1
  hivesat_sha256=$2
  hivesat_archive=$3
  if [ ! -f "$hivesat_archive" ]; then
    curl -L --fail --retry 3 -o "$hivesat_archive" "$hivesat_url"
  fi
  printf '%s  %s\n' "$hivesat_sha256" "$hivesat_archive" | shasum -a 256 -c -
}

HIVESAT_CADICAL_ARCHIVE="$HIVESAT_CACHE_DIR/cadical-$HIVESAT_CADICAL_VERSION.tar.gz"
hivesat_fetch "$HIVESAT_CADICAL_URL" "$HIVESAT_CADICAL_SHA256" "$HIVESAT_CADICAL_ARCHIVE"

if [ ! -x "$HIVESAT_EMSDK_DIR/upstream/emscripten/em++" ]; then
  HIVESAT_EMSDK_ARCHIVE="$HIVESAT_CACHE_DIR/emsdk-$HIVESAT_EMSCRIPTEN_VERSION.tar.gz"
  hivesat_fetch "$HIVESAT_EMSDK_URL" "$HIVESAT_EMSDK_SHA256" "$HIVESAT_EMSDK_ARCHIVE"
  if [ -d "$HIVESAT_EMSDK_DIR" ] && [ -n "$(find "$HIVESAT_EMSDK_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    printf 'Refusing to overwrite incomplete Emscripten SDK directory: %s\n' "$HIVESAT_EMSDK_DIR" >&2
    exit 1
  fi
  mkdir -p "$HIVESAT_EMSDK_DIR"
  tar -xzf "$HIVESAT_EMSDK_ARCHIVE" -C "$HIVESAT_EMSDK_DIR" --strip-components=1
  (cd "$HIVESAT_EMSDK_DIR" && ./emsdk install "$HIVESAT_EMSCRIPTEN_VERSION" && ./emsdk activate "$HIVESAT_EMSCRIPTEN_VERSION")
fi

rm -rf "$HIVESAT_SOURCE_DIR"
mkdir -p "$HIVESAT_SOURCE_DIR" "$HIVESAT_BUILD_DIR/objects"
tar -xzf "$HIVESAT_CADICAL_ARCHIVE" -C "$HIVESAT_SOURCE_DIR" --strip-components=1
rm -f "$HIVESAT_BUILD_DIR/objects"/*.o

HIVESAT_EMXX="$HIVESAT_EMSDK_DIR/upstream/emscripten/em++"
HIVESAT_EMCC="$HIVESAT_EMSDK_DIR/upstream/emscripten/emcc"
HIVESAT_CXXFLAGS="-O3 -std=c++11 -DNDEBUG -DNBUILD -DQUIET -DNTRACING -DNCONTRIB -DNIPASIR -DNCLOSEFROM -ffile-prefix-map=$HIVESAT_SOURCE_DIR=/usr/src/cadical -I$HIVESAT_SOURCE_DIR/src"

for hivesat_source in "$HIVESAT_SOURCE_DIR"/src/*.cpp; do
  case "$(basename "$hivesat_source")" in
    cadical.cpp|mobical.cpp|ccadical.cpp|ipasir.cpp) continue ;;
  esac
  hivesat_object="$HIVESAT_BUILD_DIR/objects/$(basename "${hivesat_source%.cpp}").o"
  "$HIVESAT_EMXX" $HIVESAT_CXXFLAGS -c "$hivesat_source" -o "$hivesat_object"
done

"$HIVESAT_EMCC" -O3 -DNDEBUG -c "$HIVESAT_SOURCE_DIR/src/kitten.c" \
  -o "$HIVESAT_BUILD_DIR/objects/kitten.o"
"$HIVESAT_EMXX" $HIVESAT_CXXFLAGS -I"$HIVESAT_REPO_ROOT/solver" -c \
  "$HIVESAT_REPO_ROOT/solver/hivesat_cadical.cpp" \
  -o "$HIVESAT_BUILD_DIR/objects/hivesat_cadical.o"

HIVESAT_EXPORTS='["_malloc","_free","_hivesat_version","_hivesat_solver_new","_hivesat_solver_delete","_hivesat_add_clauses","_hivesat_assume","_hivesat_solve","_hivesat_interrupt","_hivesat_clear_interrupt","_hivesat_lookahead","_hivesat_model","_hivesat_metric_value","_hivesat_trace_lrat","_hivesat_close_proof"]'

LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=0 "$HIVESAT_EMXX" -O3 \
  "$HIVESAT_BUILD_DIR"/objects/*.o \
  --no-entry \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16777216 \
  -sMAXIMUM_MEMORY=536870912 \
  -sFILESYSTEM=1 \
  -sFORCE_FILESYSTEM=1 \
  -sDYNAMIC_EXECUTION=0 \
  -sASSERTIONS=0 \
  -sEXPORTED_FUNCTIONS="$HIVESAT_EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS='["FS","UTF8ToString","HEAP32","stringToNewUTF8"]' \
  -o "$HIVESAT_OUTPUT_DIR/cadical.mjs"

cp "$HIVESAT_REPO_ROOT/solver/THIRD_PARTY_NOTICES.md" "$HIVESAT_OUTPUT_DIR/THIRD_PARTY_NOTICES.md"
(cd "$HIVESAT_OUTPUT_DIR" && shasum -a 256 cadical.mjs cadical.wasm > SHA256SUMS)
printf 'Built CaDiCaL %s with Emscripten %s\n' \
  "$HIVESAT_CADICAL_VERSION" "$HIVESAT_EMSCRIPTEN_VERSION"
