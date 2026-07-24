import {
  PUBLIC_JOB_PROTOCOL_VERSION,
  type CreateJobInput,
  type CreateJobResult,
  type FormulaDeclaration,
  type PublicJobStatus,
} from "../../shared/public-jobs";
import type { CachedFormula } from "./formula/cache";
import { decodeHiveCnfV1, sha256Hex } from "./formula/hiveCnf";
import { MAX_ENCODED_FORMULA_BYTES } from "./formula/limits";

const DATABASE_NAME = "hivesat-public-jobs";
const DATABASE_VERSION = 1;
const OWNER_STORE = "owners";
const META_STORE = "metadata";
const DEVICE_KEY = "anonymous-device-id";

interface OwnerRecord {
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

  async saveOwner(record: OwnerRecord): Promise<void> {
    const database = await this.openRequired();
    try {
      const transaction = database.transaction(OWNER_STORE, "readwrite");
      transaction.objectStore(OWNER_STORE).put(record);
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
        transaction.objectStore(OWNER_STORE).get(jobId) as IDBRequest<OwnerRecord | undefined>,
      );
      await transactionDone(transaction);
      return record && record.expiresAt > Date.now() ? record.ownerToken : null;
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
  await ownerStore.saveOwner({
    jobId: created.jobId,
    ownerToken: created.ownerToken,
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
    throw error;
  }
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

async function collectBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ENCODED_FORMULA_BYTES) throw new Error("Downloaded formula exceeds the encoded-byte limit.");
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
  const status = await getPublicJob(jobId, fetcher);
  const response = await fetcher(`/api/v1/jobs/${encodeURIComponent(jobId)}/formula`);
  if (!response.ok || !response.body) throw new Error("The public formula could not be downloaded.");
  const declaredHeader = response.headers.get("x-hivesat-formula-sha256");
  if (declaredHeader !== status.formula.hash) throw new Error("Formula download metadata does not match job status.");
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress public formulas.");
  const stream = response.body.pipeThrough(
    new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const encoded = await collectBounded(stream);
  decodeHiveCnfV1(encoded);
  if (await sha256Hex(encoded) !== status.formula.hash) {
    throw new Error("Downloaded formula failed its declared SHA-256 verification.");
  }
  return encoded;
}
