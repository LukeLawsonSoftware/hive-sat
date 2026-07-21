import { useState, useSyncExternalStore } from "react";
import { MockSolverClient } from "../lib/solver";

export function useMockSolver() {
  const [client] = useState(() => new MockSolverClient());
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  return { client, snapshot };
}
