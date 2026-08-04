import Link from "next/link";
import type { ReactNode } from "react";

/** Small reusable UI primitives shared across app pages, styled to the purple/grain theme. */

export function Pill({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "accent" }) {
  const toneClass =
    tone === "accent"
      ? "border-[color:var(--accent)]/40 text-[color:var(--accent)]"
      : "border-white/12 text-[color:var(--ink-dim)]";
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
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1 font-[family-name:var(--font-display)] text-[11px] tracking-[0.08em] text-[color:var(--ink-dim)] uppercase">
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
  const variantClass =
    variant === "primary"
      ? "bg-[color:var(--accent)] text-[color:var(--accent-ink)] hover:scale-[1.03]"
      : "border border-white/15 text-[color:var(--ink)] hover:border-white/35";
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
