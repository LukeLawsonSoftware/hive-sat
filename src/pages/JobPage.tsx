import { useEffect, useMemo, useState } from "react";
import type { PublicJobStatus } from "../../shared/public-jobs";
import { AppHeader } from "../components/AppHeader";
import {
  PublicJobOwnerStore,
  cancelPublicJob,
  getPublicJob,
  isTerminalPublicJobState,
  ownerTokenFromFragment,
  publicJobUrl,
  rotatePublicJobOwnerToken,
  verifyAndConfirmOwnerProof,
} from "../lib/publicJobs";
import { useDistributedCubeRuntime } from "../hooks/useDistributedCubeRuntime";

function statusLabel(status: PublicJobStatus): string {
  const labels: Record<PublicJobStatus["state"], string> = {
    UPLOADING: "Uploading formula",
    QUEUED: "Submitted",
    RUNNING: status.certificate?.verification === "OWNER_CHECK_REQUIRED" ? "Proof check required" : "In progress",
    SAT_VERIFIED: "SAT verified",
    UNSAT_CERTIFIED: "UNSAT certified",
    UNSAT_OWNER_VERIFIED: "UNSAT owner verified",
    INVALID: "Invalid result",
    UNKNOWN: "Stopped without a verdict",
    CANCELLED: "Cancelled",
  };
  return labels[status.state];
}

function resultCopy(status: PublicJobStatus): { verdict: string; detail: string } | null {
  if (status.state === "SAT_VERIFIED") {
    return { verdict: "SAT", detail: "HiveSAT independently verified the returned satisfying assignment." };
  }
  if (status.state === "UNSAT_CERTIFIED") {
    return { verdict: "UNSAT", detail: "The complete search is covered by server-certified LRAT evidence." };
  }
  if (status.state === "UNSAT_OWNER_VERIFIED") {
    return { verdict: "UNSAT", detail: "The complete proof tree includes evidence independently checked in the owner's browser." };
  }
  if (["INVALID", "UNKNOWN", "CANCELLED"].includes(status.state)) {
    return { verdict: "No result", detail: statusLabel(status) };
  }
  return null;
}

