import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PublicSwarmRuntime } from "../lib/publicSwarmRuntime";
import {
  EMPTY_SWARM_TOTALS,
  SwarmStatsStore,
  type SwarmTotals,
} from "../lib/swarmStatsStore";
import { conservativeWorkerCapacity, isLikelyMobile } from "../lib/distributed/workerCapacity";
import { AppHeader } from "../components/AppHeader";

const WORKER_PREFERENCE_KEY = "hivesat:swarm-worker-preference";
const PAUSE_HIDDEN_KEY = "hivesat:swarm-pause-hidden";

function storedInteger(key: string, fallback: number): number {
  try {
    const value = Number.parseInt(localStorage.getItem(key) ?? "", 10);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function storedBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
}

function sessionTotals(snapshot: ReturnType<PublicSwarmRuntime["getSnapshot"]>): SwarmTotals {
  return {
    activeWorkerMs: snapshot.activeWorkerMs,
    conflicts: snapshot.conflicts,
    decisions: snapshot.decisions,
    propagations: snapshot.propagations,
    acceptedCubes: snapshot.acceptedCubes,
    completedCubes: snapshot.completedCubes,
    uniqueJobsHelped: snapshot.uniqueJobsHelped,
    decisiveSatResults: snapshot.decisiveSatResults,
    certifiedUnsatResults: snapshot.certifiedUnsatResults,
    formulaBytesTransferred: snapshot.formulaBytesTransferred,
    wasmMemoryHighWaterBytes: snapshot.wasmMemoryHighWaterBytes,
  };
}

function totalsDelta(current: SwarmTotals, previous: SwarmTotals): SwarmTotals {
  return Object.fromEntries(
    Object.keys(EMPTY_SWARM_TOTALS).map((key) => [
      key,
      Math.max(0, current[key as keyof SwarmTotals] - previous[key as keyof SwarmTotals]),
    ]),
  ) as unknown as SwarmTotals;
}

function addTotals(left: SwarmTotals, right: SwarmTotals): SwarmTotals {
  return Object.fromEntries(
    Object.keys(EMPTY_SWARM_TOTALS).map((key) => [
      key,
      left[key as keyof SwarmTotals] + right[key as keyof SwarmTotals],
    ]),
  ) as unknown as SwarmTotals;
}

function ActivityGraph({ values }: { values: number[] }) {
  const maximum = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    const y = 38 - (value / maximum) * 34;
    return `${x},${y}`;
  }).join(" ");
  return (
    <figure className="swarm-activity" aria-labelledby="swarm-activity-caption">
      <div className="swarm-graph-grid" aria-hidden="true" />
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Rolling active-worker activity">
        <polyline points={`0,40 ${points} 100,40`} className="swarm-graph-fill" />
        <polyline points={points} className="swarm-graph-line" />
      </svg>
      <figcaption id="swarm-activity-caption">
        <span>Rolling local worker activity</span>
        <strong>{values.at(-1) ?? 0} active workers</strong>
      </figcaption>
    </figure>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="swarm-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail && <span>{detail}</span>}
    </div>
  );
}

