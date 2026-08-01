import {
  MAX_DECOMPRESSED_DIMACS_BYTES,
  MAX_ENCODED_FORMULA_BYTES,
  MAX_CLAUSES,
  MAX_LITERAL_OCCURRENCES,
  MAX_VARIABLES,
} from "./limits";

export interface ParsedDimacs {
  variableCount: number;
  clauseCount: number;
  literalCount: number;
  clauses: number[][];
}

export interface DimacsProgress {
  bytesRead: number;
  totalBytes?: number;
  line: number;
}

export interface ParseDimacsOptions {
  signal?: AbortSignal;
  totalBytes?: number;
  onProgress?: (progress: DimacsProgress) => void;
}

export class DimacsParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly byteOffset: number;

  constructor(message: string, line: number, column: number, byteOffset: number) {
    super(`${message} (line ${line}, column ${column}, byte offset ${byteOffset})`);
    this.name = "DimacsParseError";
    this.line = line;
    this.column = column;
    this.byteOffset = byteOffset;
  }
}

function abortError(): DOMException {
  return new DOMException("Formula parsing was cancelled.", "AbortError");
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function isHorizontalWhitespace(byte: number): boolean {
  return byte === 9 || byte === 11 || byte === 12 || byte === 13 || byte === 32;
}

interface Token {
  text: string;
  column: number;
  byteOffset: number;
}

const ASCII_DECODER = new TextDecoder("utf-8", { fatal: true });

function tokenizeLine(bytes: Uint8Array, lineOffset: number, line: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < bytes.length) {
    if (bytes[index] > 0x7f) {
      throw new DimacsParseError(
        "DIMACS input must contain ASCII text only",
        line,
        index + 1,
        lineOffset + index,
      );
    }

    if (isHorizontalWhitespace(bytes[index])) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < bytes.length && !isHorizontalWhitespace(bytes[index])) {
      if (bytes[index] > 0x7f) {
        throw new DimacsParseError(
          "DIMACS input must contain ASCII text only",
          line,
          index + 1,
          lineOffset + index,
        );
      }
      index += 1;
    }

    tokens.push({
      text: ASCII_DECODER.decode(bytes.subarray(start, index)),
      column: start + 1,
      byteOffset: lineOffset + start,
    });
  }

  return tokens;
}

function parseUnsigned(token: Token, label: string, line: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(token.text)) {
    throw new DimacsParseError(
      `${label} must be a non-negative decimal integer`,
      line,
      token.column,
      token.byteOffset,
    );
  }

  const value = Number(token.text);
  if (!Number.isSafeInteger(value) || value > 0x7fff_ffff) {
    throw new DimacsParseError(
      `${label} exceeds the supported 32-bit range`,
      line,
      token.column,
      token.byteOffset,
    );
  }
  return value;
}

function parseLiteral(token: Token, line: number): number {
  if (!/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(token.text)) {
    throw new DimacsParseError(
      `Invalid DIMACS literal ${JSON.stringify(token.text)}`,
      line,
      token.column,
      token.byteOffset,
    );
  }

  const literal = Number(token.text);
  if (!Number.isSafeInteger(literal) || literal < -0x7fff_ffff || literal > 0x7fff_ffff) {
    throw new DimacsParseError(
      "Literal exceeds the supported signed 32-bit range",
      line,
      token.column,
      token.byteOffset,
    );
  }
  return literal;
}

function projectedEncodedBytes(literals: number, clauses: number): number {
  return 20 + (literals + clauses) * Int32Array.BYTES_PER_ELEMENT;
}

