import Link from "next/link";
import type { ReactNode } from "react";
import type { CardStatus } from "@backend/plan/schemas";
import { type StatusAudience, type StatusKey, statusLabel } from "@backend/plan/status";

/** Small reusable UI primitives shared across app pages, styled to the purple/grain theme. */

export function Pill({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "accent" }) {
  const toneClass =
    tone === "accent"
      ? "border-[color:var(--accent)]/40 text-[color:var(--accent)]"
      : "border-[color:var(--card-border)] text-[color:var(--ink-dim)]";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 font-[family-name:var(--font-display)] text-[11px] tracking-[0.08em] uppercase ${toneClass}`}
    >
      {children}
    </span>
  );
}

/** Distinguishes a line the creator speaks on camera from text that's
 *  rendered onto the video — the two are otherwise easy to conflate since
 *  both are edited in a plain textarea. */
export function LineKind({ kind }: { kind: "spoken" | "onscreen" }) {
  if (kind === "spoken") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--accent)]/40 px-3 py-1 font-[family-name:var(--font-display)] text-[11px] tracking-[0.08em] text-[color:var(--accent)] uppercase">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className="shrink-0">
          <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="2" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        You say this
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--card-border)] px-3 py-1 font-[family-name:var(--font-display)] text-[11px] tracking-[0.08em] text-[color:var(--ink-dim)] uppercase">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className="shrink-0">
        <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
        <path d="M7 9h10M7 13h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Shows on screen
    </span>
  );
}

export function Card({
  children,
  className = "",
  href,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  href?: string;
  /** Whole-card click target with no navigation of its own (e.g. "click
   *  this card to kick off an action"), as opposed to `href` (navigates).
   *  Rendered as a real div — role/tabIndex/onKeyDown make it keyboard-
   *  accessible the way an anchor already is natively. */
  onClick?: () => void;
}) {
  const classes = `group rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] transition-colors hover:border-[color:var(--card-border-hover)] ${className}`;
  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        className={`${classes} cursor-pointer`}
      >
        {children}
      </div>
    );
  }
  return <div className={classes}>{children}</div>;
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary";
  disabled?: boolean;
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide transition-transform disabled:opacity-40 disabled:pointer-events-none";
  // Primary is solid ink-on-bg (black-on-white), not the accent color — the
  // blue accent is reserved for badges/links/selected state so it keeps
  // meaning "this is interactive/selected", not "this is a button".
  const variantClass =
    variant === "primary"
      ? "bg-[color:var(--ink)] text-[color:var(--bg)] hover:scale-[1.03]"
      : "border border-[color:var(--card-border)] text-[color:var(--ink)] hover:border-[color:var(--ink)]";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${variantClass} ${className}`}>
      {children}
    </button>
  );
}

export function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
}: {
  kicker?: string;
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6 pb-10">
      <div>
        {kicker && (
          <p className="mb-3 font-[family-name:var(--font-display)] text-[12px] tracking-[0.3em] text-[color:var(--accent)] uppercase">
            {kicker}
          </p>
        )}
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold tracking-tight text-[color:var(--ink)] sm:text-5xl">
          {title}
        </h1>
        {subtitle && <p className="mt-3 max-w-xl text-[color:var(--ink-dim)]">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-[1400px] px-6 py-12 ${className}`}>{children}</div>;
}

const STATUS_STYLE: Record<StatusKey, string> = {
  draft: "bg-[color:var(--st-draft-bg)] text-[color:var(--st-draft-fg)]",
  queued: "bg-[color:var(--st-queued-bg)] text-[color:var(--st-queued-fg)]",
  working: "bg-[color:var(--st-working-bg)] text-[color:var(--st-working-fg)]",
  review: "bg-[color:var(--st-review-bg)] text-[color:var(--st-review-fg)]",
  ready: "bg-[color:var(--st-ready-bg)] text-[color:var(--st-ready-fg)]",
  posted: "bg-[color:var(--st-posted-bg)] text-[color:var(--st-posted-fg)]",
  bad: "bg-[color:var(--st-bad-bg)] text-[color:var(--st-bad-fg)]",
};

/**
 * The one place a card/video status is rendered, so Calendar, Plan, the
 * editor top bar and Admin all say the same thing in the same colour. The
 * words come from `statusLabel` (the customer never sees the internal review
 * gate or a failed run; admins do). `lowConfidence` adds the warning outline
 * QC sets when a clip only passed on its last retry.
 */
export function StatusBadge({
  status,
  lowConfidence = false,
  audience = "customer",
}: {
  status: CardStatus;
  lowConfidence?: boolean;
  audience?: StatusAudience;
}) {
  const { key, label } = statusLabel(status, audience);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5" data-status={status}>
      <span
        className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 font-[family-name:var(--font-display)] text-[11px] leading-tight font-semibold tracking-[0.04em] ${STATUS_STYLE[key]}`}
      >
        {key === "working" && <span aria-hidden="true" className="st-dot-pulse h-1.5 w-1.5 rounded-full bg-current" />}
        {label}
      </span>
      {lowConfidence && (
        <span
          title="Low confidence: a clip only passed quality checks on its last retry. Worth a look."
          className="inline-flex items-center gap-1 rounded-full border border-[color:var(--st-warn)] px-2 py-[3px] text-[11px] font-semibold text-[color:var(--st-warn)]"
        >
          <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none">
            <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M12 10v5M12 18v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="sr-only">Low confidence</span>
        </span>
      )}
    </span>
  );
}

/** A calm placeholder for a screen or section with nothing to show yet: says
 *  what is missing and, where there is one, what to do about it. Used for
 *  honest empty states instead of fake data (plan/ui-ux-full-flow.md §7). */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-[color:var(--card-border)] px-6 py-16 text-center">
      <p className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">{title}</p>
      {children && <div className="mt-2 max-w-md text-[15px] text-[color:var(--ink-dim)]">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