export default function SwarmPage() {
  const mobile = useMemo(() => isLikelyMobile(), []);
  const hardwareConcurrency = navigator.hardwareConcurrency || 1;
  const availableCapacity = conservativeWorkerCapacity({
    mobile,
    hardwareConcurrency,
    preference: 32,
  });
  const [workerPreference, setWorkerPreference] = useState(
    () => Math.min(availableCapacity, storedInteger(WORKER_PREFERENCE_KEY, availableCapacity)),
  );
  const [pauseWhenHidden, setPauseWhenHidden] = useState(
    () => storedBoolean(PAUSE_HIDDEN_KEY, true),
  );
  const createRuntime = (workers: number) => new PublicSwarmRuntime({
    workerPreference: workers,
    hardwareConcurrency,
    mobile,
  });
  const [runtime, setRuntime] = useState(() => createRuntime(workerPreference));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const store = useMemo(() => new SwarmStatsStore(), []);
  const [lifetime, setLifetime] = useState<SwarmTotals>(EMPTY_SWARM_TOTALS);
  const lastSession = useRef<SwarmTotals>(EMPTY_SWARM_TOTALS);
  const resumeWhenVisible = useRef(false);
  const [visibilityPaused, setVisibilityPaused] = useState(false);
  const [activity, setActivity] = useState<number[]>(() => Array.from({ length: 24 }, () => 0));
  const supported = typeof Worker !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof DecompressionStream !== "undefined";

  useEffect(() => {
    let active = true;
    void store.load().then((totals) => {
      if (active) {
        // Preserve any work completed while IndexedDB was still opening.
        setLifetime((current) => addTotals(totals, current));
      }
    });
    return () => { active = false; };
  }, [store]);

  useEffect(() => () => runtime.stop(), [runtime]);

  useEffect(() => {
    const current = sessionTotals(snapshot);
    const delta = totalsDelta(current, lastSession.current);
    lastSession.current = current;
    if (Object.values(delta).some((value) => value > 0)) {
      setLifetime((previous) => addTotals(previous, delta));
    }
  }, [snapshot]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void store.save(lifetime);
    }, 500);
    return () => clearTimeout(timer);
  }, [lifetime, store]);

  useEffect(() => {
    const timer = setInterval(() => {
      setActivity((values) => [...values.slice(-23), snapshot.activeWorkers]);
    }, 5_000);
    return () => clearInterval(timer);
  }, [snapshot.activeWorkers]);

  useEffect(() => {
    const onVisibility = () => {
      if (!pauseWhenHidden) return;
      if (document.hidden && !["idle", "paused"].includes(runtime.getSnapshot().phase)) {
        resumeWhenVisible.current = true;
        setVisibilityPaused(true);
        runtime.pause();
      } else if (!document.hidden && resumeWhenVisible.current) {
        resumeWhenVisible.current = false;
        setVisibilityPaused(false);
        runtime.start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [pauseWhenHidden, runtime]);

  const isActive = ["directory", "reconnecting", "computing", "no-work"].includes(snapshot.phase);
  const status = !supported
    ? "Unsupported"
    : visibilityPaused
      ? "Throttled while hidden"
      : snapshot.phase === "directory"
        ? "Connecting"
        : snapshot.phase === "reconnecting"
          ? "Reconnecting"
        : snapshot.phase === "computing"
          ? "Computing"
          : snapshot.phase === "no-work"
            ? "No work available"
            : snapshot.phase === "error"
              ? "Reconnecting needed"
              : "Paused";
  const displayedSession = sessionTotals(snapshot);
  const conflictRate = displayedSession.activeWorkerMs > 0
    ? displayedSession.conflicts / (displayedSession.activeWorkerMs / 1_000)
    : 0;

  const changeWorkers = (workers: number) => {
    localStorage.setItem(WORKER_PREFERENCE_KEY, String(workers));
    setWorkerPreference(workers);
    runtime.reconfigureWorkers(workers);
  };

  const resetTotals = async () => {
    runtime.stop();
    await store.reset();
    setLifetime({ ...EMPTY_SWARM_TOTALS });
    lastSession.current = { ...EMPTY_SWARM_TOTALS };
    setRuntime(createRuntime(workerPreference));
  };

  return (
    <div className="swarm-page">
      <AppHeader current="swarm" />

      <main className="swarm-main">
        <section className="swarm-hero" aria-labelledby="swarm-title">
          <div>
            <p className="swarm-kicker">Public compute / voluntary</p>
            <h1 id="swarm-title">Lend a little compute.<br /><em>Move a hard search forward.</em></h1>
            <p>
              Your browser accepts public SAT cubes only while this page is active.
              Contribution starts paused and can be stopped at any moment.
            </p>
          </div>
          <div className="swarm-control-panel">
            <div>
              <span className="swarm-control-label">Contribution</span>
              <strong>{status}</strong>
              <small>{snapshot.message ?? (isActive
                ? "Workers are requesting and solving public cubes."
                : "No public work runs until you start.")}</small>
            </div>
            <button
              type="button"
              className={isActive ? "swarm-pause-button" : "swarm-start-button"}
              disabled={!supported}
              onClick={() => isActive ? runtime.pause() : runtime.start()}
            >
              <span aria-hidden="true">{isActive ? "Ⅱ" : "▶"}</span>
              {isActive ? "Pause contribution" : "Start contributing"}
            </button>
          </div>
        </section>

        {!supported && (
          <div className="swarm-alert" role="alert">
            This browser is missing Web Workers, WebSockets, WebAssembly, or streaming gzip support.
          </div>
        )}

        <section className="swarm-status-grid" aria-label="Current swarm status">
          <article className="swarm-current-card">
            <p className="swarm-card-label">Current assignment</p>
            <div className="swarm-assignment-row">
              <div className="swarm-task-mark" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div>
                <h2>{snapshot.jobId ? `Job ${snapshot.jobId.slice(0, 10)}…` : "Waiting locally"}</h2>
                <p>
                  {snapshot.currentTaskId
                    ? `Cube ${snapshot.currentTaskId.slice(0, 12)}…`
                    : "No cube is currently leased."}
                </p>
              </div>
            </div>
            <dl className="swarm-inline-stats">
              <Metric label="Connection" value={status} />
              <Metric label="Workers" value={`${snapshot.activeWorkers} / ${workerPreference}`} detail="active / configured" />
              <Metric label="Capacity" value={mobile ? "Mobile fallback" : `${availableCapacity} local`} />
            </dl>
          </article>
          <ActivityGraph values={[...activity.slice(-23), snapshot.activeWorkers]} />
        </section>

        <section className="swarm-metrics-section" aria-labelledby="session-metrics-title">
          <div className="swarm-section-heading">
            <div>
              <p className="swarm-card-label">This page session</p>
              <h2 id="session-metrics-title">Work, measured plainly.</h2>
            </div>
            <p>Counts come from solver workers and verified coordinator messages. No OS-level CPU percentage is claimed.</p>
          </div>
          <dl className="swarm-metrics-grid">
            <Metric label="Active compute time" value={formatDuration(displayedSession.activeWorkerMs)} detail="worker-weighted wall time" />
            <Metric label="Conflict throughput" value={`${Math.round(conflictRate).toLocaleString()}/s`} detail={`${displayedSession.conflicts.toLocaleString()} conflicts`} />
            <Metric label="Decisions" value={displayedSession.decisions.toLocaleString()} />
            <Metric label="Propagations" value={displayedSession.propagations.toLocaleString()} />
            <Metric label="Cubes accepted" value={displayedSession.acceptedCubes.toLocaleString()} detail={`${displayedSession.completedCubes} results returned`} />
            <Metric label="Unique jobs helped" value={displayedSession.uniqueJobsHelped.toLocaleString()} />
            <Metric label="Verified SAT contributions" value={displayedSession.decisiveSatResults.toLocaleString()} />
            <Metric label="Certified UNSAT contributions" value={displayedSession.certifiedUnsatResults.toLocaleString()} detail="proof-backed only" />
            <Metric label="Formula bytes transferred" value={formatBytes(displayedSession.formulaBytesTransferred)} />
            <Metric label="Wasm allocation now" value={formatBytes(snapshot.wasmMemoryBytes)} detail="linear memory, not process RAM" />
            <Metric label="Wasm high-water" value={formatBytes(snapshot.wasmMemoryHighWaterBytes)} />
            <Metric label="Global swarm" value={`${snapshot.global.activeJobs} jobs`} detail={`${snapshot.global.activeWorkers} reserved worker slots`} />
          </dl>
        </section>

        <section className="swarm-settings" aria-labelledby="swarm-settings-title">
          <div>
            <p className="swarm-card-label">Local limits</p>
            <h2 id="swarm-settings-title">You stay in control.</h2>
          </div>
          <div className="swarm-setting-row">
            <label htmlFor="swarm-workers">
              <strong>Maximum workers</strong>
              <span>Configured browser worker share; never an OS CPU percentage.</span>
            </label>
            <select
              id="swarm-workers"
              value={workerPreference}
              onChange={(event) => changeWorkers(Number(event.target.value))}
            >
              {Array.from({ length: availableCapacity }, (_, index) => index + 1).map((workers) => (
                <option key={workers} value={workers}>{workers}</option>
              ))}
            </select>
          </div>
          <div className="swarm-setting-row">
            <label htmlFor="pause-hidden">
              <strong>Pause when hidden</strong>
              <span>Stop public work when this tab is not visible; enabled by default.</span>
            </label>
            <input
              id="pause-hidden"
              type="checkbox"
              checked={pauseWhenHidden}
              onChange={(event) => {
                setPauseWhenHidden(event.target.checked);
                localStorage.setItem(PAUSE_HIDDEN_KEY, String(event.target.checked));
              }}
            />
          </div>
        </section>

        <section className="swarm-lifetime" aria-labelledby="lifetime-title">
          <div>
            <p className="swarm-card-label">This device</p>
            <h2 id="lifetime-title">Lifetime totals</h2>
            <p>Stored only in this browser’s IndexedDB.</p>
          </div>
          <dl>
            <Metric label="Active compute" value={formatDuration(lifetime.activeWorkerMs)} />
            <Metric label="Cubes accepted" value={lifetime.acceptedCubes.toLocaleString()} />
            <Metric label="Jobs helped" value={lifetime.uniqueJobsHelped.toLocaleString()} />
            <Metric label="Formula transfer" value={formatBytes(lifetime.formulaBytesTransferred)} />
          </dl>
          <button type="button" className="swarm-reset" onClick={() => void resetTotals()}>
            Reset local totals
          </button>
        </section>
      </main>
      <footer className="swarm-footer">
        <span>Public formulas only · no credits · no background contribution</span>
        <a href="https://github.com/LukeLawsonSoftware/hive-sat/blob/main/docs/guide/05-fair-swarm-scheduling.md">
          How fair scheduling works
        </a>
      </footer>
    </div>
  );
}
