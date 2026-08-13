import Link from "next/link";
import { cookies } from "next/headers";
import { getSessionUser, SessionUser, SESSION_COOKIE } from "../lib/auth";
import { getQuotaStatus, QuotaStatus } from "../lib/quota";
import { LogoutButton } from "./LogoutButton";
import { Pill } from "./ui";

const LINKS = [
  { href: "/projects", label: "Projects" },
  { href: "/templates", label: "Templates" },
  { href: "/reverse-engineer", label: "Reverse-engineer", adminOnly: true },
  { href: "/library", label: "Library" },
];

export async function Nav() {
  // Best-effort: this renders on every page (ConditionalNav only hides it
  // client-side, after the server has already produced it), including "/"
  // on the standalone waitlist-only Vercel deploy — see middleware.ts's
  // NEXT_PUBLIC_APP_ENABLED gate. That deploy's DB may never have had
  // 002_accounts.sql applied, so a lookup failure here falls back to
  // "logged out" instead of crashing the whole page.
  let user: SessionUser | null = null;
  try {
    const cookieStore = await cookies();
    user = await getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);
  } catch (err) {
    console.error("Nav: session lookup failed", err);
  }
  const links = LINKS.filter((link) => !link.adminOnly || user?.isAdmin);

  // Same best-effort shape as the session lookup above — a quota query
  // failure shouldn't take down every page's nav, it just means the badge
  // is silently absent for this render.
  let quota: QuotaStatus | null = null;
  if (user) {
    try {
      quota = await getQuotaStatus(user);
    } catch (err) {
      console.error("Nav: quota lookup failed", err);
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[color:var(--bg)]/70 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
        <Link
          href="/"
          className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[0.22em] text-[color:var(--ink)]"
        >
          EDITABLE
        </Link>
        <nav className="flex items-center gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-full px-4 py-2 font-[family-name:var(--font-display)] text-[13px] tracking-wide text-[color:var(--ink-dim)] transition-colors hover:bg-white/5 hover:text-[color:var(--ink)]"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        {user && (
          <div className="flex items-center gap-3">
            {quota && !quota.unlimited && (
              <Pill tone={quota.remaining === 0 ? "accent" : "default"}>
                {quota.remaining} video{quota.remaining === 1 ? "" : "s"} left today
              </Pill>
            )}
            <span className="text-[13px] text-[color:var(--ink-dim)]">{user.email}</span>
            <LogoutButton />
          </div>
        )}
      </div>
    </header>
  );
}