export async function parseDimacs(
  chunks: AsyncIterable<Uint8Array>,
  options: ParseDimacsOptions = {},
): Promise<ParsedDimacs> {
  let variableCount: number | null = null;
  let declaredClauseCount: number | null = null;
  let literalCount = 0;
  const clauses: number[][] = [];
  let currentClause: number[] = [];
  let pendingParts: Uint8Array[] = [];
  let pendingLength = 0;
  let line = 1;
  let lineOffset = 0;
  let bytesRead = 0;
  let lastProgressBytes = 0;
  let lastYieldBytes = 0;

  const processLine = (lineBytes: Uint8Array, absoluteOffset: number, lineNumber: number) => {
    const tokens = tokenizeLine(lineBytes, absoluteOffset, lineNumber);
    if (tokens.length === 0) return;

    if (tokens[0].text === "c") return;

    if (tokens[0].text === "p") {
      if (variableCount !== null) {
        throw new DimacsParseError(
          "DIMACS contains more than one problem header",
          lineNumber,
          tokens[0].column,
          tokens[0].byteOffset,
        );
      }
      if (clauses.length > 0 || currentClause.length > 0) {
        throw new DimacsParseError(
          "The problem header must appear before all clauses",
          lineNumber,
          tokens[0].column,
          tokens[0].byteOffset,
        );
      }
      if (tokens.length !== 4 || tokens[1].text !== "cnf") {
        throw new DimacsParseError(
          "Expected a header of the form: p cnf <variables> <clauses>",
          lineNumber,
          tokens[0].column,
          tokens[0].byteOffset,
        );
      }
      variableCount = parseUnsigned(tokens[2], "Variable count", lineNumber);
      declaredClauseCount = parseUnsigned(tokens[3], "Clause count", lineNumber);
      if (variableCount > MAX_VARIABLES) {
        throw new DimacsParseError(
          `Variable count exceeds the supported ${MAX_VARIABLES.toLocaleString("en-US")} variable limit`,
          lineNumber,
          tokens[2].column,
          tokens[2].byteOffset,
        );
      }
      if (declaredClauseCount > MAX_CLAUSES) {
        throw new DimacsParseError(
          `Clause count exceeds the supported ${MAX_CLAUSES.toLocaleString("en-US")} clause limit`,
          lineNumber,
          tokens[3].column,
          tokens[3].byteOffset,
        );
      }
      if (projectedEncodedBytes(0, declaredClauseCount) > MAX_ENCODED_FORMULA_BYTES) {
        throw new DimacsParseError(
          `Declared clauses exceed the ${MAX_ENCODED_FORMULA_BYTES}-byte encoded limit`,
          lineNumber,
          tokens[3].column,
          tokens[3].byteOffset,
        );
      }
      return;
    }

    if (variableCount === null || declaredClauseCount === null) {
      throw new DimacsParseError(
        "Expected a problem header before the first clause",
        lineNumber,
        tokens[0].column,
        tokens[0].byteOffset,
      );
    }

    for (const token of tokens) {
      const literal = parseLiteral(token, lineNumber);
      if (literal === 0) {
        clauses.push(currentClause);
        currentClause = [];
        if (clauses.length > declaredClauseCount) {
          throw new DimacsParseError(
            `Formula has more than the declared ${declaredClauseCount} clauses`,
            lineNumber,
            token.column,
            token.byteOffset,
          );
        }
        continue;
      }

      if (Math.abs(literal) > variableCount) {
        throw new DimacsParseError(
          `Literal ${literal} exceeds the declared variable count ${variableCount}`,
          lineNumber,
          token.column,
          token.byteOffset,
        );
      }

      literalCount += 1;
      if (literalCount > MAX_LITERAL_OCCURRENCES) {
        throw new DimacsParseError(
          `Formula exceeds the ${MAX_LITERAL_OCCURRENCES.toLocaleString("en-US")} literal-occurrence limit`,
          lineNumber,
          token.column,
          token.byteOffset,
        );
      }
      if (projectedEncodedBytes(literalCount, declaredClauseCount) > MAX_ENCODED_FORMULA_BYTES) {
        throw new DimacsParseError(
          `Formula exceeds the ${MAX_ENCODED_FORMULA_BYTES}-byte encoded limit`,
          lineNumber,
          token.column,
          token.byteOffset,
        );
      }
      currentClause.push(literal);
    }
  };

  for await (const chunk of chunks) {
    checkCancelled(options.signal);
    bytesRead += chunk.byteLength;
    if (bytesRead > MAX_DECOMPRESSED_DIMACS_BYTES) {
      throw new DimacsParseError(
        `DIMACS input exceeds the ${MAX_DECOMPRESSED_DIMACS_BYTES}-byte decompressed limit`,
        line,
        1,
        lineOffset,
      );
    }

    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 10) continue;
      const tail = chunk.subarray(start, index);
      let lineBytes: Uint8Array;
      if (pendingLength === 0) {
        lineBytes = tail;
      } else {
        lineBytes = new Uint8Array(pendingLength + tail.byteLength);
        let outputOffset = 0;
        for (const part of pendingParts) {
          lineBytes.set(part, outputOffset);
          outputOffset += part.byteLength;
        }
        lineBytes.set(tail, outputOffset);
      }
      processLine(lineBytes, lineOffset, line);
      lineOffset += lineBytes.byteLength + 1;
      line += 1;
      start = index + 1;
      pendingParts = [];
      pendingLength = 0;
    }
    if (start < chunk.byteLength) {
      const remainder = chunk.subarray(start);
      pendingParts.push(remainder);
      pendingLength += remainder.byteLength;
    }

    if (
      lastProgressBytes === 0 ||
      bytesRead - lastProgressBytes >= 64 * 1024 ||
      bytesRead === options.totalBytes
    ) {
      options.onProgress?.({ bytesRead, totalBytes: options.totalBytes, line });
      lastProgressBytes = bytesRead;
    }

    // Let a Dedicated Worker receive a cancellation message between input chunks.
    if (bytesRead - lastYieldBytes >= 256 * 1024) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYieldBytes = bytesRead;
    }
  }

  checkCancelled(options.signal);
  let pending: Uint8Array;
  if (pendingParts.length === 0) {
    pending = new Uint8Array(0);
  } else if (pendingParts.length === 1) {
    pending = pendingParts[0];
  } else {
    pending = new Uint8Array(pendingLength);
    let outputOffset = 0;
    for (const part of pendingParts) {
      pending.set(part, outputOffset);
      outputOffset += part.byteLength;
    }
  }
  if (pending.byteLength > 0) processLine(pending, lineOffset, line);
  if (bytesRead !== lastProgressBytes) {
    options.onProgress?.({ bytesRead, totalBytes: options.totalBytes, line });
  }

  if (variableCount === null || declaredClauseCount === null) {
    throw new DimacsParseError("Missing DIMACS problem header", line, 1, lineOffset);
  }
  if (currentClause.length > 0) {
    throw new DimacsParseError(
      "The final clause is missing its terminating 0",
      line,
      pending.byteLength + 1,
      bytesRead,
    );
  }
  if (clauses.length !== declaredClauseCount) {
    throw new DimacsParseError(
      `Header declares ${declaredClauseCount} clauses, but ${clauses.length} were parsed`,
      line,
      pending.byteLength + 1,
      bytesRead,
    );
  }

  return {
    variableCount,
    clauseCount: clauses.length,
    literalCount,
    clauses,
  };
}

export async function* chunksFromBytes(
  bytes: Uint8Array,
  chunkSize = 64 * 1024,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}

export async function parseDimacsText(
  text: string,
  options: ParseDimacsOptions = {},
): Promise<ParsedDimacs> {
  const bytes = new TextEncoder().encode(text);
  return parseDimacs(chunksFromBytes(bytes), { ...options, totalBytes: bytes.byteLength });
}
