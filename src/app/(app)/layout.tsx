import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getActiveBrand } from "../lib/activeBrand";
import { getRequestUser } from "../lib/auth";
import { AppShell } from "./_components/AppShell";

/**
 * Everything signed-in customers and the founder use except the editor:
 * calendar, plan, brand, analytics, workspace, admin (plan/ui-ux-full-flow.md
 * §2.5). The proxy already requires a session, so the redirect below is only
 * a backstop.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getRequestUser();
  if (!user) redirect("/login");

  const { active, all } = await getActiveBrand(user);
  return (
    <AppShell email={user.email} isAdmin={user.isAdmin} brands={all.map((b) => ({ slug: b.slug, name: b.name }))} activeSlug={active?.slug ?? null}>
      {children}
    </AppShell>
  );
}
