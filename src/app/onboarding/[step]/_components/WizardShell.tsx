import type { ReactNode } from "react";
import Link from "next/link";
import { STEPS, stepIndex } from "./steps";

/**
 * The frame of the onboarding wizard: which step this is, how to move
 * between them, and (because this is a replay) a plain statement that
 * nothing here is generated or saved. Every link keeps `?replay=<slug>`.
 */
export function WizardShell({ step, slug, brandName, hideNext = false, nextHref, children }: { step: string; slug: string; brandName: string; hideNext?: boolean; nextHref?: string; children: ReactNode }) {
  const at = stepIndex(step);
  const href = (i: number) => `/onboarding/${STEPS[i].id}?replay=${slug}`;
  const prev = at > 0 ? href(at - 1) : null;
  const next = nextHref ?? (at < STEPS.length - 1 ? href(at + 1) : "/plan");

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-5xl flex-col px-4 py-6 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <Link href="/admin/demo" className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[0.22em] text-[color:var(--ink)]">
          KATALAB
        </Link>
        <p className="text-sm text-[color:var(--ink-dim)]">{brandName}</p>
      </header>

      <p role="note" className="mt-4 rounded-xl bg-[color:var(--st-queued-bg)] px-4 py-2.5 text-sm text-[color:var(--st-queued-fg)]">
        This is a replay of how {brandName} was set up. Nothing is generated and nothing is saved.
      </p>

      <nav aria-label="Setup steps" className="mt-8">
        <ol className="grid grid-cols-5 gap-2">
          {STEPS.map((s, i) => {
            const state = i < at ? "done" : i === at ? "current" : "todo";
            return (
              <li key={s.id}>
                <Link
                  href={href(i)}
                  aria-current={state === "current" ? "step" : undefined}
                  className="group flex flex-col gap-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--accent)]"
                >
                  <span className={`h-1 rounded-full ${state === "todo" ? "bg-[color:var(--bg-2)]" : "bg-[color:var(--ink)]"}`} />
                  <span className={`hidden text-xs font-medium sm:block ${state === "current" ? "text-[color:var(--ink)]" : "text-[color:var(--ink-dim)] group-hover:text-[color:var(--ink)]"}`}>
                    {s.label}
                    {state === "done" && <span className="sr-only"> (done)</span>}
                  </span>
                  <span className="sr-only sm:hidden">{s.label}</span>
                </Link>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs text-[color:var(--ink-dim)] sm:hidden" aria-hidden="true">
          Step {at + 1} of {STEPS.length}: {STEPS[at].label}
        </p>
      </nav>

      <main className="flex-1 py-10">
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-[color:var(--ink)] sm:text-4xl">{STEPS[at].title}</h1>
        <p className="mt-2 max-w-[65ch] text-[color:var(--ink-dim)]">{STEPS[at].blurb}</p>
        <div className="mt-8">{children}</div>
      </main>

      <footer className="flex items-center justify-between gap-4 border-t border-[color:var(--card-border)] pt-5">
        {prev ? (
          <Link href={prev} className="rounded-full border border-[color:var(--card-border)] px-5 py-2.5 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--ink)] transition-colors hover:border-[color:var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]">
            Back
          </Link>
        ) : (
          <span />
        )}
        {!hideNext && (
          <Link href={next} className="rounded-full bg-[color:var(--ink)] px-6 py-2.5 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]">
            {at === STEPS.length - 1 ? "Review your plan" : "Continue"}
          </Link>
        )}
      </footer>
    </div>
  );
}
