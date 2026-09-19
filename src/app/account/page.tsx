import Link from "next/link";
import { getRequestUser } from "../lib/auth";
import { Container, PageHeader, Card, Pill, Button } from "../_components/ui";
import { ManageBillingButton } from "./_components/ManageBillingButton";
import { ResendVerificationButton } from "./_components/ResendVerificationButton";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ verified?: string; verify_error?: string }>;
}) {
  // middleware.ts already requires a session for every non-public route
  // (this one included) — see projects/page.tsx's identical comment.
  const user = await getRequestUser();
  const isPremium = user?.plan === "premium";
  const { verified, verify_error: verifyError } = await searchParams;

  return (
    <Container className="max-w-lg">
      <PageHeader kicker="Katalab" title="Account" />
      {verified && (
        <p className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-700">
          Email verified — your free trial is active.
        </p>
      )}
      {verifyError && (
        <p className="mb-4 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-700">
          {verifyError}
        </p>
      )}
      <Card className="flex flex-col gap-4 p-6">
        <div>
          <p className="text-sm text-[color:var(--ink-dim)]">Email</p>
          <p className="text-[color:var(--ink)]">{user?.email}</p>
        </div>
        <div>
          <p className="mb-2 text-sm text-[color:var(--ink-dim)]">Plan</p>
          <Pill tone={isPremium ? "accent" : "default"}>{isPremium ? "Premium" : "Free"}</Pill>
        </div>
        {user && !user.emailVerifiedAt && (
          <div>
            <p className="mb-2 text-sm text-[color:var(--ink-dim)]">
              Verify your email to start your free trial — check your inbox for the link.
            </p>
            <ResendVerificationButton />
          </div>
        )}
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
