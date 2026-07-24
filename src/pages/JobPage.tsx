import { useEffect, useState } from "react";
import type { PublicJobStatus } from "../../shared/public-jobs";
import {
  PublicJobOwnerStore,
  cancelPublicJob,
  getPublicJob,
  ownerTokenFromFragment,
  publicJobUrl,
} from "../lib/publicJobs";

export default function JobPage({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<PublicJobStatus | null>(null);
  const [ownerToken, setOwnerToken] = useState<string | null>(null);
  const [message, setMessage] = useState("Loading public job…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const store = new PublicJobOwnerStore();
    const fragmentToken = ownerTokenFromFragment();
    void getPublicJob(jobId)
      .then(async (job) => {
        setStatus(job);
        let storedToken: string | null = null;
        try {
          storedToken = await store.getOwnerToken(jobId);
        } catch {
          // Public status remains readable when browser storage is unavailable.
        }
        const token = fragmentToken ?? storedToken;
        if (fragmentToken) {
          try {
            await store.saveOwner({ jobId, ownerToken: fragmentToken, expiresAt: job.expiresAt });
          } catch {
            // The fragment still authorizes this tab when IndexedDB is unavailable.
          }
        }
        setOwnerToken(token);
        setMessage("");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Job status is unavailable."));
  }, [jobId]);

  async function cancel() {
    if (!ownerToken) return;
    setBusy(true);
    try {
      await cancelPublicJob(jobId, ownerToken);
      setStatus((current) => current ? { ...current, state: "CANCELLED", rootTaskState: "CANCELLED", uploadedBytes: null } : current);
      setMessage("The public job was cancelled and its formula was deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The job could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="route-shell">
      <header className="route-header">
        <a className="brand route-brand" href="/" aria-label="HiveSAT home">
          <span className="route-brand-mark" aria-hidden="true">H</span><span>HiveSAT</span>
        </a>
      </header>
      <main className="route-placeholder job-status-page">
        <p className="eyebrow">Public job</p>
        <h1>Job status</h1>
        <p><code>{jobId}</code></p>
        {status && (
          <dl className="result-meta">
            <div><dt>State</dt><dd>{status.state.replaceAll("_", " ")}</dd></div>
            <div><dt>Formula</dt><dd>{status.formula.variableCount.toLocaleString()} vars · {status.formula.clauseCount.toLocaleString()} clauses</dd></div>
            <div><dt>SHA-256</dt><dd title={status.formula.hash}>{status.formula.hash.slice(0, 16)}…</dd></div>
            <div><dt>Expires</dt><dd>{new Date(status.expiresAt).toLocaleString()}</dd></div>
          </dl>
        )}
        {message && <p className="inline-notice" role="status">{message}</p>}
        <div className="result-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void navigator.clipboard?.writeText(publicJobUrl(jobId))}
          >
            Copy public share link
          </button>
          {ownerToken && status && status.state !== "CANCELLED" && (
            <button className="primary-button" type="button" disabled={busy} onClick={() => void cancel()}>
              {busy ? "Cancelling…" : "Cancel and delete formula"}
            </button>
          )}
        </div>
        <p className="privacy-footnote">
          Share links contain no owner credential. The owner token stays in this URL fragment and IndexedDB on this browser.
        </p>
        <a className="secondary-button route-home-link" href="/">Return home</a>
      </main>
    </div>
  );
}
