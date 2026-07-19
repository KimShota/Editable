"use client";

import { usePathname } from "next/navigation";
import { Nav } from "./Nav";

/** The app chrome (Templates/Library nav) only makes sense once you're in
 *  the product — the marketing landing page at "/" has its own nav. */
export function ConditionalNav() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return <Nav />;
}
