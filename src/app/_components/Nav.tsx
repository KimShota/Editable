import Link from "next/link";

const LINKS = [
  { href: "/templates", label: "Templates" },
  { href: "/library", label: "Library" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[color:var(--bg)]/70 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
        <Link
          href="/templates"
          className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[0.22em] text-[color:var(--ink)]"
        >
          EDITABLE
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-full px-4 py-2 font-[family-name:var(--font-display)] text-[13px] tracking-wide text-[color:var(--ink-dim)] transition-colors hover:bg-white/5 hover:text-[color:var(--ink)]"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
