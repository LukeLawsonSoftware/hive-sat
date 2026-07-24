import { useEffect, useRef, useState } from "react";
import { VerifiedFormulaCache } from "../lib/formula/cache";
import { submitPublicJob } from "../lib/publicJobs";

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    callback(token: string): void;
    "expired-callback"(): void;
    "error-callback"(): void;
  }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface HealthResponse {
  features?: { publicJobs?: boolean };
  turnstileSiteKey?: string;
}

export function PublicJobSubmission({ formulaHash }: { formulaHash: string }) {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [consent, setConsent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/health", { signal: controller.signal })
      .then((response) => response.json() as Promise<HealthResponse>)
      .then((health) => {
        setEnabled(health.features?.publicJobs === true);
        setSiteKey(health.turnstileSiteKey ?? null);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setEnabled(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!enabled || !siteKey || !widgetRef.current) return;
    let widgetId: string | null = null;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.turnstile || !widgetRef.current || widgetId) return;
      widgetId = window.turnstile.render(widgetRef.current, {
        sitekey: siteKey,
        callback: setTurnstileToken,
        "expired-callback": () => setTurnstileToken(null),
        "error-callback": () => setMessage("The anti-abuse challenge could not be completed."),
      });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-hivesat-turnstile="true"]');
    if (existing) {
      existing.addEventListener("load", render);
      render();
    } else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.hivesatTurnstile = "true";
      script.addEventListener("load", render);
      document.head.append(script);
    }
    return () => {
      cancelled = true;
      existing?.removeEventListener("load", render);
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [enabled, siteKey]);

  async function submit() {
    if (!consent || !turnstileToken) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const cachedFormula = await new VerifiedFormulaCache().get(formulaHash);
      if (!cachedFormula) throw new Error("The verified local formula is no longer cached. Run the solve again.");
      const job = await submitPublicJob({
        turnstileToken,
        publicConsent: true,
        cachedFormula,
      });
      window.location.assign(job.ownerUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The public job could not be submitted.");
      setSubmitting(false);
    }
  }

  if (enabled === false) {
    return <p className="inline-notice">Public submission is feature-flagged off in this deployment.</p>;
  }
  if (enabled === null) return <p className="inline-notice">Checking public-job availability…</p>;

  return (
    <section className="public-submit" aria-labelledby="public-submit-title">
      <p className="eyebrow">Optional public job</p>
      <h4 id="public-submit-title">Send this formula to the browser swarm</h4>
      <p>
        Every server-submitted formula is public to participating browsers for 24 hours.
        Confidential and private jobs are not supported.
      </p>
      <label className="consent-row">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        I understand and consent to this formula being public to swarm participants.
      </label>
      <div ref={widgetRef} className="turnstile-slot" aria-label="Anti-abuse challenge" />
      {message && <p className="validation-error" role="alert">{message}</p>}
      <button
        className="primary-button"
        type="button"
        disabled={!consent || !turnstileToken || submitting}
        onClick={() => void submit()}
      >
        {submitting ? "Creating public job…" : "Create public job"}
      </button>
    </section>
  );
}
