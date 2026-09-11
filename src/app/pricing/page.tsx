import Link from "next/link";
import { cookies } from "next/headers";
import { getSessionUser, SessionUser, SESSION_COOKIE } from "../lib/auth";
import { dailyLimit } from "../lib/quota";
import { Container, PageHeader, Card, Pill } from "../_components/ui";
import { UpgradeButton } from "./_components/UpgradeButton";

export default async function PricingPage() {
  const cookieStore = await cookies();
  const user: SessionUser | null = await getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);
  const isPremium = user?.plan === "premium";

  return (
    <Container className="max-w-3xl">
      <PageHeader kicker="Katalab" title="Pricing" subtitle="Pick the plan that fits how much you're rendering." />
      <div className="grid gap-6 sm:grid-cols-2">
        <Card className="flex flex-col gap-4 p-6">
          <div>
            <Pill>Free</Pill>
            <p className="mt-4 font-[family-name:var(--font-display)] text-3xl font-bold text-[color:var(--ink)]">$0</p>
          </div>
          <p className="text-sm text-[color:var(--ink-dim)]">
            {dailyLimit()} build/render{dailyLimit() === 1 ? "" : "s"} per day.
          </p>
        </Card>
        <Card className="flex flex-col gap-4 p-6">
          <div>
            <Pill tone="accent">Premium</Pill>
            <p className="mt-4 font-[family-name:var(--font-display)] text-3xl font-bold text-[color:var(--ink)]">
              $50<span className="text-base font-normal text-[color:var(--ink-dim)]">/month</span>
            </p>
          </div>
          <p className="text-sm text-[color:var(--ink-dim)]">Unlimited builds and renders.</p>
          {isPremium ? (
            <Pill>You&apos;re on Premium</Pill>
          ) : user ? (
            <UpgradeButton />
          ) : (
            <Link href="/login?next=/pricing" className="text-sm text-[color:var(--accent)] underline">
              Log in to upgrade
            </Link>
          )}
        </Card>
      </div>
    </Container>
  );
}
