"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { BOOKING_URL, copy, CTA_MODE } from "../landing-copy";

type State =
  | { step: "website" }
  | { step: "email"; id: string; brand: string }
  | { step: "done"; brand: string; email: string };

const fill = (text: string, values: Record<string, string>): string => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

const utmFromUrl = (): Record<string, string> => {
  const out: Record<string, string> = {};
  new URLSearchParams(window.location.search).forEach((value, key) => {
    if (key.startsWith("utm_")) out[key] = value;
  });
  return out;
};

const post = async (body: unknown): Promise<{ ok: boolean; data: Record<string, string> }> => {
  const res = await fetch("/api/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  return { ok: res.ok, data };
};

/**
 * The page's one action (plan/landing-page-founder-proof.md section 3):
 * paste a website → leave an email → confirmation in the founder's voice.
 * With NEXT_PUBLIC_LANDING_CTA_MODE=onboarding the first step goes straight
 * to /signup instead.
 */
export function LeadForm({ id }: { id?: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ step: "website" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const websiteRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  const submitWebsite = async (event: React.FormEvent) => {
    event.preventDefault();
    const website = websiteRef.current?.value ?? "";
    setError(null);
    if (CTA_MODE === "onboarding") {
      router.push(`/signup?website=${encodeURIComponent(website)}`);
      return;
    }
    setBusy(true);
    try {
      const { ok, data } = await post({ step: "website", website, company: honeypot.current?.value ?? "", referrer: document.referrer, utm: utmFromUrl() });
      if (!ok) return setError(data.error ?? copy.form.networkError);
      setState({ step: "email", id: data.id, brand: data.brand });
      setTimeout(() => emailRef.current?.focus(), 0);
    } catch {
      setError(copy.form.networkError);
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    if (state.step !== "email") return;
    const email = emailRef.current?.value ?? "";
    setError(null);
    setBusy(true);
    try {
      const { ok, data } = await post({ step: "email", id: state.id, email });
      if (!ok) return setError(data.error ?? copy.form.networkError);
      setState({ step: "done", brand: data.brand ?? state.brand, email: email.trim() });
    } catch {
      setError(copy.form.networkError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lead" id={id}>
      {state.step === "website" && (
        <form className="lead__row" onSubmit={submitWebsite} noValidate>
          <label className="sr-only" htmlFor={`${id ?? "lead"}-website`}>{copy.form.websiteLabel}</label>
          <input
            id={`${id ?? "lead"}-website`}
            ref={websiteRef}
            className="lead__input"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={copy.form.websitePlaceholder}
          />
          <input ref={honeypot} className="lead__trap" type="text" name="company" tabIndex={-1} autoComplete="off" aria-hidden="true" />
          <button className="btn btn--primary lead__button" type="submit" disabled={busy}>
            {busy ? copy.form.sending : <>{copy.form.websiteButton} <span aria-hidden="true">→</span></>}
          </button>
        </form>
      )}

      {state.step === "email" && (
        <form className="lead__stack" onSubmit={submitEmail} noValidate>
          <p className="lead__prompt">{fill(copy.form.emailPrompt, { brand: state.brand })}</p>
          <div className="lead__row">
            <label className="sr-only" htmlFor={`${id ?? "lead"}-email`}>{copy.form.emailLabel}</label>
            <input
              id={`${id ?? "lead"}-email`}
              ref={emailRef}
              className="lead__input"
              type="email"
              autoComplete="email"
              placeholder={copy.form.emailPlaceholder}
            />
            <button className="btn btn--primary lead__button" type="submit" disabled={busy}>
              {busy ? copy.form.sending : <>{copy.form.emailButton} <span aria-hidden="true">→</span></>}
            </button>
          </div>
        </form>
      )}

      {state.step === "done" && (
        <p className="lead__done" role="status">
          {fill(copy.form.done, { brand: state.brand, email: state.email })} <span className="lead__sig">{copy.form.signature}</span>
        </p>
      )}

      {error && <p className="lead__error" role="alert">{error}</p>}

      {state.step !== "done" && (
        <a className="lead__talk" href={BOOKING_URL} target="_blank" rel="noopener noreferrer">
          {copy.form.talk}
        </a>
      )}
    </div>
  );
}
