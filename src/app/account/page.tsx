import Link from "next/link";
import { getRequestUser } from "../lib/auth";
import { Container, PageHeader, Card, Pill, Button } from "../_components/ui";
import { ManageBillingButton } from "./_components/ManageBillingButton";

export default async function AccountPage() {
  // middleware.ts already requires a session for every non-public route
  // (this one included) — see projects/page.tsx's identical comment.
  const user = await getRequestUser();
  const isPremium = user?.plan === "premium";

  return (
    <Container className="max-w-lg">
      <PageHeader kicker="Katalab" title="Account" />
      <Card className="flex flex-col gap-4 p-6">
        <div>
          <p className="text-sm text-[color:var(--ink-dim)]">Email</p>
          <p className="text-[color:var(--ink)]">{user?.email}</p>
        </div>
        <div>
          <p className="mb-2 text-sm text-[color:var(--ink-dim)]">Plan</p>
          <Pill tone={isPremium ? "accent" : "default"}>{isPremium ? "Premium" : "Free"}</Pill>
        </div>
        {isPremium ? (
          <ManageBillingButton />
        ) : (
          <Link href="/pricing">
            <Button>Upgrade to Premium</Button>
          </Link>
        )}
      </Card>
    </Container>
  );
}
