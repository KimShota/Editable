"use client";

import { type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "../../_components/LogoutButton";
import { BrandSwitcher, type ShellBrand } from "./BrandSwitcher";

/**
 * The signed-in app's chrome (plan/ui-ux-full-flow.md §2.5): a left sidebar
 * with the brand switcher, the main sections and the account menu, which
 * collapses to a top bar and a drawer below the `md` breakpoint. The editor
 * is deliberately outside this layout (it is full-screen).
 *
 * NAV lists only screens that exist. Each slice of the rollout adds its
 * entry when its page lands (Plan, Analytics, Brand; Workspace and Admin in
 * the account menu), so the nav never points at a 404.
 */

type NavItem = { href: string; label: string; icon: ReactNode };

const icon = (d: ReactNode) => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0">
    {d}
  </svg>
);

const NAV: NavItem[] = [
  {
    href: "/calendar",
    label: "Calendar",
    icon: icon(
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </>,
    ),
  },
  {
    href: "/plan",
    label: "Plan",
    icon: icon(
      <>
        <rect x="4" y="4.5" width="16" height="4.5" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
        <rect x="4" y="11" width="16" height="4.5" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M4 18.5h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </>,
    ),
  },
];

/** Extra links in the account menu at the bottom (Workspace, and Admin for
 *  admins). Filled in by the slices that build those pages. */
const MENU: (NavItem & { adminOnly?: boolean })[] = [
  {
    href: "/admin/sources",
    label: "Admin",
    adminOnly: true,
    icon: icon(
      <>
        <path d="M12 3.5 4.5 6.5v5.2c0 4.1 2.9 7.2 7.5 8.8 4.6-1.6 7.5-4.7 7.5-8.8V6.5L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </>,
    ),
  },
];

const isActive = (pathname: string, href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);

const linkClass = (active: boolean): string =>
  `flex items-center gap-3 rounded-xl px-3 py-2.5 font-[family-name:var(--font-display)] text-[14px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] ${
    active ? "bg-black/[0.06] text-[color:var(--ink)]" : "text-[color:var(--ink-dim)] hover:bg-black/[0.04] hover:text-[color:var(--ink)]"
  }`;

type Props = { email: string; isAdmin: boolean; brands: ShellBrand[]; activeSlug: string | null; children: ReactNode };

export function AppShell({ email, isAdmin, brands, activeSlug, children }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // A drawer left open after navigating would cover the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // While the drawer covers the screen, the page behind it must not scroll.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const menu = MENU.filter((m) => !m.adminOnly || isAdmin);

  const panel = (
    <div className="flex h-full flex-col gap-6">
      <BrandSwitcher brands={brands} activeSlug={activeSlug} />
      <nav aria-label="Main" className="flex flex-col gap-1">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} aria-current={isActive(pathname, item.href) ? "page" : undefined} className={linkClass(isActive(pathname, item.href))}>
            {item.icon}
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-1">
        {menu.map((item) => (
          <Link key={item.href} href={item.href} aria-current={isActive(pathname, item.href) ? "page" : undefined} className={linkClass(isActive(pathname, item.href))}>
            {item.icon}
            {item.label}
          </Link>
        ))}
        <div className="mt-2 flex flex-col gap-2 border-t border-[color:var(--card-border)] pt-4">
          <p className="truncate px-1 text-[12px] text-[color:var(--ink-dim)]" title={email}>
            {email}
          </p>
          <LogoutButton />
        </div>
      </div>
    </div>
  );

  // One panel in the DOM, repositioned by breakpoint: a sticky sidebar from
  // `md` up, and below that a full-height drawer under the top bar that is
  // shown only while `open`. (Rendering it twice, once per layout, would
  // leave two brand selects and two navs mounted at the same time.)
  return (
    <div className="md:flex md:min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[color:var(--card-border)] bg-[color:var(--bg)]/90 backdrop-blur-md md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/calendar" className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[0.22em] text-[color:var(--ink)]">
            KATALAB
          </Link>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="app-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--card-border)] text-[color:var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
          >
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
              {open ? <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
            </svg>
          </button>
        </div>
      </header>

      <aside
        id="app-nav"
        className={`${open ? "block" : "hidden"} border-[color:var(--card-border)] bg-[color:var(--bg)] p-4 max-md:fixed max-md:inset-x-0 max-md:top-14 max-md:bottom-0 max-md:z-30 max-md:overflow-y-auto md:sticky md:top-0 md:block md:h-screen md:w-64 md:shrink-0 md:border-r md:bg-[color:var(--bg)]/80 md:backdrop-blur-md`}
      >
        <Link href="/calendar" className="mb-6 hidden px-1 font-[family-name:var(--font-display)] text-sm font-bold tracking-[0.22em] text-[color:var(--ink)] md:block">
          KATALAB
        </Link>
        <div className="md:h-[calc(100%-3.25rem)]">{panel}</div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
