import {
  PUBLIC_JOB_PROTOCOL_VERSION,
  type CreateJobInput,
  type CreateJobResult,
  type FormulaDeclaration,
  type PublicJobState,
  type PublicJobStatus,
} from "../../shared/public-jobs";
import { VerifiedFormulaCache, type CachedFormula } from "./formula/cache";
import { decodeHiveCnfV1, sha256Hex } from "./formula/hiveCnf";
import { MAX_COMPRESSED_FORMULA_BYTES, MAX_ENCODED_FORMULA_BYTES } from "./formula/limits";
import { MAX_UNSAT_PROOF_DECOMPRESSED_BYTES } from "../../shared/result-manifest";
import { verifyWithPinnedLratChecker } from "./lratChecker";

const DATABASE_NAME = "hivesat-public-jobs";
const DATABASE_VERSION = 2;
const OWNER_STORE = "owners";
const META_STORE = "metadata";
const DEVICE_KEY = "anonymous-device-id";

export interface OwnedPublicJobRecord {
  jobId: string;
  ownerToken: string | null;
  filename: string;
  formula: FormulaDeclaration | null;
  createdAt: number;
  expiresAt: number;
  lastStatus: PublicJobStatus | null;
  lastSyncedAt: number | null;
  terminalAt: number | null;
  unavailable: boolean;
}

interface LegacyOwnerRecord {
  jobId: string;
  ownerToken: string;
  expiresAt: number;
}

