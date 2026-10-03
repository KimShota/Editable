import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { isDemoMode } from "../../../lib/demo";
import { Container, EmptyState, PageHeader } from "../../../_components/ui";
import { AdminTabs } from "../_components/AdminTabs";
import { DemoToggle } from "../_components/DemoToggle";

export const metadata: Metadata = { title: "Demo · Katalab" };

/** The founder's switch for showing the product: demo mode, and a replay of
 *  each brand's setup. Admin only. */
export default async function AdminDemoPage() {
  const user = (await getRequestUser())!;
  if (!user.isAdmin) notFound();
  const on = await isDemoMode(user);
  const brands = await brandRepo.listBrandsForUser(user);

  return (
    <Container>
      <PageHeader title="Demo" subtitle="Show how a brand is set up, without generating or saving anything." />
      <AdminTabs />

      <section aria-labelledby="mode-title" className="mb-10 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
        <h2 id="mode-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">
          Demo mode is {on ? "on" : "off"}
        </h2>
        <p className="mt-1 mb-4 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">
          It lets the setup flow replay a brand&apos;s real character, voice and plan with the pacing of a live setup. It only works for you, in this browser, and it turns itself off after 12 hours.
        </p>
        <DemoToggle on={on} />
      </section>

      <h2 className="mb-3 font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Replay a brand&apos;s setup</h2>
      {brands.length === 0 ? (
        <EmptyState title="No brands yet">Link a brand first (npm run brand:link).</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Brands to replay">
          {brands.map((b) => (
            <li key={b.slug} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] px-5 py-4">
              <span className="font-[family-name:var(--font-display)] text-[15px] font-semibold text-[color:var(--ink)]">{b.name}</span>
              {on ? (
                <Link href={`/onboarding/website?replay=${b.slug}`} className="rounded-full bg-[color:var(--ink)] px-5 py-2 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]">
                  Replay setup for {b.name}
                </Link>
              ) : (
                <span className="text-sm text-[color:var(--ink-dim)]">Turn demo mode on to replay</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
