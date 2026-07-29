import {
  type ChangeEvent,
  type DragEvent,
  useEffect,
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
  ShieldIcon,
  XIcon,
} from "../components/Icons";
import { useBrowserSolver } from "../hooks/useBrowserSolver";
import {
  formatFileSize,
  type SolverPhase,
  validateCnfFile,
} from "../lib/solver";
import { formatDimacsSatModel, modelDownloadFilename } from "../lib/formula/modelOutput";
import { PublicJobSubmission } from "../components/PublicJobSubmission";

const HIVE_PREFERENCE_KEY = "hivesat:hive-enabled";

const phaseDetails: Record<
  Extract<SolverPhase, "queued" | "distributing" | "solving">,
  { eyebrow: string; title: string; body: string; step: number }
> = {
  queued: {
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

function readHivePreference(): boolean {
  try {
    const stored = window.localStorage.getItem(HIVE_PREFERENCE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function HomePage() {
  const { client, snapshot } = useBrowserSolver();
  const [hiveEnabled, setHiveEnabled] = useState(readHivePreference);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isActive = ["queued", "distributing", "solving"].includes(snapshot.phase);
  const hasPersonalJob = isActive || snapshot.phase === "result" || snapshot.phase === "error";
  const helpingCount = hiveEnabled ? (hasPersonalJob ? 2 : 4) : 0;

  useEffect(() => {
    try {
      window.localStorage.setItem(HIVE_PREFERENCE_KEY, String(hiveEnabled));
    } catch {
      // The preference stays in memory when storage is unavailable.
    }
  }, [hiveEnabled]);

  function selectFile(file: File | undefined) {
    if (!file) return;

    const error = validateCnfFile(file);
    if (error) {
      setValidationError(error);
      return;
    }

    setValidationError(null);
    client.select(file);
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

  function toggleHive() {
    setHiveEnabled((enabled) => !enabled);
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="HiveSAT home">
          <span className="brand-mark" aria-hidden="true">
            <HexIcon />
          </span>
          <span>HiveSAT</span>
        </a>

        <div className="header-actions">
          <a className="text-link header-link" href="#how-it-works">
            How it works
          </a>
          <div className={`header-hive ${hiveEnabled ? "is-on" : ""}`}>
            <span className="status-dot" aria-hidden="true" />
            <span className="header-hive-copy">
              <strong>{hiveEnabled ? "Hive active" : "Hive paused"}</strong>
              <small>{hiveEnabled ? `Helping ${helpingCount}` : "Not contributing"}</small>
            </span>
            <button
              className="switch"
              type="button"
              role="switch"
              aria-checked={hiveEnabled}
              aria-label="Join the hive"
              onClick={toggleHive}
            >
              <span />
            </button>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero section-wrap" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="kicker">
              <span className="kicker-line" />
              Browser-native distributed compute
            </div>
            <h1 id="hero-title">
              Many browsers.
              <br />
              <span>One hard problem.</span>
            </h1>
            <p className="hero-lede">
              Submit a Boolean satisfiability problem and let a hive of browsers
              explore the search space together.
            </p>
            <div className="hero-notes" aria-label="Product details">
              <span><CheckIcon /> DIMACS CNF input</span>
              <span><CheckIcon /> No install required</span>
              <span><CheckIcon /> Open browser compute</span>
            </div>
          </div>

          <div className="demo-banner" role="note">
            <span className="demo-tag">Local solver</span>
            <p>
              DIMACS parsing, SHA-256 hashing, model verification, and bounded
              CaDiCaL solving all run in dedicated workers in this browser.
            </p>
          </div>
        </section>

        <section className="workbench section-wrap" aria-label="SAT solver workspace">
          <div className="solver-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Your instance</p>
                <h2>{hasPersonalJob ? "Your solve" : "Start a solve"}</h2>
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

                <div className="solver-actions">
                  {snapshot.file && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Replace file
                    </button>
                  )}
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!snapshot.file}
                    onClick={() => client.start()}
                  >
                    <span>Solve instance</span>
                    <ArrowUpIcon />
                  </button>
                </div>
              </>
            )}

            {isActive && snapshot.file && (
              <SolveProgress
                phase={snapshot.phase as "queued" | "distributing" | "solving"}
                filename={snapshot.file.name}
                progress={snapshot.progress}
                onCancel={() => client.cancel()}
              />
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
                onSolveAgain={() => client.start()}
              />
            )}

            {snapshot.phase === "error" && snapshot.file && (
              <ErrorPanel
                message={snapshot.message ?? "The local solve did not complete."}
                onRetry={() => client.start()}
                onReset={resetFile}
              />
            )}
          </div>

          <HiveCard
            enabled={hiveEnabled}
            helpingCount={helpingCount}
            hasPersonalJob={hasPersonalJob}
            onToggle={toggleHive}
          />
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
                A later phase will let a Cloudflare Durable Object coordinate the
                job and distribute independent branches across browsers.
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

        <section className="explainer section-wrap" aria-label="About SAT and privacy">
          <article className="explainer-copy">
            <p className="eyebrow">Why SAT?</p>
            <h2>A compact language for difficult decisions.</h2>
            <p>
              Boolean satisfiability asks whether variables can be assigned true or
              false so that every constraint is satisfied. It sits underneath
              planning, verification, scheduling, circuit design, and countless
              other computational problems.
            </p>
            <p>
              SAT is also famously hard in the general case. That makes it an ideal
              laboratory for cooperative browser compute: many independent search
              branches can be explored at the same time.
            </p>
          </article>

          <aside className="privacy-card">
            <div className="privacy-icon"><ShieldIcon /></div>
            <p className="eyebrow">Before you upload</p>
            <h2>Assume hive work is visible.</h2>
            <p>
              In the future distributed version, formulas or derived work units may
              be sent to other participating browsers. Do not submit confidential or
              sensitive instances.
            </p>
            <div className="privacy-rule" />
            <p className="privacy-footnote">
              <strong>Right now:</strong> the selected formula is parsed and solved
              locally. It is cached by hash in this browser and is not uploaded.
            </p>
          </aside>
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
  phase: "queued" | "distributing" | "solving";
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
      {phase === "queued" && (
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
      <PublicJobSubmission formulaHash={formulaHash} />
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

interface HiveCardProps {
  enabled: boolean;
  helpingCount: number;
  hasPersonalJob: boolean;
  onToggle: () => void;
}

function HiveCard({ enabled, helpingCount, hasPersonalJob, onToggle }: HiveCardProps) {
  return (
    <aside className={`hive-card ${enabled ? "is-active" : ""}`} aria-labelledby="hive-card-title">
      <div className="hive-visual" aria-hidden="true">
        <span className="hive-cell cell-one"><HexIcon /></span>
        <span className="hive-cell cell-two"><HexIcon /></span>
        <span className="hive-cell cell-three"><HexIcon /></span>
        <span className="hive-pulse" />
      </div>
      <div className="hive-content">
        <p className="eyebrow">Your browser</p>
        <h2 id="hive-card-title">
          {enabled ? (
            <>Helping <span>{helpingCount}</span> other {helpingCount === 1 ? "instance" : "instances"}</>
          ) : (
            "Contribution paused"
          )}
        </h2>
        <p>
          {enabled
            ? hasPersonalJob
              ? "Your local solve has priority. Public contribution starts only on the Swarm Mode page."
              : "Your contribution preference is enabled. Open Swarm Mode when you want to start public work."
            : "Your browser is not accepting hive work. You can rejoin at any time."}
        </p>
      </div>
      <div className="hive-control">
        <div>
          <strong>Join the hive</strong>
          <span>{enabled ? "Contribution enabled" : "Contribution disabled"}</span>
        </div>
        <button
          className="switch large"
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Join the hive from contribution panel"
          onClick={onToggle}
        >
          <span />
        </button>
      </div>
      <p className="hive-disclosure">
        Public work runs only on <a href="/swarm">Swarm Mode</a> · Preference saved on this device
      </p>
    </aside>
  );
}

export default HomePage;
