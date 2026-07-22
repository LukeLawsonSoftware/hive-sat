import createCaDiCaLModule from "./cadical.mjs";

export const SolverStatus = Object.freeze({
  UNKNOWN: 0,
  SAT: 10,
  UNSAT: 20,
});

export const SolverMetric = Object.freeze({
  CONFLICTS: 0,
  DECISIONS: 1,
  PROPAGATIONS: 2,
  ACTIVE_VARIABLES: 3,
  IRREDUNDANT_CLAUSES: 4,
  MEMORY_BYTES: 5,
  MEMORY_HIGH_WATER_BYTES: 6,
});

const OK = 0;

function assertResult(result, operation) {
  if (result !== OK) {
    throw new Error(`${operation} failed with HiveSAT ABI error ${result}`);
  }
}

export async function loadCaDiCaL(options = {}) {
  const module = await createCaDiCaLModule({
    locateFile: (path) => new URL(path, import.meta.url).href,
    print: () => {},
    printErr: (...values) => console.error(...values),
    ...options,
  });

  return {
    version: module.UTF8ToString(module._hivesat_version()),
    createSolver: () => new HiveSatSolver(module),
  };
}

export class HiveSatSolver {
  #module;
  #handle;

  constructor(module) {
    this.#module = module;
    this.#handle = module._hivesat_solver_new();
    if (!this.#handle) throw new Error("Unable to allocate a CaDiCaL solver");
  }

  #withInt32(values, callback) {
    if (!values.length) return callback(0, 0);
    const pointer = this.#module._malloc(values.length * Int32Array.BYTES_PER_ELEMENT);
    if (!pointer) throw new Error("Unable to allocate Wasm input buffer");
    try {
      this.#module.HEAP32.set(values, pointer >> 2);
      return callback(pointer, values.length);
    } finally {
      this.#module._free(pointer);
    }
  }

  addClauses(literals) {
    const values = Int32Array.from(literals);
    const result = this.#withInt32(values, (pointer, count) =>
      this.#module._hivesat_add_clauses(this.#handle, pointer, count),
    );
    assertResult(result, "addClauses");
  }

  assume(literals) {
    const values = Int32Array.from(literals);
    const result = this.#withInt32(values, (pointer, count) =>
      this.#module._hivesat_assume(this.#handle, pointer, count),
    );
    assertResult(result, "assume");
  }

  solve(conflictBudget = -1) {
    return this.#module._hivesat_solve(this.#handle, conflictBudget);
  }

  interrupt() {
    this.#module._hivesat_interrupt(this.#handle);
  }

  clearInterrupt() {
    this.#module._hivesat_clear_interrupt(this.#handle);
  }

  lookahead() {
    return this.#module._hivesat_lookahead(this.#handle);
  }

  model(firstVariable, count) {
    const pointer = this.#module._malloc(count * Int32Array.BYTES_PER_ELEMENT);
    if (!pointer && count) throw new Error("Unable to allocate Wasm model buffer");
    try {
      assertResult(
        this.#module._hivesat_model(this.#handle, firstVariable, count, pointer),
        "model",
      );
      return Array.from(
        this.#module.HEAP32.subarray(pointer >> 2, (pointer >> 2) + count),
      );
    } finally {
      this.#module._free(pointer);
    }
  }

  metric(metric) {
    return this.#module._hivesat_metric_value(this.#handle, metric);
  }

  enableLrat(path = "/proof.lrat") {
    const pointer = this.#module.stringToNewUTF8(path);
    try {
      assertResult(
        this.#module._hivesat_trace_lrat(this.#handle, pointer),
        "enableLrat",
      );
    } finally {
      this.#module._free(pointer);
    }
  }

  closeLrat(path = "/proof.lrat") {
    assertResult(this.#module._hivesat_close_proof(this.#handle), "closeLrat");
    return this.#module.FS.readFile(path, { encoding: "utf8" });
  }

  dispose() {
    if (!this.#handle) return;
    this.#module._hivesat_solver_delete(this.#handle);
    this.#handle = 0;
  }
}
