import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicJobStatus } from "../../shared/public-jobs";
import JobPage from "./JobPage";

function queuedStatus(jobId = "job"): PublicJobStatus {
  return {
    protocolVersion: 4,
    jobId,
    state: "QUEUED",
    formula: {
      hash: "ab".repeat(32),
      variableCount: 2,
      clauseCount: 1,
      literalCount: 1,
      encodedBytes: 28,
      compressedBytes: 20,
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    uploadedBytes: 20,
    rootTaskState: "READY",
    certificate: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public job status polling", () => {
  it("waits for a successful status refresh before loading fragment owner access", async () => {
    const token = "a".repeat(43);
    window.history.replaceState(null, "", `/jobs/job#owner=${token}`);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        error: { code: "STORAGE_UNAVAILABLE", message: "Temporarily unavailable." },
      }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(queuedStatus()));
    vi.stubGlobal("fetch", fetcher);

    render(<JobPage jobId="job" />);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel and delete formula/i })).not.toBeInTheDocument();

    fireEvent(document, new Event("visibilitychange"));

    expect(await screen.findByRole("button", { name: /cancel and delete formula/i })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps one status request in flight and aborts it when the page unmounts", async () => {
    let resolveResponse: ((response: Response) => void) | null = null;
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveResponse = resolve; });
    });
    vi.stubGlobal("fetch", fetcher);

    const view = render(<JobPage jobId="job" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    fireEvent(document, new Event("visibilitychange"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => {
      resolveResponse?.(Response.json(queuedStatus()));
    });
  });
});
