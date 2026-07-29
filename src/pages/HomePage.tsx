import {
  type ChangeEvent,
  type DragEvent,
  useRef,
  useState,
} from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  CpuIcon,
  FileIcon,
  HexIcon,
  NetworkIcon,
  XIcon,
} from "../components/Icons";
import { AppHeader } from "../components/AppHeader";
import { useBrowserSolver } from "../hooks/useBrowserSolver";
import {
  formatFileSize,
  type SolverPhase,
  validateCnfFile,
} from "../lib/solver";
import { formatDimacsSatModel, modelDownloadFilename } from "../lib/formula/modelOutput";
import { PublicJobSubmission } from "../components/PublicJobSubmission";

const phaseDetails: Record<
  Extract<SolverPhase, "preparing" | "distributing" | "solving">,
  { eyebrow: string; title: string; body: string; step: number }
> = {
  preparing: {
    eyebrow: "Step 1 of 3",
    title: "Validating the formula",
    body: "Strictly parsing DIMACS and creating a deterministic, hashed encoding.",
    step: 1,
  },
  distributing: {
    eyebrow: "Step 2 of 3",
    title: "Loading the solver",
    body: "Transferring clause-aligned typed-array batches to a dedicated worker.",
    step: 2,
  },
  solving: {
    eyebrow: "Step 3 of 3",
    title: "Exploring assignments",
    body: "CaDiCaL is solving locally in cancellable, conflict-bounded slices.",
    step: 3,
  },
};

