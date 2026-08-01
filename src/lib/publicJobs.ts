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
      const readDone = transactionDone(read);
      const record = await requestResult(
        read.objectStore(META_STORE).get(DEVICE_KEY) as IDBRequest<MetaRecord | undefined>,
      );
      await readDone;
      if (record) return record.value;

      const value = randomDeviceId();
      const write = database.transaction(META_STORE, "readwrite");
      const writeDone = transactionDone(write);
      write.objectStore(META_STORE).put({ key: DEVICE_KEY, value } satisfies MetaRecord);
      await writeDone;
      return value;
    } finally {
      database.close();
    }
  }

  async saveOwner(record: LegacyOwnerRecord): Promise<void> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(OWNER_STORE);
      const existing = await requestResult(
        store.get(record.jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      store.put(normalizeOwnedRecord({ ...existing, ...record }));
      await done;
    } finally {
      database.close();
    }
  }

  async getOwnerToken(jobId: string): Promise<string | null> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readonly");
      const done = transactionDone(transaction);
      const record = await requestResult(
        transaction.objectStore(OWNER_STORE).get(jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      await done;
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
      const done = transactionDone(transaction);
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
      await done;
      return records.sort((left, right) => right.createdAt - left.createdAt);
    } finally {
      database.close();
    }
  }

  async updateStatus(status: PublicJobStatus, observedAt = Date.now()): Promise<boolean> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(OWNER_STORE);
      const raw = await requestResult(
        store.get(status.jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      const existing = raw ? normalizeOwnedRecord(raw) : null;
      const staleObservation = existing?.lastSyncedAt !== null &&
        existing?.lastSyncedAt !== undefined && observedAt < existing.lastSyncedAt;
      const stateRegression = existing?.lastStatus &&
        !isMonotonicPublicJobStatus(existing.lastStatus, status);
      if (staleObservation || stateRegression) {
        await done;
        return false;
      }
      store.put({
        ...(existing ?? normalizeOwnedRecord({
          jobId: status.jobId,
          ownerToken: null,
          expiresAt: status.expiresAt,
        })),
        formula: status.formula,
        createdAt: status.createdAt,
        expiresAt: status.expiresAt,
        lastStatus: status,
        lastSyncedAt: observedAt,
        terminalAt: isTerminalPublicJobState(status.state)
          ? existing?.terminalAt ?? observedAt
          : null,
        unavailable: false,
        ownerToken: status.expiresAt > observedAt ? existing?.ownerToken ?? null : null,
      });
      await done;
      return true;
    } finally {
      database.close();
    }
  }

  async markUnavailable(jobId: string, observedAt = Date.now()): Promise<boolean> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(OWNER_STORE);
      const raw = await requestResult(
        store.get(jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      if (!raw) {
        await done;
        return false;
      }
      const existing = normalizeOwnedRecord(raw);
      if (existing.lastSyncedAt !== null && observedAt < existing.lastSyncedAt) {
        await done;
        return false;
      }
      store.put({
        ...existing,
        ownerToken: existing.expiresAt > observedAt ? existing.ownerToken : null,
        unavailable: true,
        lastSyncedAt: observedAt,
      });
      await done;
      return true;
    } finally {
      database.close();
    }
  }

  async removeJob(jobId: string): Promise<void> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(OWNER_STORE).delete(jobId);
      await done;
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
      const done = transactionDone(transaction);
      const record = await requestResult(
        transaction.objectStore(OWNER_STORE).get(jobId) as IDBRequest<OwnedPublicJobRecord | LegacyOwnerRecord | undefined>,
      );
      await done;
      return record ? normalizeOwnedRecord(record) : null;
    } finally {
      database.close();
    }
  }

  private async put(record: OwnedPublicJobRecord): Promise<void> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(OWNER_STORE).put(record);
      await done;
    } finally {
      database.close();
    }
  }

  private async openRequired(): Promise<IDBDatabase> {
    if (!this.factory) throw new Error("IndexedDB is required to retain anonymous job ownership.");
    const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
    return new Promise((resolve, reject) => {
      let settled = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(OWNER_STORE)) {
          database.createObjectStore(OWNER_STORE, { keyPath: "jobId" });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error("IndexedDB could not open job history."));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error("Job history is blocked by another open HiveSAT tab. Close or reload the other tab and try again."));
      };
    });
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
export type OwnedJobListGroup = "active" | "finished";

export function isTerminalPublicJobState(state: PublicJobState): boolean {
  return ["SAT_VERIFIED", "UNSAT_CERTIFIED", "UNSAT_OWNER_VERIFIED", "INVALID", "UNKNOWN", "CANCELLED"].includes(state);
}

