#include "hivesat_cadical.h"

#include "cadical.hpp"

#include <emscripten/emscripten.h>
#include <emscripten/heap.h>

#include <climits>
#include <cstdint>
#include <new>

namespace {

struct HiveSatSolver {
  CaDiCaL::Solver solver;
  bool interrupted = false;
  bool clauses_loaded = false;
  bool proof_open = false;
  size_t memory_high_water = 0;

  void sample_memory() {
    const size_t current = emscripten_get_heap_size();
    if (current > memory_high_water)
      memory_high_water = current;
  }
};

HiveSatSolver *from_handle(hivesat_solver handle) {
  return reinterpret_cast<HiveSatSolver *>(static_cast<uintptr_t>(handle));
}

hivesat_solver to_handle(HiveSatSolver *solver) {
  return static_cast<hivesat_solver>(reinterpret_cast<uintptr_t>(solver));
}

bool valid_literal(int32_t literal) {
  return literal != INT32_MIN;
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char *hivesat_version(void) {
  return CaDiCaL::Solver::version();
}

EMSCRIPTEN_KEEPALIVE hivesat_solver hivesat_solver_new(void) {
  HiveSatSolver *solver = new (std::nothrow) HiveSatSolver;
  if (!solver)
    return 0;
  solver->sample_memory();
  return to_handle(solver);
}

EMSCRIPTEN_KEEPALIVE void hivesat_solver_delete(hivesat_solver handle) {
  delete from_handle(handle);
}

EMSCRIPTEN_KEEPALIVE int
hivesat_add_clauses(hivesat_solver handle, const int32_t *literals,
                    size_t count) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper)
    return HIVESAT_INVALID_HANDLE;
  if (!literals || !count)
    return HIVESAT_INVALID_ARGUMENT;
  if (literals[count - 1] != 0)
    return HIVESAT_INCOMPLETE_CLAUSE;

  for (size_t index = 0; index < count; ++index) {
    if (!valid_literal(literals[index]))
      return HIVESAT_INVALID_ARGUMENT;
  }
  for (size_t index = 0; index < count; ++index)
    wrapper->solver.add(literals[index]);

  wrapper->clauses_loaded = true;
  wrapper->sample_memory();
  return HIVESAT_OK;
}

EMSCRIPTEN_KEEPALIVE int hivesat_assume(hivesat_solver handle,
                                        const int32_t *literals,
                                        size_t count) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper)
    return HIVESAT_INVALID_HANDLE;
  if (count && !literals)
    return HIVESAT_INVALID_ARGUMENT;
  for (size_t index = 0; index < count; ++index) {
    if (!literals[index] || !valid_literal(literals[index]))
      return HIVESAT_INVALID_ARGUMENT;
  }
  for (size_t index = 0; index < count; ++index)
    wrapper->solver.assume(literals[index]);
  return HIVESAT_OK;
}

EMSCRIPTEN_KEEPALIVE int hivesat_solve(hivesat_solver handle,
                                       int32_t conflict_budget) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper || conflict_budget < -1)
    return HIVESAT_INVALID_ARGUMENT;
  if (wrapper->interrupted)
    return HIVESAT_UNKNOWN;
  if (!wrapper->solver.limit("conflicts", conflict_budget))
    return HIVESAT_INVALID_ARGUMENT;
  const int result = wrapper->solver.solve();
  wrapper->sample_memory();
  return result;
}

EMSCRIPTEN_KEEPALIVE void hivesat_interrupt(hivesat_solver handle) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper)
    return;
  wrapper->interrupted = true;
}

EMSCRIPTEN_KEEPALIVE void hivesat_clear_interrupt(hivesat_solver handle) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (wrapper)
    wrapper->interrupted = false;
}

EMSCRIPTEN_KEEPALIVE int32_t hivesat_lookahead(hivesat_solver handle) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper || wrapper->interrupted)
    return 0;
  const int32_t literal = wrapper->solver.lookahead();
  wrapper->sample_memory();
  return literal;
}

EMSCRIPTEN_KEEPALIVE int hivesat_model(hivesat_solver handle,
                                       int32_t first_variable, int32_t count,
                                       int32_t *output) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper)
    return HIVESAT_INVALID_HANDLE;
  if (wrapper->solver.status() != HIVESAT_SAT)
    return HIVESAT_WRONG_STATE;
  if (first_variable < 1 || count < 0 || (count && !output) ||
      first_variable > INT32_MAX - count)
    return HIVESAT_INVALID_ARGUMENT;
  for (int32_t offset = 0; offset < count; ++offset)
    output[offset] = wrapper->solver.val(first_variable + offset);
  return HIVESAT_OK;
}

EMSCRIPTEN_KEEPALIVE double hivesat_metric_value(hivesat_solver handle,
                                                 int metric) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper)
    return -1;
  switch (metric) {
  case HIVESAT_CONFLICTS:
    return wrapper->solver.get_statistic_value("conflicts");
  case HIVESAT_DECISIONS:
    return wrapper->solver.get_statistic_value("decisions");
  case HIVESAT_PROPAGATIONS:
    return wrapper->solver.get_statistic_value("propagations");
  case HIVESAT_ACTIVE_VARIABLES:
    return wrapper->solver.active();
  case HIVESAT_IRREDUNDANT_CLAUSES:
    return wrapper->solver.irredundant();
  case HIVESAT_MEMORY_BYTES:
    wrapper->sample_memory();
    return emscripten_get_heap_size();
  case HIVESAT_MEMORY_HIGH_WATER_BYTES:
    wrapper->sample_memory();
    return wrapper->memory_high_water;
  default:
    return -1;
  }
}

EMSCRIPTEN_KEEPALIVE int hivesat_trace_lrat(hivesat_solver handle,
                                            const char *path) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper)
    return HIVESAT_INVALID_HANDLE;
  if (!path || !*path)
    return HIVESAT_INVALID_ARGUMENT;
  if (wrapper->clauses_loaded || wrapper->proof_open)
    return HIVESAT_WRONG_STATE;
  wrapper->solver.set("binary", 0);
  wrapper->solver.set("lrat", 1);
  if (!wrapper->solver.trace_proof(path))
    return HIVESAT_PROOF_ERROR;
  wrapper->proof_open = true;
  return HIVESAT_OK;
}

EMSCRIPTEN_KEEPALIVE int hivesat_close_proof(hivesat_solver handle) {
  HiveSatSolver *wrapper = from_handle(handle);
  if (!wrapper)
    return HIVESAT_INVALID_HANDLE;
  if (!wrapper->proof_open)
    return HIVESAT_WRONG_STATE;
  wrapper->solver.conclude();
  wrapper->solver.close_proof_trace();
  wrapper->proof_open = false;
  return HIVESAT_OK;
}

} // extern "C"
