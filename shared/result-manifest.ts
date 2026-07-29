export const SAT_MODEL_ARTIFACT_VERSION = 1 as const;
export const MAX_SAT_MODEL_ARTIFACT_BYTES = 512 * 1024;
const MAGIC = Uint8Array.from([0x48, 0x53, 0x4d, 0x4f, 0x44, 0x4c, 0x30, 0x31]); // HSMODL01
const FIXED_HEADER_BYTES = 12;
const MAX_METADATA_BYTES = 8 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface SatModelMetadata {
  version: typeof SAT_MODEL_ARTIFACT_VERSION;
  formulaHash: string;
  taskId: string;
  cube: number[];
  pathHash: string;
  solverVersion: string;
  variableCount: number;
}

export interface SatResultManifest extends SatModelMetadata {
  kind: "SAT_MODEL_V1";
  artifactId: string;
  artifactSha256: string;
  artifactBytes: number;
}

export interface UnsatCandidateManifest {
  kind: "UNSAT_CANDIDATE_V1";
  formulaHash: string;
  taskId: string;
  cube: number[];
  pathHash: string;
  solverVersion: string;
}

export type ResultManifest = SatResultManifest | UnsatCandidateManifest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCube(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 64 &&
    value.every((literal) => Number.isSafeInteger(literal) && literal !== 0 && Math.abs(literal) <= 0x7fff_ffff) &&
    new Set(value.map((literal) => Math.abs(literal))).size === value.length;
}

function commonMetadata(value: Record<string, unknown>): Omit<UnsatCandidateManifest, "kind"> | null {
  if (
    typeof value.formulaHash !== "string" || !SHA256_PATTERN.test(value.formulaHash) ||
    typeof value.taskId !== "string" || !ID_PATTERN.test(value.taskId) ||
    !isCube(value.cube) ||
    typeof value.pathHash !== "string" || !SHA256_PATTERN.test(value.pathHash) ||
    typeof value.solverVersion !== "string" || value.solverVersion.length < 1 || value.solverVersion.length > 64
  ) return null;
  return {
    formulaHash: value.formulaHash,
    taskId: value.taskId,
    cube: [...value.cube],
    pathHash: value.pathHash,
    solverVersion: value.solverVersion,
  };
}

export function parseResultManifest(value: unknown): ResultManifest | null {
  if (!isRecord(value)) return null;
  const common = commonMetadata(value);
  if (!common) return null;
  if (value.kind === "UNSAT_CANDIDATE_V1") return { kind: value.kind, ...common };
  if (
    value.kind !== "SAT_MODEL_V1" ||
    value.version !== SAT_MODEL_ARTIFACT_VERSION ||
    typeof value.artifactId !== "string" || !ID_PATTERN.test(value.artifactId) ||
    typeof value.artifactSha256 !== "string" || !SHA256_PATTERN.test(value.artifactSha256) ||
    !Number.isSafeInteger(value.artifactBytes) ||
    Number(value.artifactBytes) < FIXED_HEADER_BYTES ||
    Number(value.artifactBytes) > MAX_SAT_MODEL_ARTIFACT_BYTES ||
    !Number.isSafeInteger(value.variableCount) ||
    Number(value.variableCount) < 0 ||
    Number(value.variableCount) > 2_000_000
  ) return null;
  return {
    kind: value.kind,
    version: SAT_MODEL_ARTIFACT_VERSION,
    ...common,
    artifactId: value.artifactId,
    artifactSha256: value.artifactSha256,
    artifactBytes: Number(value.artifactBytes),
    variableCount: Number(value.variableCount),
  };
}

function metadataJson(metadata: SatModelMetadata): string {
  return JSON.stringify({
    version: SAT_MODEL_ARTIFACT_VERSION,
    formulaHash: metadata.formulaHash,
    taskId: metadata.taskId,
    cube: metadata.cube,
    pathHash: metadata.pathHash,
    solverVersion: metadata.solverVersion,
    variableCount: metadata.variableCount,
  });
}

