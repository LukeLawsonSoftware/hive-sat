import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "../components/AppHeader";
import {
  PublicJobOwnerStore,
  getPublicJob,
  isPublicJobNotFoundError,
  isTerminalPublicJobState,
  ownedJobGroup,
  ownedJobListGroup,
  publicJobStatusLabel,
  type OwnedJobGroup,
  type OwnedPublicJobRecord,
} from "../lib/publicJobs";

const BADGE_GROUPS: Array<{ key: OwnedJobGroup; label: string }> = [
  { key: "submitted", label: "Submitted" },
  { key: "in-progress", label: "In progress" },
  { key: "completed", label: "Completed" },
  { key: "stopped", label: "Stopped" },
];

const LIST_GROUPS: Array<{
  key: "active" | "finished";
  label: string;
  description: string;
}> = [
  {
    key: "active",
    label: "Active",
    description: "Submitted jobs and work currently available to solver browsers.",
  },
  {
    key: "finished",
    label: "Finished",
    description: "Verified results and jobs that were cancelled, invalid, expired, or unavailable.",
  },
];

function formatFormula(record: OwnedPublicJobRecord): string {
  if (!record.formula) return "Formula details unavailable";
  return `${record.formula.variableCount.toLocaleString()} vars · ${record.formula.clauseCount.toLocaleString()} clauses`;
}

function jobUrl(record: OwnedPublicJobRecord): string {
  const owner = record.ownerToken ? `#owner=${encodeURIComponent(record.ownerToken)}` : "";
  return `/jobs/${encodeURIComponent(record.jobId)}${owner}`;
}

export default function JobsPage() {
  const store = useMemo(() => new PublicJobOwnerStore(), []);
  const [jobs, setJobs] = useState<OwnedPublicJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const refreshGeneration = ++generation.current;
    const abortController = new AbortController();
    const observedAt = Date.now();
    controller.current = abortController;

    const operation = (async () => {
      try {
        const local = await store.listJobs(observedAt);
        if (generation.current !== refreshGeneration || abortController.signal.aborted) return;
        setJobs(local);
        setLoading(false);
        const active = local.filter((record) =>
          record.expiresAt > observedAt &&
          (!record.lastStatus || !isTerminalPublicJobState(record.lastStatus.state)),
        );
        let failedStatuses = 0;
        await Promise.all(active.map(async (record) => {
          try {
            const status = await getPublicJob(record.jobId, fetch, abortController.signal);
            if (abortController.signal.aborted) return;
            await store.updateStatus(status, observedAt);
          } catch (error) {
            if (abortController.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
            failedStatuses += 1;
            if (isPublicJobNotFoundError(error)) {
              await store.markUnavailable(record.jobId, observedAt);
            }
          }
        }));
        if (generation.current !== refreshGeneration || abortController.signal.aborted) return;
        const refreshed = await store.listJobs();
        if (generation.current !== refreshGeneration || abortController.signal.aborted) return;
        setJobs(refreshed);
        setMessage(failedStatuses > 0
          ? "Some live statuses could not be refreshed. Their last known state is shown."
          : null);
      } catch (error) {
        if (generation.current !== refreshGeneration || abortController.signal.aborted ||
          error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Job history is unavailable in this browser.");
      } finally {
        if (generation.current === refreshGeneration) setLoading(false);
      }
    })();
    const tracked = operation.finally(() => {
      if (inFlight.current === tracked) inFlight.current = null;
      if (controller.current === abortController) controller.current = null;
    });
    inFlight.current = tracked;
    return tracked;
  }, [store]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30_000);
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
      // React StrictMode immediately runs this effect again. Do not let the
      // aborted first pass suppress that replacement refresh until the timer.
      inFlight.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  async function stopRefresh(): Promise<void> {
    generation.current += 1;
    controller.current?.abort();
    await inFlight.current?.catch(() => undefined);
  }

  async function remove(record: OwnedPublicJobRecord) {
    if (!window.confirm(`Remove ${record.filename} from this browser's history?`)) return;
    await stopRefresh();
    await store.removeJob(record.jobId);
    setJobs(await store.listJobs());
  }

  async function clearFinished() {
    if (!window.confirm("Remove all completed and stopped jobs from this browser's history?")) return;
    await stopRefresh();
    await store.clearTerminalJobs();
    setJobs(await store.listJobs());
  }

  const counts = Object.fromEntries(BADGE_GROUPS.map(({ key }) => [
    key,
    jobs.filter((job) => ownedJobGroup(job) === key).length,
  ])) as Record<OwnedJobGroup, number>;

  return (
    <div className="site-shell jobs-shell">
      <AppHeader current="jobs" />
      <main className="jobs-page section-wrap">
        <section className="jobs-heading">
          <div>
            <p className="eyebrow">This browser</p>
            <h1>My jobs</h1>
            <p>Track formulas submitted from this browser and return to their results.</p>
          </div>
          {counts.completed + counts.stopped > 0 && (
            <button className="text-button" type="button" onClick={() => void clearFinished()}>
              Clear finished history
            </button>
          )}
        </section>

        <div className="job-counts" aria-label="Job totals">
          {BADGE_GROUPS.map((group) => (
            <div key={group.key}><strong>{counts[group.key]}</strong><span>{group.label}</span></div>
          ))}
        </div>

        {message && <p className="inline-notice" role="status">{message}</p>}
        {loading && jobs.length === 0 && <p className="jobs-empty">Loading job history…</p>}
        {!loading && jobs.length === 0 && (
          <section className="jobs-empty">
            <span className="empty-hex" aria-hidden="true">◇</span>
            <h2>No jobs yet</h2>
            <p>Submit a public SAT formula and its progress will appear here.</p>
            <a className="primary-button" href="/">Submit a formula</a>
          </section>
        )}

        {LIST_GROUPS.map((group) => {
          const records = jobs.filter((job) => ownedJobListGroup(job) === group.key);
          if (records.length === 0) return null;
          return (
            <section className="job-group" key={group.key} aria-labelledby={`jobs-${group.key}`}>
              <div className="job-group-heading">
                <div><h2 id={`jobs-${group.key}`}>{group.label}</h2><p>{group.description}</p></div>
                <span>{records.length}</span>
              </div>
              <div className="job-list">
                {records.map((record) => {
                  const badgeGroup = ownedJobGroup(record);
                  const terminal = group.key === "finished";
                  return (
                    <article className="job-card" key={record.jobId}>
                      <div className="job-card-main">
                        <span className={`job-status status-${badgeGroup}`}>{publicJobStatusLabel(record)}</span>
                        <h3>{record.filename}</h3>
                        <p>{formatFormula(record)}</p>
                      </div>
                      <dl>
                        <div><dt>Submitted</dt><dd>{new Date(record.createdAt).toLocaleString()}</dd></div>
                        <div><dt>Job ID</dt><dd><code>{record.jobId.slice(0, 12)}…</code></dd></div>
                      </dl>
                      <div className="job-card-actions">
                        {terminal && <button className="text-button" type="button" onClick={() => void remove(record)}>Remove</button>}
                        <a className="secondary-button" href={jobUrl(record)}>Open job</a>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
