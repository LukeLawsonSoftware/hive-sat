import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

class IdleWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

describe("HiveSAT app", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", IdleWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders feature-flagged route placeholders", () => {
    window.history.replaceState(null, "", "/swarm");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Swarm mode" })).toBeInTheDocument();
    expect(screen.getByText(/feature flag remains off/i)).toBeInTheDocument();
  });

  it("renders public job status and recognizes an owner-only fragment", async () => {
    const ownerToken = "a".repeat(43);
    window.history.replaceState(null, "", `/jobs/${"b".repeat(32)}#owner=${ownerToken}`);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      protocolVersion: 1,
      jobId: "b".repeat(32),
      state: "QUEUED",
      formula: {
        hash: "ab".repeat(32),
        variableCount: 4,
        clauseCount: 3,
        literalCount: 7,
        encodedBytes: 60,
        compressedBytes: 40,
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      uploadedBytes: 40,
      rootTaskState: "READY",
    })));
    render(<App />);

    expect(await screen.findByText("QUEUED")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel and delete formula/i })).toBeInTheDocument();
    expect(screen.getByText(/share links contain no owner credential/i)).toBeInTheDocument();
  });

  it("defaults hive participation on and persists opt-out", () => {
    render(<App />);
    const hiveSwitch = screen.getByRole("switch", { name: "Join the hive" });

    expect(hiveSwitch).toBeChecked();
    fireEvent.click(hiveSwitch);

    expect(hiveSwitch).not.toBeChecked();
    expect(window.localStorage.getItem("hivesat:hive-enabled")).toBe("false");
    expect(screen.getByText("Contribution paused")).toBeInTheDocument();
  });

  it("rejects an invalid file and accepts a DIMACS CNF file", () => {
    render(<App />);
    const input = screen.getByLabelText("Choose DIMACS CNF file");

    fireEvent.change(input, { target: { files: [new File(["hello"], "notes.txt")] } });
    expect(screen.getByRole("alert")).toHaveTextContent(".cnf or .cnf.gz extension");

    fireEvent.change(input, { target: { files: [new File(["p cnf 1 1\n1 0"], "tiny.cnf")] } });
    expect(screen.getByText("tiny.cnf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /solve instance/i })).toBeEnabled();
  });

  it("supports drag-and-drop, cancellation, and file removal", () => {
    render(<App />);
    const dropHeading = screen.getByRole("heading", { name: "Drop your CNF instance here" });
    const file = new File(["p cnf 1 1\n1 0"], "dropped.cnf");

    fireEvent.drop(dropHeading.parentElement!, { dataTransfer: { files: [file] } });
    expect(screen.getByText("dropped.cnf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /solve instance/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel processing" }));
    expect(screen.getByText(/formula processing cancelled/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove dropped.cnf" }));
    expect(screen.getByRole("heading", { name: "Drop your CNF instance here" })).toBeInTheDocument();
  });

  it("shows personal solving and hive contribution at the same time", () => {
    render(<App />);
    const input = screen.getByLabelText("Choose DIMACS CNF file");
    fireEvent.change(input, { target: { files: [new File(["p cnf 1 1"], "race.cnf")] } });
    fireEvent.click(screen.getByRole("button", { name: /solve instance/i }));

    expect(screen.getByRole("heading", { name: "Your solve" })).toBeInTheDocument();
    expect(screen.getByText(/Helping 2/)).toBeInTheDocument();
    expect(screen.getByText(/Validating the formula/)).toBeInTheDocument();
  });

  it("describes the real local formula pipeline", () => {
    render(<App />);
    expect(screen.getByText("Local solver")).toBeInTheDocument();
    expect(screen.getByText(/parsing, SHA-256 hashing, model verification/i)).toBeInTheDocument();
    expect(screen.queryByText(/verdicts are simulated/i)).not.toBeInTheDocument();
  });
});