const ACTIVE_STATE_ORDER: Partial<Record<PublicJobState, number>> = {
  UPLOADING: 0,
  QUEUED: 1,
  RUNNING: 2,
};

export function isMonotonicPublicJobStatus(
  current: PublicJobStatus,
  incoming: PublicJobStatus,
): boolean {
  if (current.jobId !== incoming.jobId) return false;
  if (current.state === incoming.state) {
    if (current.uploadedBytes !== null && incoming.uploadedBytes !== null &&
      incoming.uploadedBytes < current.uploadedBytes) return false;
    const certificateOrder = {
      OWNER_CHECK_REQUIRED: 0,
      SERVER_CERTIFIED: 1,
      OWNER_VERIFIED: 2,
    } as const;
    if (current.certificate && !incoming.certificate) return false;
    if (current.certificate && incoming.certificate &&
      certificateOrder[incoming.certificate.verification] < certificateOrder[current.certificate.verification]) {
      return false;
    }
    return true;
  }
  if (current.state === "UNSAT_CERTIFIED" && incoming.state === "UNSAT_OWNER_VERIFIED") return true;
  if (isTerminalPublicJobState(current.state)) return false;
  if (isTerminalPublicJobState(incoming.state)) return true;
  return (ACTIVE_STATE_ORDER[incoming.state] ?? -1) >= (ACTIVE_STATE_ORDER[current.state] ?? -1);
}

export function ownedJobGroup(record: OwnedPublicJobRecord, now = Date.now()): OwnedJobGroup {
  const expiredWithoutTerminalResult = record.expiresAt <= now &&
    (!record.lastStatus || !isTerminalPublicJobState(record.lastStatus.state));
  if (record.unavailable || expiredWithoutTerminalResult) return "stopped";
  const state = record.lastStatus?.state ?? "UPLOADING";
  if (state === "UPLOADING" || state === "QUEUED") return "submitted";
  if (state === "RUNNING") return "in-progress";
  if (["SAT_VERIFIED", "UNSAT_CERTIFIED", "UNSAT_OWNER_VERIFIED"].includes(state)) return "completed";
  return "stopped";
}

export function ownedJobListGroup(record: OwnedPublicJobRecord, now = Date.now()): OwnedJobListGroup {
  const badgeGroup = ownedJobGroup(record, now);
  return badgeGroup === "submitted" || badgeGroup === "in-progress" ? "active" : "finished";
}

export function publicJobStatusLabel(record: OwnedPublicJobRecord, now = Date.now()): string {
  if (record.expiresAt <= now && (!record.lastStatus || !isTerminalPublicJobState(record.lastStatus.state))) {
    return "Expired";
  }
  if (record.unavailable) return record.expiresAt <= now ? "Expired" : "Status unavailable";
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

export class PublicJobApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "PublicJobApiError";
  }
}

export function isPublicJobNotFoundError(error: unknown): boolean {
  return error instanceof PublicJobApiError &&
    (error.status === 404 || error.code === "JOB_NOT_FOUND");
}

async function apiJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch (error) {
    if (response.ok && response.status !== 204) throw error;
    body = null;
  }
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body
      ? (body as { error: unknown }).error
      : null;
    const code = typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
    const message = typeof error === "object" && error !== null && "message" in error &&
      typeof (error as { message: unknown }).message === "string"
      ? (error as { message: string }).message
      : `The server returned HTTP ${response.status}.`;
    throw new PublicJobApiError(message, response.status, code);
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
    const cancelled = await fetcher(`/api/v1/jobs/${created.jobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.ownerToken}` },
    }).then((response) => response.ok).catch(() => false);
    if (cancelled) {
      await ownerStore.updateStatus({
        protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
        jobId: created.jobId,
        state: "CANCELLED",
        formula,
        createdAt: submittedAt,
        expiresAt: created.expiresAt,
        uploadedBytes: null,
        rootTaskState: "CANCELLED",
        certificate: null,
      }).catch(() => undefined);
    }
    throw error;
  }
  const status = await getPublicJob(created.jobId, fetcher).catch(() => null);
  if (status) await ownerStore.updateStatus(status);
  return created;
}

export async function getPublicJob(
  jobId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PublicJobStatus> {
  return apiJson<PublicJobStatus>(await fetcher(
    `/api/v1/jobs/${encodeURIComponent(jobId)}`,
    signal ? { signal } : undefined,
  ));
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
  if (!response.ok) await apiJson<never>(response);
  if (!response.body) throw new Error("The public formula could not be downloaded.");
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
