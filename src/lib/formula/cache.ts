import { decodeHiveCnfV1, sha256Hex } from "./hiveCnf";
import { MAX_COMPRESSED_FORMULA_BYTES } from "./limits";

const DATABASE_NAME = "hivesat-formulas";
const DATABASE_VERSION = 1;
const STORE_NAME = "verified-formulas";

export interface CachedFormula {
  hash: string;
  encoded: ArrayBuffer;
  gzip: ArrayBuffer;
  variableCount: number;
  clauseCount: number;
  literalCount: number;
  verifiedAt: number;
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

export class VerifiedFormulaCache {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  async get(hash: string): Promise<CachedFormula | null> {
    const database = await this.open();
    if (!database) return null;
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const done = transactionDone(transaction);
      const record = await requestResult(
        transaction.objectStore(STORE_NAME).get(hash) as IDBRequest<CachedFormula | undefined>,
      );
      await done;
      if (!record) return null;

      const encoded = new Uint8Array(record.encoded);
      const decoded = decodeHiveCnfV1(encoded);
      const actualHash = await sha256Hex(encoded);
      if (
        actualHash !== hash ||
        decoded.variableCount !== record.variableCount ||
        decoded.clauseCount !== record.clauseCount ||
        decoded.literalCount !== record.literalCount ||
        record.gzip.byteLength > MAX_COMPRESSED_FORMULA_BYTES
      ) {
        await this.delete(hash);
        return null;
      }
      return record;
    } finally {
      database.close();
    }
  }

  async put(record: CachedFormula): Promise<void> {
    const encoded = new Uint8Array(record.encoded);
    const decoded = decodeHiveCnfV1(encoded);
    const actualHash = await sha256Hex(encoded);
    if (actualHash !== record.hash) throw new Error("Refusing to cache a formula with a mismatched hash.");
    if (
      decoded.variableCount !== record.variableCount ||
      decoded.clauseCount !== record.clauseCount ||
      decoded.literalCount !== record.literalCount
    ) {
      throw new Error("Refusing to cache a formula with mismatched metadata.");
    }
    if (record.gzip.byteLength > MAX_COMPRESSED_FORMULA_BYTES) {
      throw new Error("Refusing to cache an oversized compressed formula.");
    }

    const database = await this.open();
    if (!database) return;
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(STORE_NAME).put(record);
      await done;
    } finally {
      database.close();
    }
  }

  private async delete(hash: string): Promise<void> {
    const database = await this.open();
    if (!database) return;
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(STORE_NAME).delete(hash);
      await done;
    } finally {
      database.close();
    }
  }

  private async open(): Promise<IDBDatabase | null> {
    if (!this.factory) return null;
    const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "hash" });
      }
    };
    return requestResult(request);
  }
}
