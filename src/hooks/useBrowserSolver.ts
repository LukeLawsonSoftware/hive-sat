import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserSolverClient } from "../lib/solver";

export function useBrowserSolver() {
  const [client] = useState(() => new BrowserSolverClient());
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  useEffect(() => () => client.reset(), [client]);
  return { client, snapshot };
}

