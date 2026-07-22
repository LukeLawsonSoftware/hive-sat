import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "./App";

describe("HiveSAT app", () => {
  it("renders feature-flagged route placeholders", () => {
    window.history.replaceState(null, "", "/swarm");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Swarm mode" })).toBeInTheDocument();
    expect(screen.getByText(/feature flag remains off/i)).toBeInTheDocument();
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
    expect(screen.getByRole("alert")).toHaveTextContent(".cnf extension");

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
    fireEvent.click(screen.getByRole("button", { name: "Cancel demo solve" }));
    expect(screen.getByText(/demo solve cancelled/i)).toBeInTheDocument();

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
    expect(screen.getByText(/Entering the queue/)).toBeInTheDocument();
  });

  it("finishes with an explicitly simulated verdict", () => {
    vi.useFakeTimers();
    render(<App />);
    const input = screen.getByLabelText("Choose DIMACS CNF file");
    fireEvent.change(input, { target: { files: [new File(["p cnf 1 1"], "result.cnf")] } });
    fireEvent.click(screen.getByRole("button", { name: /solve instance/i }));

    act(() => vi.runAllTimers());

    expect(screen.getByText("Simulated verdict")).toBeInTheDocument();
    expect(screen.getByText(/not the formula/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders the deterministic simulated error state", () => {
    vi.useFakeTimers();
    render(<App />);
    const input = screen.getByLabelText("Choose DIMACS CNF file");
    fireEvent.change(input, {
      target: { files: [new File(["p cnf 1 1"], "network-error.cnf")] },
    });
    fireEvent.click(screen.getByRole("button", { name: /solve instance/i }));

    act(() => vi.runAllTimers());

    expect(screen.getByText("Simulated interruption")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
