import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "../components/AppHeader";
import {
  PublicJobOwnerStore,
  getPublicJob,
  isTerminalPublicJobState,
  ownedJobGroup,
  publicJobStatusLabel,
  type OwnedJobGroup,
  type OwnedPublicJobRecord,
} from "../lib/publicJobs";

const GROUPS: Array<{ key: OwnedJobGroup; label: string; description: string }> = [
  { key: "submitted", label: "Submitted", description: "Uploaded and waiting for swarm capacity." },
  { key: "in-progress", label: "In progress", description: "Work is currently available to solver browsers." },
  { key: "completed", label: "Completed", description: "Jobs with a verified SAT or certified UNSAT result." },
  { key: "stopped", label: "Stopped", description: "Cancelled, invalid, expired, or unavailable jobs." },
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

  const refresh = useCallback(async () => {
    try {
      const local = await store.listJobs();
      setJobs(local);
      const active = local.filter((record) =>
        record.expiresAt > Date.now() &&
        (!record.lastStatus || !isTerminalPublicJobState(record.lastStatus.state)),
      );
      const outcomes = await Promise.allSettled(active.map(async (record) => {
        const status = await getPublicJob(record.jobId);
        await store.updateStatus(status);
      }));
      await Promise.all(outcomes.map(async (outcome, index) => {
        if (outcome.status === "rejected") await store.markUnavailable(active[index].jobId);
      }));
      setJobs(await store.listJobs());
      setMessage(outcomes.some((outcome) => outcome.status === "rejected")
        ? "Some live statuses could not be refreshed. Their last known state is shown."
        : null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Job history is unavailable in this browser.");
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5_000);
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  async function remove(record: OwnedPublicJobRecord) {
    if (!window.confirm(`Remove ${record.filename} from this browser's history?`)) return;
    await store.removeJob(record.jobId);
    setJobs(await store.listJobs());
  }

  async function clearFinished() {
    if (!window.confirm("Remove all completed and stopped jobs from this browser's history?")) return;
    await store.clearTerminalJobs();
    setJobs(await store.listJobs());
  }

  const counts = Object.fromEntries(GROUPS.map(({ key }) => [
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
          {GROUPS.map((group) => (
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

        {GROUPS.map((group) => {
          const records = jobs.filter((job) => ownedJobGroup(job) === group.key);
          if (records.length === 0) return null;
          return (
            <section className="job-group" key={group.key} aria-labelledby={`jobs-${group.key}`}>
              <div className="job-group-heading">
                <div><h2 id={`jobs-${group.key}`}>{group.label}</h2><p>{group.description}</p></div>
                <span>{records.length}</span>
              </div>
              <div className="job-list">
                {records.map((record) => {
                  const terminal = ownedJobGroup(record) === "completed" || ownedJobGroup(record) === "stopped";
                  return (
                    <article className="job-card" key={record.jobId}>
                      <div className="job-card-main">
                        <span className={`job-status status-${ownedJobGroup(record)}`}>{publicJobStatusLabel(record)}</span>
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