export default function JobPage({ jobId }: { jobId: string }) {
  const store = useMemo(() => new PublicJobOwnerStore(), []);
  const [status, setStatus] = useState<PublicJobStatus | null>(null);
  const [ownerToken, setOwnerToken] = useState<string | null>(null);
  const [message, setMessage] = useState("Loading public job…");
  const [busy, setBusy] = useState(false);
  const { runtime, snapshot: cubeRuntime } = useDistributedCubeRuntime(jobId);

  useEffect(() => {
    let active = true;
    let terminal = false;
    const fragmentToken = ownerTokenFromFragment();
    const refresh = async (initial = false) => {
      try {
        const job = await getPublicJob(jobId);
        if (!active) return;
        setStatus(job);
        terminal = isTerminalPublicJobState(job.state);
        await store.updateStatus(job).catch(() => undefined);
        if (initial) {
          let storedToken: string | null = null;
          try { storedToken = await store.getOwnerToken(jobId); } catch { /* Public status remains readable. */ }
          const token = fragmentToken ?? storedToken;
          if (fragmentToken) {
            await store.saveOwner({ jobId, ownerToken: fragmentToken, expiresAt: job.expiresAt }).catch(() => undefined);
          }
          if (active) setOwnerToken(token);
        }
        if (active) setMessage("");
      } catch (error) {
        if (!active) return;
        const unavailable = error instanceof Error && /not found|JOB_NOT_FOUND/i.test(error.message);
        if (unavailable) terminal = true;
        await store.markUnavailable(jobId).catch(() => undefined);
        if (initial) {
          setMessage(
            unavailable
              ? "This job is unavailable. It may have expired or been removed."
              : "The latest job status could not be loaded. Try again in a moment.",
          );
        }
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => {
      if (!document.hidden && !terminal) void refresh();
    }, 5_000);
    const onVisibility = () => {
      if (!document.hidden && !terminal) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [jobId, store]);

  async function cancel() {
    if (!ownerToken) return;
    setBusy(true);
    try {
      await cancelPublicJob(jobId, ownerToken);
      if (status) {
        const cancelled = { ...status, state: "CANCELLED", rootTaskState: "CANCELLED", uploadedBytes: null } satisfies PublicJobStatus;
        setStatus(cancelled);
        await store.updateStatus(cancelled);
      }
      setMessage("The public job was cancelled and its formula was deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The job could not be cancelled.");
    } finally { setBusy(false); }
  }

  async function verifyOwnerProof() {
    if (!ownerToken || !status) return;
    setBusy(true);
    setMessage("Downloading and independently checking the LRAT certificate in this browser…");
    try {
      const verified = await verifyAndConfirmOwnerProof(jobId, ownerToken, status);
      setStatus(verified);
      await store.updateStatus(verified);
      setMessage(verified.state === "UNSAT_OWNER_VERIFIED"
        ? "The complete proof tree was checked."
        : "This leaf proof was checked; other branches are still required.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The proof could not be verified.");
    } finally { setBusy(false); }
  }

  async function rotateOwner() {
    if (!ownerToken || !status) return;
    setBusy(true);
    try {
      const next = await rotatePublicJobOwnerToken(jobId, ownerToken, status.expiresAt);
      setOwnerToken(next);
      setMessage("Owner credential rotated. The previous owner URL no longer authorizes changes.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The owner credential could not be rotated.");
    } finally { setBusy(false); }
  }

  const result = status ? resultCopy(status) : null;
  const timelineStep = status
    ? isTerminalPublicJobState(status.state) ? 3 : status.state === "RUNNING" ? 2 : 1
    : 0;

  return (
    <div className="site-shell job-detail-shell">
      <AppHeader current="jobs" />
      <main className="job-detail section-wrap">
        <a className="job-back-link" href="/jobs">← My jobs</a>
        <section className="job-detail-heading">
          <div>
            <p className="eyebrow">Public job</p>
            <h1>{result ? result.verdict : "Job progress"}</h1>
            <code>{jobId}</code>
          </div>
          {status && <span className={`job-status state-${status.state.toLowerCase()}`}>{statusLabel(status)}</span>}
        </section>

        <ol className="job-timeline" aria-label="Job progress">
          {["Submitted", "In progress", result?.verdict ?? "Result"].map((label, index) => (
            <li className={timelineStep >= index + 1 ? "is-complete" : ""} key={label}>
              <span>{timelineStep > index + 1 ? "✓" : index + 1}</span><strong>{label}</strong>
            </li>
          ))}
        </ol>

        {message && <p className="inline-notice" role="status">{message}</p>}

        {result && status && (
          <section className={`job-result ${result.verdict === "No result" ? "is-stopped" : ""}`}>
            <p className="eyebrow">Verified result</p>
            <h2>{result.verdict}</h2>
            <p>{result.detail}</p>
          </section>
        )}

        {status && (
          <section className="job-detail-grid" aria-label="Job details">
            <div><span>Formula</span><strong>{status.formula.variableCount.toLocaleString()} vars · {status.formula.clauseCount.toLocaleString()} clauses</strong></div>
            <div><span>Submitted</span><strong>{new Date(status.createdAt).toLocaleString()}</strong></div>
            <div><span>Available until</span><strong>{new Date(status.expiresAt).toLocaleString()}</strong></div>
            <div><span>SHA-256</span><strong title={status.formula.hash}>{status.formula.hash.slice(0, 16)}…</strong></div>
          </section>
        )}

        {status?.certificate && (
          <section className="job-action-card" aria-labelledby="certificate-title">
            <p className="eyebrow">Result evidence</p>
            <h2 id="certificate-title">UNSAT certificate</h2>
            <p>
              {status.certificate.verification === "SERVER_CERTIFIED"
                ? "HiveSAT independently checked this bounded LRAT proof on the server."
                : status.certificate.verification === "OWNER_VERIFIED"
                  ? "The submitting owner independently checked this larger LRAT proof in their browser."
                  : "This proof exceeds conservative server limits and awaits an owner-browser check."}
            </p>
            <div className="result-actions">
              <a className="secondary-button" href={status.certificate.downloadUrl}>Download LRAT certificate</a>
              {ownerToken && status.certificate.verification === "OWNER_CHECK_REQUIRED" && (
                <button className="primary-button" type="button" disabled={busy} onClick={() => void verifyOwnerProof()}>
                  {busy ? "Checking proof…" : "Verify proof in this browser"}
                </button>
              )}
            </div>
          </section>
        )}

        {ownerToken && status && (status.state === "QUEUED" || status.state === "RUNNING") && (
          <section className="job-action-card" aria-labelledby="owner-compute-title">
            <p className="eyebrow">Optional local acceleration</p>
            <h2 id="owner-compute-title">Solve your job in this browser</h2>
            <p>Your job receives all {cubeRuntime.capacity} local worker{cubeRuntime.capacity === 1 ? "" : "s"} before public swarm work.</p>
            <p role="status">{cubeRuntime.message ?? `${cubeRuntime.activeWorkers} local workers active`}</p>
            {["idle", "paused", "error"].includes(cubeRuntime.phase) ? (
              <button className="primary-button" type="button" onClick={() => void runtime.start()}>
                {cubeRuntime.phase === "paused" ? "Resume local workers" : "Start local workers"}
              </button>
            ) : (
              <button className="secondary-button" type="button" onClick={() => runtime.pause()}>Pause local workers</button>
            )}
          </section>
        )}

        <section className="job-owner-actions" aria-labelledby="job-actions-title">
          <div><p className="eyebrow">Manage job</p><h2 id="job-actions-title">Sharing and owner actions</h2></div>
          <div className="result-actions">
            <button className="secondary-button" type="button" onClick={() => void navigator.clipboard?.writeText(publicJobUrl(jobId))}>
              Copy public share link
            </button>
            {ownerToken && status && status.state !== "CANCELLED" && (
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void rotateOwner()}>Rotate owner token</button>
            )}
            {ownerToken && status && !isTerminalPublicJobState(status.state) && (
              <button className="danger-button" type="button" disabled={busy} onClick={() => void cancel()}>
                {busy ? "Cancelling…" : "Cancel and delete formula"}
              </button>
            )}
          </div>
          <p className="privacy-footnote">Public share links contain no owner credential. Owner access stays in this browser and URL fragment.</p>
        </section>
      </main>
    </div>
  );
}
