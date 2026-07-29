const DATABASE_NAME = "hivesat-swarm-stats";
const DATABASE_VERSION = 1;
const STORE_NAME = "totals";
const DEVICE_TOTALS_KEY = "device-lifetime";
const SESSION_TOTALS_KEY = "current-session";

export interface SwarmTotals {
  activeWorkerMs: number;
  conflicts: number;
  decisions: number;
  propagations: number;
  acceptedCubes: number;
  completedCubes: number;
  uniqueJobsHelped: number;
  decisiveSatResults: number;
  certifiedUnsatResults: number;
  formulaBytesTransferred: number;
  wasmMemoryHighWaterBytes: number;
}

export const EMPTY_SWARM_TOTALS: SwarmTotals = {
  activeWorkerMs: 0,
  conflicts: 0,
  decisions: 0,
  propagations: 0,
  acceptedCubes: 0,
  completedCubes: 0,
  uniqueJobsHelped: 0,
  decisiveSatResults: 0,
  certifiedUnsatResults: 0,
  formulaBytesTransferred: 0,
  wasmMemoryHighWaterBytes: 0,
};

interface StoredTotals extends SwarmTotals {
  key: string;
  updatedAt: number;
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

function bounded(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : 0;
}

function parseTotals(value: unknown): SwarmTotals {
  if (typeof value !== "object" || value === null) return { ...EMPTY_SWARM_TOTALS };
  const record = value as Record<string, unknown>;
  return {
    activeWorkerMs: bounded(record.activeWorkerMs),
    conflicts: bounded(record.conflicts),
    decisions: bounded(record.decisions),
    propagations: bounded(record.propagations),
    acceptedCubes: bounded(record.acceptedCubes),
    completedCubes: bounded(record.completedCubes),
    uniqueJobsHelped: bounded(record.uniqueJobsHelped),
    decisiveSatResults: bounded(record.decisiveSatResults),
    certifiedUnsatResults: bounded(record.certifiedUnsatResults),
    formulaBytesTransferred: bounded(record.formulaBytesTransferred),
    wasmMemoryHighWaterBytes: bounded(record.wasmMemoryHighWaterBytes),
  };
}

export class SwarmStatsStore {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  async load(): Promise<SwarmTotals> {
    return this.loadKey(DEVICE_TOTALS_KEY);
  }

  async loadSession(): Promise<SwarmTotals> {
    return this.loadKey(SESSION_TOTALS_KEY);
  }

  private async loadKey(key: string): Promise<SwarmTotals> {
    const database = await this.open();
    if (!database) return { ...EMPTY_SWARM_TOTALS };
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const record = await requestResult(
        transaction.objectStore(STORE_NAME).get(key) as IDBRequest<StoredTotals | undefined>,
      );
      await transactionDone(transaction);
      return parseTotals(record);
    } finally {
      database.close();
    }
  }

  async save(totals: SwarmTotals): Promise<void> {
    await this.saveKey(DEVICE_TOTALS_KEY, totals);
  }

  async saveSession(totals: SwarmTotals): Promise<void> {
    await this.saveKey(SESSION_TOTALS_KEY, totals);
  }

  private async saveKey(key: string, totals: SwarmTotals): Promise<void> {
    const database = await this.open();
    if (!database) return;
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({
        key,
        ...parseTotals(totals),
        updatedAt: Date.now(),
      } satisfies StoredTotals);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async reset(): Promise<void> {
    await Promise.all([
      this.save(EMPTY_SWARM_TOTALS),
      this.saveSession(EMPTY_SWARM_TOTALS),
    ]);
  }

  private async open(): Promise<IDBDatabase | null> {
    if (!this.factory) return null;
    const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    return requestResult(request);
  }
}