interface MetaRecord {
  key: string;
  value: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function randomDeviceId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export class PublicJobOwnerStore {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  async getDeviceId(): Promise<string> {
    const database = await this.openRequired();
    try {
      const read = database.transaction(META_STORE, "readonly");
      const record = await requestResult(
        read.objectStore(META_STORE).get(DEVICE_KEY) as IDBRequest<MetaRecord | undefined>,
      );
      await transactionDone(read);
      if (record) return record.value;

      const value = randomDeviceId();
      const write = database.transaction(META_STORE, "readwrite");
      write.objectStore(META_STORE).put({ key: DEVICE_KEY, value } satisfies MetaRecord);
      await transactionDone(write);
      return value;
    } finally {
      database.close();
    }
  }

  async saveOwner(record: LegacyOwnerRecord): Promise<void> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      const store = transaction.objectStore(OWNER_STORE);
      const existing = await requestResult(
        store.get(record.jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      store.put(normalizeOwnedRecord({ ...existing, ...record }));
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async getOwnerToken(jobId: string): Promise<string | null> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readonly");
      const record = await requestResult(
        transaction.objectStore(OWNER_STORE).get(jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      await transactionDone(transaction);
      return record && record.expiresAt > Date.now() ? record.ownerToken : null;
    } finally {
      database.close();
    }
  }

  async saveSubmission(input: {
    jobId: string;
    ownerToken: string;
    filename: string;
    formula: FormulaDeclaration;
    createdAt: number;
    expiresAt: number;
    status?: PublicJobStatus | null;
  }): Promise<void> {
    const record: OwnedPublicJobRecord = {
      jobId: input.jobId,
      ownerToken: input.ownerToken,
      filename: input.filename,
      formula: input.formula,
      createdAt: input.status?.createdAt ?? input.createdAt,
      expiresAt: input.status?.expiresAt ?? input.expiresAt,
      lastStatus: input.status ?? null,
      lastSyncedAt: input.status ? Date.now() : null,
      terminalAt: input.status && isTerminalPublicJobState(input.status.state) ? Date.now() : null,
      unavailable: false,
    };
    await this.put(record);
  }

  async listJobs(now = Date.now()): Promise<OwnedPublicJobRecord[]> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      const store = transaction.objectStore(OWNER_STORE);
      const raw = await requestResult(
        store.getAll() as IDBRequest<Array<OwnedPublicJobRecord | LegacyOwnerRecord>>,
      );
      const records = raw.map(normalizeOwnedRecord).map((record) => {
        if (record.expiresAt <= now && record.ownerToken) {
          const expired = { ...record, ownerToken: null };
          store.put(expired);
          return expired;
        }
        return record;
      });
      await transactionDone(transaction);
      return records.sort((left, right) => right.createdAt - left.createdAt);
    } finally {
      database.close();
    }
  }

  async updateStatus(status: PublicJobStatus, now = Date.now()): Promise<void> {
    const existing = await this.get(status.jobId);
    await this.put({
      ...(existing ?? normalizeOwnedRecord({
        jobId: status.jobId,
        ownerToken: null,
        expiresAt: status.expiresAt,
      })),
      formula: status.formula,
      createdAt: status.createdAt,
      expiresAt: status.expiresAt,
      lastStatus: status,
      lastSyncedAt: now,
      terminalAt: isTerminalPublicJobState(status.state)
        ? existing?.terminalAt ?? now
        : null,
      unavailable: false,
      ownerToken: status.expiresAt > now ? existing?.ownerToken ?? null : null,
    });
  }

  async markUnavailable(jobId: string, now = Date.now()): Promise<void> {
    const existing = await this.get(jobId);
    if (!existing) return;
    await this.put({
      ...existing,
      ownerToken: existing.expiresAt > now ? existing.ownerToken : null,
      unavailable: true,
      lastSyncedAt: now,
    });
  }

  async removeJob(jobId: string): Promise<void> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      transaction.objectStore(OWNER_STORE).delete(jobId);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async clearTerminalJobs(): Promise<void> {
    const records = await this.listJobs();
    await Promise.all(records
      .filter((record) => ownedJobGroup(record) === "completed" || ownedJobGroup(record) === "stopped")
      .map((record) => this.removeJob(record.jobId)));
  }

  private async get(jobId: string): Promise<OwnedPublicJobRecord | null> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readonly");
      const record = await requestResult(
        transaction.objectStore(OWNER_STORE).get(jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      await transactionDone(transaction);
      return record ? normalizeOwnedRecord(record) : null;
    } finally {
      database.close();
    }
  }

  private async put(record: OwnedPublicJobRecord): Promise<void> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      transaction.objectStore(OWNER_STORE).put(record);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private async openRequired(): Promise<IDBDatabase> {
    if (!this.factory) throw new Error("IndexedDB is required to retain anonymous job ownership.");
    const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OWNER_STORE)) {
        database.createObjectStore(OWNER_STORE, { keyPath: "jobId" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    return requestResult(request);
  }
}

function normalizeOwnedRecord(record: Partial<OwnedPublicJobRecord> & {
  jobId: string;
  ownerToken?: string | null;
  expiresAt: number;
}): OwnedPublicJobRecord {
  return {
    jobId: record.jobId,
    ownerToken: record.ownerToken ?? null,
    filename: record.filename ?? "Public SAT job",
    formula: record.formula ?? record.lastStatus?.formula ?? null,
    createdAt: record.createdAt ?? Math.max(0, record.expiresAt - 24 * 60 * 60 * 1_000),
    expiresAt: record.expiresAt,
    lastStatus: record.lastStatus ?? null,
    lastSyncedAt: record.lastSyncedAt ?? null,
    terminalAt: record.terminalAt ?? null,
    unavailable: record.unavailable ?? false,
  };
}

export type OwnedJobGroup = "submitted" | "in-progress" | "completed" | "stopped";

export function isTerminalPublicJobState(state: PublicJobState): boolean {
  return ["SAT_VERIFIED", "UNSAT_CERTIFIED", "UNSAT_OWNER_VERIFIED", "INVALID", "UNKNOWN", "CANCELLED"].includes(state);
}

export function ownedJobGroup(record: OwnedPublicJobRecord): OwnedJobGroup {
  if (record.unavailable || record.expiresAt <= Date.now() && !record.lastStatus) return "stopped";
  const state = record.lastStatus?.state ?? "UPLOADING";
  if (state === "UPLOADING" || state === "QUEUED") return "submitted";
  if (state === "RUNNING") return "in-progress";
  if (["SAT_VERIFIED", "UNSAT_CERTIFIED", "UNSAT_OWNER_VERIFIED"].includes(state)) return "completed";
  return "stopped";
}

export function publicJobStatusLabel(record: OwnedPublicJobRecord): string {
  if (record.unavailable) return record.expiresAt <= Date.now() ? "Expired" : "Status unavailable";
  const labels: Record<PublicJobState, string> = {
    UPLOADING: "Uploading",
    QUEUED: "Submitted",
    RUNNING: record.lastStatus?.certificate?.verification === "OWNER_CHECK_REQUIRED" ? "Proof check required" : "In progress",
    SAT_VERIFIED: "Completed · SAT",
    UNSAT_CERTIFIED: "Completed · UNSAT certified",
    UNSAT_OWNER_VERIFIED: "Completed · UNSAT owner verified",
    INVALID: "Invalid result",
    UNKNOWN: "Stopped without a verdict",
    CANCELLED: "Cancelled",
  };
  return labels[record.lastStatus?.state ?? "UPLOADING"];
}

export function ownerTokenFromFragment(fragment = window.location.hash): string | null {
  const value = new URLSearchParams(fragment.replace(/^#/u, "")).get("owner");
  return value && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

export function publicJobUrl(jobId: string, origin = window.location.origin): string {
  return `${origin}/jobs/${encodeURIComponent(jobId)}`;
}

async function apiJson<T>(response: Response): Promise<T> {
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? JSON.stringify((body as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(`HiveSAT public-job request failed: ${message}`);
  }
  return body as T;
}

export interface SubmitPublicJobOptions {
  turnstileToken: string;
  publicConsent: true;
  cachedFormula: CachedFormula;
  filename: string;
  ownerStore?: PublicJobOwnerStore;
  fetcher?: typeof fetch;
}

export async function submitPublicJob(options: SubmitPublicJobOptions): Promise<CreateJobResult> {
  const ownerStore = options.ownerStore ?? new PublicJobOwnerStore();
  const fetcher = options.fetcher ?? fetch;
  const deviceId = await ownerStore.getDeviceId();
  const formula: FormulaDeclaration = {
    hash: options.cachedFormula.hash,
    variableCount: options.cachedFormula.variableCount,
    clauseCount: options.cachedFormula.clauseCount,
    literalCount: options.cachedFormula.literalCount,
    encodedBytes: options.cachedFormula.encoded.byteLength,
    compressedBytes: options.cachedFormula.gzip.byteLength,
  };
  const input: CreateJobInput = {
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    deviceId,
    turnstileToken: options.turnstileToken,
    publicConsent: options.publicConsent,
    formula,
  };
  const created = await apiJson<CreateJobResult>(await fetcher("/api/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  const submittedAt = Date.now();
  await ownerStore.saveSubmission({
    jobId: created.jobId,
    ownerToken: created.ownerToken,
    filename: options.filename,
    formula,
    createdAt: submittedAt,
    expiresAt: created.expiresAt,
  });
  try {
    await apiJson(await fetcher(created.uploadUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${created.uploadToken}`,
        "content-type": "application/vnd.hivesat.cnf+gzip",
        "content-length": String(options.cachedFormula.gzip.byteLength),
      },
      body: options.cachedFormula.gzip.slice(0),
    }));
  } catch (error) {
    await fetcher(`/api/v1/jobs/${created.jobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.ownerToken}` },
    }).catch(() => undefined);
    await ownerStore.markUnavailable(created.jobId).catch(() => undefined);
    throw error;
  }
  const status = await getPublicJob(created.jobId, fetcher).catch(() => null);
  if (status) await ownerStore.updateStatus(status);
  return created;
}

export async function getPublicJob(jobId: string, fetcher: typeof fetch = fetch): Promise<PublicJobStatus> {
  return apiJson<PublicJobStatus>(await fetcher(`/api/v1/jobs/${encodeURIComponent(jobId)}`));
}

export async function cancelPublicJob(
  jobId: string,
  ownerToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await apiJson(await fetcher(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
  }));
}

export async function rotatePublicJobOwnerToken(
  jobId: string,
  ownerToken: string,
  expiresAt: number,
  fetcher: typeof fetch = fetch,
  ownerStore = new PublicJobOwnerStore(),
): Promise<string> {
  const result = await apiJson<{ ownerToken: string }>(await fetcher(
    `/api/v1/jobs/${encodeURIComponent(jobId)}/rotate-owner`,
    { method: "POST", headers: { authorization: `Bearer ${ownerToken}` } },
  ));
  await ownerStore.saveOwner({ jobId, ownerToken: result.ownerToken, expiresAt });
  const fragment = `owner=${encodeURIComponent(result.ownerToken)}`;
  history.replaceState(null, "", `${location.pathname}${location.search}#${fragment}`);
  return result.ownerToken;
}

export async function verifyAndConfirmOwnerProof(
  jobId: string,
  ownerToken: string,
  status: PublicJobStatus,
  fetcher: typeof fetch = fetch,
): Promise<PublicJobStatus> {
  const certificate = status.certificate;
  if (!certificate || certificate.verification !== "OWNER_CHECK_REQUIRED") {
    throw new Error("This job does not have a proof awaiting owner verification.");
  }
  const response = await fetcher(certificate.downloadUrl);
  if (!response.ok || !response.body) throw new Error("The LRAT certificate could not be downloaded.");
  const compressed = await collectBounded(response.body, certificate.compressedBytes, "proof compressed-byte");
  if (compressed.byteLength !== certificate.compressedBytes || await sha256Hex(compressed) !== certificate.artifactSha256) {
    throw new Error("The downloaded LRAT certificate does not match its public manifest.");
  }
  const proofStream = new Response(compressed.slice().buffer as ArrayBuffer).body;
  if (!proofStream) throw new Error("The LRAT certificate could not be decompressed.");
  const proofBytes = await collectBounded(
    proofStream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
    Math.min(certificate.decompressedBytes, MAX_UNSAT_PROOF_DECOMPRESSED_BYTES),
    "proof decompressed-byte",
  );
  if (proofBytes.byteLength !== certificate.decompressedBytes) {
    throw new Error("The decompressed LRAT certificate length is invalid.");
  }
  const encodedFormula = await downloadVerifiedPublicFormula(jobId, fetcher);
  decodeHiveCnfV1(encodedFormula);
  await verifyWithPinnedLratChecker({ encodedFormula, cube: certificate.cube, proof: proofBytes });
  await apiJson(await fetcher(`${certificate.downloadUrl}/owner-verify`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactSha256: certificate.artifactSha256 }),
  }));
  return getPublicJob(jobId, fetcher);
}

async function collectBounded(stream: ReadableStream<Uint8Array>, limit: number, label: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error(`Downloaded formula exceeds the ${label} limit.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function downloadVerifiedPublicFormula(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  return new Uint8Array((await loadVerifiedPublicFormula(jobId, fetcher)).encoded);
}

export async function loadVerifiedPublicFormula(
  jobId: string,
  fetcher: typeof fetch = fetch,
  cache = new VerifiedFormulaCache(),
): Promise<CachedFormula & { cacheHit: boolean; transferredBytes: number }> {
  const status = await getPublicJob(jobId, fetcher);
  const cached = await cache.get(status.formula.hash);
  if (cached) return { ...cached, cacheHit: true, transferredBytes: 0 };
  const response = await fetcher(`/api/v1/jobs/${encodeURIComponent(jobId)}/formula`);
  if (!response.ok || !response.body) throw new Error("The public formula could not be downloaded.");
  const declaredHeader = response.headers.get("x-hivesat-formula-sha256");
  if (declaredHeader !== status.formula.hash) throw new Error("Formula download metadata does not match job status.");
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress public formulas.");
  const gzip = await collectBounded(response.body, MAX_COMPRESSED_FORMULA_BYTES, "compressed-byte");
  const compressedStream = new Response(gzip.slice().buffer as ArrayBuffer).body;
  if (!compressedStream) throw new Error("The downloaded formula could not be streamed.");
  const stream = compressedStream.pipeThrough(
    new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const encoded = await collectBounded(stream, MAX_ENCODED_FORMULA_BYTES, "encoded-byte");
  const decoded = decodeHiveCnfV1(encoded);
  if (await sha256Hex(encoded) !== status.formula.hash) {
    throw new Error("Downloaded formula failed its declared SHA-256 verification.");
  }
  const record: CachedFormula = {
    hash: status.formula.hash,
    encoded: encoded.slice().buffer as ArrayBuffer,
    gzip: gzip.slice().buffer as ArrayBuffer,
    variableCount: decoded.variableCount,
    clauseCount: decoded.clauseCount,
    literalCount: decoded.literalCount,
    verifiedAt: Date.now(),
  };
  await cache.put(record);
  return { ...record, cacheHit: false, transferredBytes: gzip.byteLength };
}
