import { describe, expect, it, vi } from "vitest";
import { encodeHiveCnfV1, sha256Hex } from "./formula/hiveCnf";
import {
  downloadVerifiedPublicFormula,
  getPublicJob,
  ownedJobGroup,
  ownerTokenFromFragment,
  publicJobStatusLabel,
  publicJobUrl,
  type OwnedPublicJobRecord,
} from "./publicJobs";

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
      lastStatus: {
        protocolVersion: 3,
        jobId: "job",
        state: "SAT_VERIFIED",
        formula: { hash: "ab".repeat(32), variableCount: 1, clauseCount: 1, literalCount: 1, encodedBytes: 24, compressedBytes: 20 },
        createdAt: base.createdAt,
        expiresAt: base.expiresAt,
        uploadedBytes: 20,
        rootTaskState: "SAT_VERIFIED",
        certificate: null,
      },
    } satisfies OwnedPublicJobRecord;
    expect(ownedJobGroup(completed)).toBe("completed");
    expect(publicJobStatusLabel(completed)).toBe("Completed · SAT");
    expect(ownedJobGroup({ ...base, unavailable: true })).toBe("stopped");
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
      protocolVersion: 3,
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
          protocolVersion: 3,
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
});
