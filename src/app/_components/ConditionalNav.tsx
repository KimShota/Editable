"use client";

import { usePathname } from "next/navigation";
import { Nav } from "./Nav";

/** The app chrome (Templates/Library nav) only makes sense once you're in
 *  the product — the marketing landing page at "/" has its own nav, and the
 *  editor is a full-screen workspace with its own top bar (like CapCut/
 *  Premiere have no surrounding browser chrome once you're editing). */
export function ConditionalNav() {
  const pathname = usePathname();
  if (pathname === "/" || pathname.endsWith("/edit")) return null;
  return <Nav />;
}
