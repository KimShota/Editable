"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/** The app chrome (Templates/Library nav) only makes sense once you're in
 *  the product — the marketing landing page at "/" has its own nav, the
 *  login/signup pages are their own minimal flow, and the editor is a
 *  full-screen workspace with its own top bar (like CapCut/Premiere have no
 *  surrounding browser chrome once you're editing).
 *
 * Takes `<Nav />` as `children` rather than importing/rendering it directly:
 * Nav is a server component that reads the session cookie (see Nav.tsx), and
 * a client component can't instantiate a server component in its own JSX —
 * only render one that a server parent (layout.tsx) already produced. */
const NAV_HIDDEN_PATHS = new Set(["/", "/login", "/signup"]);

export function ConditionalNav({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (NAV_HIDDEN_PATHS.has(pathname) || pathname.endsWith("/edit")) return null;
  return <>{children}</>;
}
