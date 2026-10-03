"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type ShellBrand = { slug: string; name: string };

/**
 * The brand the user is looking at, at the top of the sidebar. With one
 * brand it is just a label; with several (the Agency tier) it is a select
 * that records the choice in the `katalab_brand` cookie via
 * POST /api/active-brand and re-renders. A native <select> keeps it
 * keyboard- and screen-reader-accessible without any extra work.
 */
export function BrandSwitcher({ brands, activeSlug }: { brands: ShellBrand[]; activeSlug: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = brands.find((b) => b.slug === activeSlug) ?? brands[0];

  const choose = async (slug: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/active-brand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      setError("Could not switch brand.");
    } finally {
      setBusy(false);
    }
  };

  if (!active) {
    return <p className="rounded-xl border border-dashed border-[color:var(--card-border)] px-3 py-2.5 text-[13px] text-[color:var(--ink-dim)]">No brand yet</p>;
  }

  const body = (
    <>
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--ink)] font-[family-name:var(--font-display)] text-sm font-bold text-[color:var(--bg)]"
      >
        {active.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate text-left font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">{active.name}</span>
    </>
  );

  if (brands.length === 1) {
    return <div className="flex items-center gap-3 rounded-xl border border-[color:var(--card-border)] px-3 py-2.5">{body}</div>;
  }

  return (
    <div>
      <label className="relative flex items-center gap-3 rounded-xl border border-[color:var(--card-border)] px-3 py-2.5 focus-within:border-[color:var(--accent)]">
        {body}
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-[color:var(--ink-dim)]">
          <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <select
          aria-label="Brand"
          value={active.slug}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          {brands.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="mt-1.5 text-xs text-[color:var(--st-bad-fg)]">{error}</p>}
    </div>
  );
}
