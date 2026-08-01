import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicJobStatus } from "../../shared/public-jobs";
import { PublicJobOwnerStore, type OwnedPublicJobRecord } from "../lib/publicJobs";
import JobsPage from "./JobsPage";

function record(
  jobId: string,
  state: PublicJobStatus["state"],
  expiresAt = Date.now() + 60_000,
): OwnedPublicJobRecord {
  const status: PublicJobStatus = {
    protocolVersion: 4,
    jobId,
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
    expiresAt,
    uploadedBytes: 20,
    rootTaskState: "READY",
    certificate: null,
  };
  return {
    jobId,
    ownerToken: null,
    filename: `${jobId}.cnf`,
    formula: status.formula,
    createdAt: status.createdAt,
    expiresAt,
    lastStatus: status,
    lastSyncedAt: 2_000,
    terminalAt: null,
    unavailable: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("My Jobs grouping", () => {
  it("starts a replacement history read immediately after the StrictMode cleanup aborts the first", async () => {
    let resolveFirst!: (records: OwnedPublicJobRecord[]) => void;
    const first = new Promise<OwnedPublicJobRecord[]>((resolve) => { resolveFirst = resolve; });
    const listJobs = vi.spyOn(PublicJobOwnerStore.prototype, "listJobs")
      .mockReturnValueOnce(first)
      .mockResolvedValue([]);

    render(<StrictMode><JobsPage /></StrictMode>);

    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "No jobs yet" })).toBeInTheDocument();
    expect(screen.queryByText("Loading job history…")).not.toBeInTheDocument();
    await act(async () => resolveFirst([]));
  });

  it("uses stable Active/Finished lists while retaining the four status badges", async () => {
    const records = [
      record("submitted", "QUEUED"),
      record("running", "RUNNING"),
      record("completed", "SAT_VERIFIED"),
      record("expired", "RUNNING", Date.now() - 1),
    ];
    vi.spyOn(PublicJobOwnerStore.prototype, "listJobs").mockResolvedValue(records);
    vi.spyOn(PublicJobOwnerStore.prototype, "updateStatus").mockResolvedValue(true);
    vi.spyOn(PublicJobOwnerStore.prototype, "markUnavailable").mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const jobId = String(input).split("/").at(-1) ?? "submitted";
      return Response.json(records.find((item) => item.jobId === jobId)?.lastStatus);
    }));

    render(<JobsPage />);

    expect(await screen.findByRole("heading", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finished" })).toBeInTheDocument();
    for (const label of ["Submitted", "In progress", "Completed", "Stopped"]) {
      expect(screen.getByLabelText("Job totals")).toHaveTextContent(label);
    }
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("does not mark a job unavailable for a transient status failure", async () => {
    const records = [record("running", "RUNNING")];
    vi.spyOn(PublicJobOwnerStore.prototype, "listJobs").mockResolvedValue(records);
    const markUnavailable = vi.spyOn(PublicJobOwnerStore.prototype, "markUnavailable").mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({
      error: { code: "STORAGE_UNAVAILABLE", message: "Job not found in a transient replica." },
    }, { status: 503 })));

    render(<JobsPage />);

    expect(await screen.findByText(/last known state is shown/i)).toBeInTheDocument();
    expect(markUnavailable).not.toHaveBeenCalled();
  });

  it("marks a job unavailable for a structured 404", async () => {
    const records = [record("missing", "RUNNING")];
    vi.spyOn(PublicJobOwnerStore.prototype, "listJobs").mockResolvedValue(records);
    const markUnavailable = vi.spyOn(PublicJobOwnerStore.prototype, "markUnavailable").mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({
      error: { code: "JOB_NOT_FOUND", message: "This job does not exist." },
    }, { status: 404 })));

    render(<JobsPage />);

    await waitFor(() => expect(markUnavailable).toHaveBeenCalledWith("missing", expect.any(Number)));
  });

  it("keeps the dashboard refresh single-flight and aborts it on unmount", async () => {
    const records = [record("running", "RUNNING")];
    vi.spyOn(PublicJobOwnerStore.prototype, "listJobs").mockResolvedValue(records);
    let resolveResponse: ((response: Response) => void) | null = null;
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveResponse = resolve; });
    });
    vi.stubGlobal("fetch", fetcher);

    const view = render(<JobsPage />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    fireEvent(document, new Event("visibilitychange"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => {
      resolveResponse?.(Response.json(records[0].lastStatus));
    });
  });
});
