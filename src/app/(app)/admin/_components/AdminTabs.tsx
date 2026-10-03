"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/production", label: "Production" },
  { href: "/admin/review", label: "Review" },
  { href: "/admin/sources", label: "Viral videos" },
  { href: "/admin/brands", label: "Brands" },
  { href: "/admin/cost", label: "Cost" },
  { href: "/admin/demo", label: "Demo" },
  { href: "/admin/reverse-engineer", label: "Reverse-engineer" },
];

/** The founder's sections, shared by every admin screen. */
export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="mb-8 flex gap-1 overflow-x-auto border-b border-[color:var(--card-border)]">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-4 py-2.5 font-[family-name:var(--font-display)] text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--accent)] ${
              active ? "border-[color:var(--ink)] text-[color:var(--ink)]" : "border-transparent text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
