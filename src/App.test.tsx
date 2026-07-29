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
  beforeEach(() => vi.stubGlobal("Worker", IdleWorker));
  afterEach(() => vi.unstubAllGlobals());

  it("renders Swarm Mode paused with honest controls and shared navigation", () => {
    window.history.replaceState(null, "", "/swarm");
    render(<App />);

    expect(screen.getByRole("heading", { name: /lend a little compute/i })).toBeInTheDocument();
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: /pause when hidden/i })).toBeChecked();
    expect(screen.getByText("Wasm allocation now")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Exit Swarm Mode" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Upload Instance" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Jobs" })).toBeInTheDocument();
  });

  it("renders human-readable public job status and recognizes an owner fragment", async () => {
    const ownerToken = "a".repeat(43);
    window.history.replaceState(null, "", `/jobs/${"b".repeat(32)}#owner=${ownerToken}`);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      protocolVersion: 3,
      jobId: "b".repeat(32),
      state: "QUEUED",
      formula: {
        hash: "ab".repeat(32), variableCount: 4, clauseCount: 3,
        literalCount: 7, encodedBytes: 60, compressedBytes: 40,
      },
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      uploadedBytes: 40, rootTaskState: "READY", certificate: null,
    })));
    render(<App />);

    expect(await screen.findByText("Submitted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel and delete formula/i })).toBeInTheDocument();
    expect(screen.getByText(/owner access stays in this browser/i)).toBeInTheDocument();
  });

  it("makes swarm submission primary and removes mocked contribution state", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Submit to the swarm" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload Instance" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "My Jobs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Swarm Mode" })).toBeInTheDocument();
    expect(screen.queryByText(/Helping 4|Hive active|Contribution enabled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Right now:/i)).not.toBeInTheDocument();
  });

  it("rejects an invalid file and automatically prepares valid DIMACS input", () => {
    render(<App />);
    const input = screen.getByLabelText("Choose DIMACS CNF file");

    fireEvent.change(input, { target: { files: [new File(["hello"], "notes.txt")] } });
    expect(screen.getByRole("alert")).toHaveTextContent(".cnf or .cnf.gz extension");

    fireEvent.change(input, { target: { files: [new File(["p cnf 1 1\n1 0"], "tiny.cnf")] } });
    expect(screen.getByText("tiny.cnf")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Validating the formula" })).toBeInTheDocument();
  });

  it("supports drag-and-drop, preparation cancellation, and file removal", () => {
    render(<App />);
    const dropHeading = screen.getByRole("heading", { name: "Drop your CNF instance here" });
    const file = new File(["p cnf 1 1\n1 0"], "dropped.cnf");

    fireEvent.drop(dropHeading.parentElement!, { dataTransfer: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel processing" }));
    expect(screen.getByText(/formula processing cancelled/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare formula" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove dropped.cnf" }));
    expect(screen.getByRole("heading", { name: "Drop your CNF instance here" })).toBeInTheDocument();
  });

  it("adds a browser-local Jobs dashboard route", async () => {
    window.history.replaceState(null, "", "/jobs");
    render(<App />);

    expect(screen.getByRole("heading", { name: "My jobs" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No jobs yet" })).toBeInTheDocument();
  });
});
