import { describe, expect, it, vi } from "vitest";
import type { PublicJobStatus } from "../../shared/public-jobs";
import { encodeHiveCnfV1, sha256Hex } from "./formula/hiveCnf";
import {
  downloadVerifiedPublicFormula,
  getPublicJob,
  isMonotonicPublicJobStatus,
  isPublicJobNotFoundError,
  ownedJobGroup,
  ownedJobListGroup,
  ownerTokenFromFragment,
  publicJobStatusLabel,
  publicJobUrl,
  type OwnedPublicJobRecord,
} from "./publicJobs";

function status(state: PublicJobStatus["state"], overrides: Partial<PublicJobStatus> = {}): PublicJobStatus {
  return {
    protocolVersion: 4,
    jobId: "job",
    state,
    formula: {
      hash: "ab".repeat(32),
      variableCount: 1,
      clauseCount: 1,
      literalCount: 1,
      encodedBytes: 24,
      compressedBytes: 20,
    },
    createdAt: 1_000,
    expiresAt: 10_000,
    uploadedBytes: 20,
    rootTaskState: "READY",
    certificate: null,
    ...overrides,
  };
}

describe("public job browser trust boundary", () => {
  it("groups browser-owned jobs and presents terminal verdicts clearly", () => {
    const base: OwnedPublicJobRecord = {
      jobId: "job",
      ownerToken: null,
      filename: "sample.cnf",
      formula: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      lastStatus: null,
      lastSyncedAt: null,
      terminalAt: null,
      unavailable: false,
    };
    expect(ownedJobGroup(base)).toBe("submitted");
    const completed = {
      ...base,
      lastStatus: status("SAT_VERIFIED", { createdAt: base.createdAt, expiresAt: base.expiresAt }),
    } satisfies OwnedPublicJobRecord;
    expect(ownedJobGroup(completed)).toBe("completed");
    expect(publicJobStatusLabel(completed)).toBe("Completed · SAT");
    expect(ownedJobGroup({ ...base, unavailable: true })).toBe("stopped");
  });

  it("places submitted/running jobs under Active and terminal/local-expiry jobs under Finished", () => {
    const base: OwnedPublicJobRecord = {
      jobId: "job",
      ownerToken: null,
      filename: "sample.cnf",
      formula: null,
      createdAt: 1_000,
      expiresAt: 10_000,
      lastStatus: status("RUNNING"),
      lastSyncedAt: 2_000,
      terminalAt: null,
      unavailable: false,
    };
    expect(ownedJobGroup(base, 5_000)).toBe("in-progress");
    expect(ownedJobListGroup(base, 5_000)).toBe("active");
    expect(ownedJobGroup(base, 10_001)).toBe("stopped");
    expect(ownedJobListGroup(base, 10_001)).toBe("finished");
    expect(publicJobStatusLabel(base, 10_001)).toBe("Expired");

    const completed = { ...base, lastStatus: status("SAT_VERIFIED") };
    expect(ownedJobGroup(completed, 10_001)).toBe("completed");
    expect(ownedJobListGroup(completed, 10_001)).toBe("finished");
  });

  it("accepts forward status changes while rejecting stale regressions", () => {
    expect(isMonotonicPublicJobStatus(status("QUEUED"), status("RUNNING"))).toBe(true);
    expect(isMonotonicPublicJobStatus(status("RUNNING"), status("QUEUED"))).toBe(false);
    expect(isMonotonicPublicJobStatus(status("RUNNING"), status("UNKNOWN"))).toBe(true);
    expect(isMonotonicPublicJobStatus(status("UNKNOWN"), status("RUNNING"))).toBe(false);
    expect(isMonotonicPublicJobStatus(
      status("UPLOADING", { uploadedBytes: 20 }),
      status("UPLOADING", { uploadedBytes: 10 }),
    )).toBe(false);
    expect(isMonotonicPublicJobStatus(status("UNSAT_CERTIFIED"), status("UNSAT_OWNER_VERIFIED"))).toBe(true);
    expect(isMonotonicPublicJobStatus(status("SAT_VERIFIED"), status("UNSAT_CERTIFIED"))).toBe(false);
  });

  it("keeps owner credentials in the fragment and public links credential-free", () => {
    const token = "a".repeat(43);
    expect(ownerTokenFromFragment(`#owner=${token}`)).toBe(token);
    expect(ownerTokenFromFragment("#owner=bad token")).toBeNull();
    expect(publicJobUrl("public-job", "https://hive.example")).toBe("https://hive.example/jobs/public-job");
  });

  it("decompresses, decodes, and verifies every downloaded formula hash", async () => {
    const encoded = encodeHiveCnfV1({
      variableCount: 2,
      clauseCount: 2,
      literalCount: 3,
      clauses: [[1, -2], [2]],
    });
    const hash = await sha256Hex(encoded);
    const gzip = Uint8Array.from(
      atob("H4sIAAAAAAAAE/PwDHN19nMzZGJgYABhZiBmBOJ/////Z4CKgQAAwzmowSgAAAA="),
      (value) => value.charCodeAt(0),
    );
    const status = {
      protocolVersion: 4,
      jobId: "job",
      state: "QUEUED",
      formula: {
        hash,
        variableCount: 2,
        clauseCount: 2,
        literalCount: 3,
        encodedBytes: encoded.byteLength,
        compressedBytes: gzip.byteLength,
      },
      createdAt: 1,
      expiresAt: 2,
      uploadedBytes: gzip.byteLength,
      rootTaskState: "READY",
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/formula")) {
        return new Response(gzip.slice().buffer, { headers: { "x-hivesat-formula-sha256": hash } });
      }
      return Response.json(status);
    });

    await expect(downloadVerifiedPublicFormula("job", fetcher)).resolves.toEqual(encoded);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when download metadata disagrees with public status", async () => {
    const hash = "ab".repeat(32);
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/formula")
      ? new Response(new Uint8Array([1]), { headers: { "x-hivesat-formula-sha256": "cd".repeat(32) } })
      : Response.json({
          protocolVersion: 4,
          jobId: "job",
          state: "QUEUED",
          formula: { hash, variableCount: 0, clauseCount: 0, literalCount: 0, encodedBytes: 20, compressedBytes: 1 },
          createdAt: 1,
          expiresAt: 2,
          uploadedBytes: 1,
          rootTaskState: "READY",
        }));

    await expect(downloadVerifiedPublicFormula("job", fetcher)).rejects.toThrow(/metadata does not match/u);
  });

  it("surfaces the server's human-readable failure reason", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      error: { code: "ACTIVE_JOB_LIMIT", message: "This device already has an active public job." },
    }, { status: 429 }));

    await expect(getPublicJob("job", fetcher)).rejects.toThrow(
      "This device already has an active public job.",
    );
  });

  it("classifies only structured not-found responses as unavailable", async () => {
    const missing = await getPublicJob("job", vi.fn<typeof fetch>(async () => Response.json({
      error: { code: "JOB_NOT_FOUND", message: "Gone." },
    }, { status: 404 }))).catch((error: unknown) => error);
    const transient = await getPublicJob("job", vi.fn<typeof fetch>(async () => Response.json({
      error: { code: "STORAGE_UNAVAILABLE", message: "Job not found in a transient replica." },
    }, { status: 503 }))).catch((error: unknown) => error);
    const empty404 = await getPublicJob("job", vi.fn<typeof fetch>(async () => new Response(null, {
      status: 404,
    }))).catch((error: unknown) => error);

    expect(isPublicJobNotFoundError(missing)).toBe(true);
    expect(isPublicJobNotFoundError(empty404)).toBe(true);
    expect(isPublicJobNotFoundError(transient)).toBe(false);
  });

  it("forwards an abort signal to status requests", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(status("QUEUED")));

    await getPublicJob("job", fetcher, controller.signal);

    expect(fetcher).toHaveBeenCalledWith("/api/v1/jobs/job", { signal: controller.signal });
  });
});
