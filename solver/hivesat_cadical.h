#ifndef HIVESAT_CADICAL_H
#define HIVESAT_CADICAL_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum hivesat_status {
  HIVESAT_UNKNOWN = 0,
  HIVESAT_SAT = 10,
  HIVESAT_UNSAT = 20,
};

enum hivesat_error {
  HIVESAT_OK = 0,
  HIVESAT_INVALID_HANDLE = -1,
  HIVESAT_INVALID_ARGUMENT = -2,
  HIVESAT_INCOMPLETE_CLAUSE = -3,
  HIVESAT_WRONG_STATE = -4,
  HIVESAT_PROOF_ERROR = -5,
};

enum hivesat_metric {
  HIVESAT_CONFLICTS = 0,
  HIVESAT_DECISIONS = 1,
  HIVESAT_PROPAGATIONS = 2,
  HIVESAT_ACTIVE_VARIABLES = 3,
  HIVESAT_IRREDUNDANT_CLAUSES = 4,
  HIVESAT_MEMORY_BYTES = 5,
  HIVESAT_MEMORY_HIGH_WATER_BYTES = 6,
};

typedef uint32_t hivesat_solver;

const char *hivesat_version(void);
hivesat_solver hivesat_solver_new(void);
void hivesat_solver_delete(hivesat_solver handle);

/* Clauses are a zero-terminated literal stream: {1, -2, 0, 3, 0}. */
int hivesat_add_clauses(hivesat_solver handle, const int32_t *literals,
                        size_t count);
int hivesat_assume(hivesat_solver handle, const int32_t *literals,
                   size_t count);

/* The conflict budget applies to this call only; -1 means unlimited. */
int hivesat_solve(hivesat_solver handle, int32_t conflict_budget);
void hivesat_interrupt(hivesat_solver handle);
void hivesat_clear_interrupt(hivesat_solver handle);

/* Returns the selected literal, or zero if lookahead reaches a verdict. */
int32_t hivesat_lookahead(hivesat_solver handle);

/* Writes signed model literals for [first_variable, first_variable + count). */
int hivesat_model(hivesat_solver handle, int32_t first_variable,
                  int32_t count, int32_t *output);
double hivesat_metric_value(hivesat_solver handle, int metric);

/* Must be enabled before any clauses are loaded. The path uses MEMFS. */
int hivesat_trace_lrat(hivesat_solver handle, const char *path);
int hivesat_close_proof(hivesat_solver handle);

#ifdef __cplusplus
}
#endif

#endif