function HomePage() {
  const { client, snapshot } = useBrowserSolver();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isActive = ["preparing", "distributing", "solving"].includes(snapshot.phase);

  function selectFile(file: File | undefined) {
    if (!file) return;

    const error = validateCnfFile(file);
    if (error) {
      setValidationError(error);
      return;
    }

    setValidationError(null);
    client.select(file);
    client.prepare();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    selectFile(event.dataTransfer.files?.[0]);
  }

  function resetFile() {
    setValidationError(null);
    client.reset();
  }

  return (
    <div className="site-shell">
      <AppHeader current="home" />

      <main id="top">
        <section className="hero home-hero section-wrap" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="kicker">
              <span className="kicker-line" />
              Browser-native distributed compute
            </div>
            <h1 id="hero-title">
              Send one hard problem.
              <br />
              <span>Let the swarm explore.</span>
            </h1>
            <p className="hero-lede">
              Upload a DIMACS formula, submit it as a public job, and follow the
              verified result from this browser.
            </p>
            <div className="hero-notes" aria-label="Product details">
              <span><CheckIcon /> DIMACS CNF input</span>
              <span><CheckIcon /> No install required</span>
              <span><CheckIcon /> Open browser compute</span>
            </div>
          </div>

          <div className="demo-banner home-hero-note" role="note">
            <span className="demo-tag">Public by design</span>
            <p>
              Swarm jobs are downloadable by participating browsers for up to 24 hours.
              Keep sensitive formulas on your device with the local solver.
            </p>
          </div>
        </section>

        <section className="workbench home-workbench section-wrap" aria-label="SAT job submission">
          <div className="solver-card submit-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">New public job</p>
                <h2>{snapshot.file ? "Prepare your formula" : "Submit to the swarm"}</h2>
              </div>
              <span className="card-index">01</span>
            </div>

            {(snapshot.phase === "empty" || snapshot.phase === "ready") && (
              <>
                {snapshot.file ? (
                  <div className="selected-file">
                    <div className="file-icon"><FileIcon /></div>
                    <div className="file-copy">
                      <strong>{snapshot.file.name}</strong>
                      <span>{formatFileSize(snapshot.file.size)} · DIMACS CNF</span>
                    </div>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Remove ${snapshot.file.name}`}
                      onClick={resetFile}
                    >
                      <XIcon />
                    </button>
                  </div>
                ) : (
                  <div
                    className={`dropzone ${isDragging ? "is-dragging" : ""}`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                  >
                    <span className="upload-icon"><ArrowUpIcon /></span>
                    <h3>Drop your CNF instance here</h3>
                    <p>or choose a file from your computer</p>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Browse files
                    </button>
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  className="visually-hidden"
                  type="file"
                  accept=".cnf,.cnf.gz,text/plain,application/gzip"
                  aria-label="Choose DIMACS CNF file"
                  onChange={handleFileChange}
                />

                {validationError && (
                  <p className="validation-error" role="alert">
                    {validationError}
                  </p>
                )}
                {snapshot.message && (
                  <p className="inline-notice" role="status">{snapshot.message}</p>
                )}

                {snapshot.file && (
                  <div className="solver-actions">
                    <button className="text-button" type="button" onClick={() => fileInputRef.current?.click()}>
                      Replace file
                    </button>
                    <button className="primary-button" type="button" onClick={() => client.prepare()}>
                      Prepare formula <ArrowUpIcon />
                    </button>
                  </div>
                )}

              </>
            )}

            {isActive && snapshot.file && (
              <SolveProgress
                phase={snapshot.phase as "preparing" | "distributing" | "solving"}
                filename={snapshot.file.name}
                progress={snapshot.progress}
                onCancel={() => client.cancel()}
              />
            )}

            {snapshot.phase === "prepared" && snapshot.file && snapshot.prepared && (
              <div className="prepared-panel">
                <div className="selected-file prepared-file">
                  <div className="file-icon"><FileIcon /></div>
                  <div className="file-copy">
                    <strong>{snapshot.file.name}</strong>
                    <span>
                      {snapshot.prepared.variableCount.toLocaleString()} vars · {snapshot.prepared.clauseCount.toLocaleString()} clauses
                    </span>
                  </div>
                  <button className="icon-button" type="button" aria-label={`Remove ${snapshot.file.name}`} onClick={resetFile}>
                    <XIcon />
                  </button>
                </div>
                {snapshot.message && <p className="inline-notice" role="status">{snapshot.message}</p>}
                <PublicJobSubmission formula={snapshot.prepared} filename={snapshot.file.name} />
                <div className="local-solve-option">
                  <div>
                    <strong>Prefer to keep it on this device?</strong>
                    <span>Run the prepared formula locally without uploading it.</span>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => client.solveLocally()}>
                    Solve locally
                  </button>
                </div>
              </div>
            )}

            {snapshot.phase === "result" && snapshot.file && snapshot.result && (
              <ResultPanel
                filename={snapshot.file.name}
                verdict={snapshot.result.verdict}
                fingerprint={snapshot.result.fingerprint}
                elapsedMs={snapshot.result.elapsedMs}
                formulaHash={snapshot.result.formulaHash}
                variableCount={snapshot.result.variableCount}
                clauseCount={snapshot.result.clauseCount}
                modelVerified={snapshot.result.modelVerified}
                model={snapshot.result.model}
                cacheHit={snapshot.result.cacheHit}
                onReset={resetFile}
                onSolveAgain={() => client.solveLocally()}
              />
            )}

            {snapshot.phase === "error" && snapshot.file && (
              <ErrorPanel
                message={snapshot.message ?? "The local solve did not complete."}
                onRetry={() => snapshot.prepared ? client.solveLocally() : client.prepare()}
                onReset={resetFile}
              />
            )}
          </div>
        </section>

        <section className="how section-wrap" id="how-it-works" aria-labelledby="how-title">
          <div className="section-heading">
            <p className="eyebrow">The model</p>
            <h2 id="how-title">Hard problems become smaller together.</h2>
            <p>
              HiveSAT is designed to turn idle browser capacity into a cooperative
              SAT search network—without installs or specialist hardware.
            </p>
          </div>

          <div className="steps-grid">
            <article className="step-card">
              <span className="step-number">01</span>
              <FileIcon />
              <h3>Bring a formula</h3>
              <p>
                Upload a Boolean formula in the standard DIMACS CNF format. A real
                solver will validate it before any work begins.
              </p>
            </article>
            <article className="step-card featured">
              <span className="step-number">02</span>
              <NetworkIcon />
              <h3>Divide the search</h3>
              <p>
                A Cloudflare Durable Object coordinates each job and distributes
                independent search branches across participating browsers.
              </p>
            </article>
            <article className="step-card">
              <span className="step-number">03</span>
              <CpuIcon />
              <h3>Race to an answer</h3>
              <p>
                Workers explore assignments in parallel. The first proof or model
                ends the search and returns the result to the submitter.
              </p>
            </article>
          </div>
        </section>

        <section className="home-disclosure section-wrap" aria-label="Public formula notice">
          <div>
            <p className="eyebrow">Know where your formula runs</p>
            <h2>Public swarm or private local solve—you choose.</h2>
          </div>
          <p>
            Public jobs are uploaded for up to 24 hours and can be downloaded by
            participating browsers. Local solving keeps the formula on this device.
            <a className="text-link" href="https://github.com/LukeLawsonSoftware/hive-sat/blob/main/docs/privacy-and-trust.md"> Read the privacy model</a>.
          </p>
        </section>
      </main>

      <footer className="site-footer section-wrap">
        <a className="brand footer-brand" href="#top">
          <span className="brand-mark" aria-hidden="true"><HexIcon /></span>
          <span>HiveSAT</span>
        </a>
        <p>An experiment in useful, cooperative browser compute.</p>
        <a className="text-link" href="#top">Back to top ↑</a>
      </footer>
    </div>
  );
}

interface SolveProgressProps {
  phase: "preparing" | "distributing" | "solving";
  filename: string;
  progress: import("../lib/solver").SolverProgress | null;
  onCancel: () => void;
}

function SolveProgress({ phase, filename, progress, onCancel }: SolveProgressProps) {
  const details = phaseDetails[phase];
  const percentage = progress?.bytesRead !== undefined && progress.totalBytes
    ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
    : null;

  return (
    <div className="solve-progress" aria-live="polite">
      <div className="progress-orbit" aria-hidden="true">
        <HexIcon />
        <span />
      </div>
      <p className="eyebrow">{details.eyebrow} · Local browser worker</p>
      <h3>{details.title}</h3>
      <p>{details.body}</p>
      {phase === "preparing" && (
        <p className="progress-detail">
          {percentage !== null ? `${percentage}% read` : "Reading stream"}
          {progress?.line ? ` · line ${progress.line.toLocaleString()}` : ""}
        </p>
      )}
      {phase === "solving" && progress?.metrics && (
        <p className="progress-detail">
          {progress.metrics.conflicts.toLocaleString()} conflicts · {progress.metrics.decisions.toLocaleString()} decisions
        </p>
      )}
      <span className="progress-filename">{filename}</span>
      <div className="step-track" aria-hidden="true">
        {[1, 2, 3].map((step) => (
          <span key={step} className={step <= details.step ? "is-complete" : ""} />
        ))}
      </div>
      <button className="text-button cancel-button" type="button" onClick={onCancel}>
        {phase === "solving" ? "Pause solve" : "Cancel processing"}
      </button>
    </div>
  );
}

interface ResultPanelProps {
  filename: string;
  verdict: "SAT" | "UNSAT";
  fingerprint: string;
  elapsedMs: number;
  formulaHash: string;
  variableCount: number;
  clauseCount: number;
  modelVerified: boolean;
  model: number[] | null;
  cacheHit: boolean;
  onReset: () => void;
  onSolveAgain: () => void;
}

function ResultPanel({
  filename,
  verdict,
  fingerprint,
  elapsedMs,
  formulaHash,
  variableCount,
  clauseCount,
  modelVerified,
  model,
  cacheHit,
  onReset,
  onSolveAgain,
}: ResultPanelProps) {
  function downloadModel() {
    if (!model) return;
    const contents = formatDimacsSatModel(model, formulaHash);
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = modelDownloadFilename(filename);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="result-panel" aria-live="polite">
      <span className="result-icon"><CheckIcon /></span>
      <p className="eyebrow">Local CaDiCaL verdict</p>
      <h3>{verdict}</h3>
      <p>
        Solve complete for <strong>{filename}</strong>. {verdict === "SAT"
          ? "An independent TypeScript pass verified the returned model against every clause."
          : "CaDiCaL exhausted the formula locally. Local UNSAT is not proof-certified; public jobs require checked LRAT coverage."}
      </p>
      <dl className="result-meta">
        <div><dt>Local runtime</dt><dd>{(elapsedMs / 1_000).toFixed(2)} s</dd></div>
        <div><dt>Formula</dt><dd>{variableCount.toLocaleString()} vars · {clauseCount.toLocaleString()} clauses</dd></div>
        <div><dt>SHA-256</dt><dd title={formulaHash}>{fingerprint}</dd></div>
        <div><dt>Formula cache</dt><dd>{cacheHit ? "Verified hit" : "Stored"}</dd></div>
        <div><dt>Independent check</dt><dd>{modelVerified ? "Model verified" : "Not applicable"}</dd></div>
      </dl>
      <div className="result-actions">
        {model && (
          <button className="secondary-button" type="button" onClick={downloadModel}>
            Download model
          </button>
        )}
        <button className="secondary-button" type="button" onClick={onSolveAgain}>
          Run again
        </button>
        <button className="primary-button" type="button" onClick={onReset}>
          New instance <ArrowUpIcon />
        </button>
      </div>
    </div>
  );
}

interface ErrorPanelProps {
  message: string;
  onRetry: () => void;
  onReset: () => void;
}

function ErrorPanel({ message, onRetry, onReset }: ErrorPanelProps) {
  return (
    <div className="error-panel" role="alert">
      <span className="error-mark">!</span>
      <p className="eyebrow">Local runtime error</p>
      <h3>That solve stopped.</h3>
      <p>{message}</p>
      <div className="result-actions">
        <button className="secondary-button" type="button" onClick={onReset}>Remove file</button>
        <button className="primary-button" type="button" onClick={onRetry}>Try again</button>
      </div>
    </div>
  );
}

export default HomePage;