export function encodeSatModelArtifact(metadata: SatModelMetadata, model: readonly number[]): Uint8Array {
  const parsed = parseResultManifest({
    kind: "SAT_MODEL_V1",
    ...metadata,
    artifactId: "placeholder",
    artifactSha256: "00".repeat(32),
    artifactBytes: FIXED_HEADER_BYTES,
  });
  if (!parsed || model.length !== metadata.variableCount) {
    throw new Error("SAT model metadata or assignment length is invalid.");
  }
  const header = new TextEncoder().encode(metadataJson(metadata));
  if (header.byteLength > MAX_METADATA_BYTES) throw new Error("SAT model metadata is too large.");
  const bitset = new Uint8Array(Math.ceil(metadata.variableCount / 8));
  for (let index = 0; index < model.length; index += 1) {
    const literal = model[index];
    if (!Number.isSafeInteger(literal) || Math.abs(literal) !== index + 1) {
      throw new Error("SAT model must contain exactly one ordered literal per variable.");
    }
    if (literal > 0) bitset[index >> 3] |= 1 << (index & 7);
  }
  const output = new Uint8Array(FIXED_HEADER_BYTES + header.byteLength + bitset.byteLength);
  if (output.byteLength > MAX_SAT_MODEL_ARTIFACT_BYTES) throw new Error("SAT model artifact is too large.");
  output.set(MAGIC);
  new DataView(output.buffer).setUint32(8, header.byteLength, true);
  output.set(header, FIXED_HEADER_BYTES);
  output.set(bitset, FIXED_HEADER_BYTES + header.byteLength);
  return output;
}

export function decodeSatModelArtifact(bytes: Uint8Array): {
  metadata: SatModelMetadata;
  assignment: Uint8Array;
} {
  if (bytes.byteLength < FIXED_HEADER_BYTES || bytes.byteLength > MAX_SAT_MODEL_ARTIFACT_BYTES) {
    throw new Error("SAT model artifact byte length is invalid.");
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw new Error("SAT model artifact magic/version is invalid.");
  }
  const headerBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (headerBytes < 2 || headerBytes > MAX_METADATA_BYTES || FIXED_HEADER_BYTES + headerBytes > bytes.byteLength) {
    throw new Error("SAT model artifact metadata length is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + headerBytes))) as unknown;
  } catch {
    throw new Error("SAT model artifact metadata is not valid JSON.");
  }
  const parsed = parseResultManifest({
    ...(isRecord(value) ? value : {}),
    kind: "SAT_MODEL_V1",
    artifactId: "placeholder",
    artifactSha256: "00".repeat(32),
    artifactBytes: bytes.byteLength,
  });
  if (!parsed || parsed.kind !== "SAT_MODEL_V1") throw new Error("SAT model artifact metadata is invalid.");
  const assignment = bytes.subarray(FIXED_HEADER_BYTES + headerBytes);
  if (assignment.byteLength !== Math.ceil(parsed.variableCount / 8)) {
    throw new Error("SAT model bitset length does not match its variable count.");
  }
  return {
    metadata: {
      version: parsed.version,
      formulaHash: parsed.formulaHash,
      taskId: parsed.taskId,
      cube: parsed.cube,
      pathHash: parsed.pathHash,
      solverVersion: parsed.solverVersion,
      variableCount: parsed.variableCount,
    },
    assignment,
  };
}

export function bitsetValue(bitset: Uint8Array, variable: number): boolean {
  if (!Number.isSafeInteger(variable) || variable < 1 || variable > bitset.byteLength * 8) {
    throw new Error("Bitset variable is out of range.");
  }
  const index = variable - 1;
  return (bitset[index >> 3] & (1 << (index & 7))) !== 0;
}

export async function resultPathHash(cube: readonly number[]): Promise<string> {
  if (!isCube(cube)) throw new Error("Cannot hash an invalid cube path.");
  const bytes = new Uint8Array(cube.length * 4);
  const view = new DataView(bytes.buffer);
  cube.forEach((literal, index) => view.setInt32(index * 4, literal, true));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function satModelObjectKey(jobId: string, artifactId: string): string {
  return `jobs/${jobId}/models/${artifactId}.hsmodel`;
}
