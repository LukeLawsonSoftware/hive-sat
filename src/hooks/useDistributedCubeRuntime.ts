import { useEffect, useState, useSyncExternalStore } from "react";
import { DistributedCubeRuntime } from "../lib/distributed/cubeRuntime";

export function useDistributedCubeRuntime(jobId: string) {
  const [runtime] = useState(() => new DistributedCubeRuntime({ jobId }));
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  useEffect(() => () => runtime.stop(), [runtime]);
  return { runtime, snapshot };
}
