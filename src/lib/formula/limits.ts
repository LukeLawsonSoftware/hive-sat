export const MAX_COMPRESSED_FORMULA_BYTES = 5 * 1024 * 1024;
export const MAX_ENCODED_FORMULA_BYTES = 32 * 1024 * 1024;
export const MAX_LITERAL_OCCURRENCES = 2_000_000;

// Compressed DIMACS input is bounded independently from HiveCnfV1 so comments
// and whitespace cannot expand without limit before canonicalization.
export const MAX_DECOMPRESSED_DIMACS_BYTES = 32 * 1024 * 1024;

export const SOLVER_CLAUSE_BATCH_INTS = 64 * 1024;

