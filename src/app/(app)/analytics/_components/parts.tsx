import Link from "next/link";
import type { ReactNode } from "react";

/** Pieces shared by the Analytics and Cycle Review screens. */

export function AnalyticsTabs({ current }: { current: "overview" | "review" }) {
  const tab = (href: string, text: string, on: boolean) => (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      className={`-mb-px border-b-2 px-4 py-2.5 font-[family-name:var(--font-display)] text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--accent)] ${on ? "border-[color:var(--ink)] text-[color:var(--ink)]" : "border-transparent text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"}`}
    >
      {text}
    </Link>
  );
  return (
    <nav aria-label="Analytics sections" className="mb-8 flex gap-1 border-b border-[color:var(--card-border)]">
      {tab("/analytics", "Overview", current === "overview")}
      {tab("/analytics/cycle-review", "Cycle review", current === "review")}
    </nav>
  );
}

/** Shown on every number that is not real. Sample numbers never appear without it. */
export function SampleBanner() {
  return (
    <p role="note" data-testid="sample-banner" className="mb-6 rounded-xl bg-[color:var(--st-working-bg)] px-4 py-3 text-sm text-[color:var(--st-working-fg)]">
      <strong>Sample data.</strong> This is what your dashboard looks like after a cycle. These numbers are not real.
    </p>
  );
}

export function Stat({ label, value, hint, sample }: { label: string; value: ReactNode; hint?: string; sample?: boolean }) {
  return (
    <div className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
      <p className="text-sm text-[color:var(--ink-dim)]">{label}</p>
      <p className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-[color:var(--ink)] tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-[13px] text-[color:var(--ink-dim)]">{hint}</p>}
      {sample && <span className="sr-only">Sample number</span>}
    </div>
  );
}

/** A grey placeholder where a real number will go: a missing number is not zero. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded-md bg-[color:var(--bg-2)] ${className}`} />;
}

/** Views per video over the cycle, as a plain line chart. With no points it
 *  draws an empty frame, never a made-up line. */
export function ViewsChart({ points, label }: { points: { day: number; views: number }[]; label: string }) {
  const W = 640;
  const H = 200;
  // Side padding leaves room for the first and last day labels, which are centred on their points.
  const pad = { l: 32, r: 32, t: 12, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.views));
  const x = (i: number) => pad.l + (points.length <= 1 ? (W - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.views).toFixed(1)}`).join(" ");
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <title>{label}</title>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + (1 - f) * (H - pad.t - pad.b)} y2={pad.t + (1 - f) * (H - pad.t - pad.b)} stroke="var(--card-border)" strokeDasharray={points.length ? undefined : "4 6"} />
      ))}
      {points.length > 0 && <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      {points.map((p, i) => (
        <g key={p.day}>
          <circle cx={x(i)} cy={y(p.views)} r="4" fill="var(--card)" stroke="var(--accent)" strokeWidth="2" />
          <text x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--ink-dim)">{`Day ${p.day}`}</text>
        </g>
      ))}
    </svg>
  );
}
