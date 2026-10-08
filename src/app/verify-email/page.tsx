import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Container, PageHeader } from "../_components/ui";
import { LogoutButton } from "../_components/LogoutButton";
import { getRequestUser } from "../lib/auth";
import { ResendEmail } from "./_components/ResendEmail";

/**
 * Where an account waits until its email is confirmed. The request proxy sends
 * every signed-in, unconfirmed account here and nowhere else (proxy.ts). Someone
 * who is already confirmed has no reason to be here, so they go on to the app.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const verifyError = (await searchParams).verify_error;
  const user = await getRequestUser();
  if (user && (user.isAdmin || user.emailVerifiedAt)) redirect("/calendar");

  return (
    <Container className="max-w-md">
      <PageHeader kicker="Katalab" title="Check your inbox" />
      <Card className="flex flex-col gap-5 p-6">
        {typeof verifyError === "string" && verifyError && (
          <p role="alert" className="rounded-xl border border-[color:var(--st-bad-fg)]/30 bg-[color:var(--st-bad-bg)] px-4 py-3 text-sm text-[color:var(--st-bad-fg)]">
            {verifyError}
          </p>
        )}
        <p className="text-sm text-[color:var(--ink)]">
          We sent a confirmation link to <strong>{user?.email ?? "your email"}</strong>. Open it to start using Katalab. The link works for 24 hours.
        </p>
        <p className="text-sm text-[color:var(--ink-dim)]">Nothing there? Look in spam, or send it again.</p>
        <ResendEmail />
        <Link href="/calendar" className="text-sm text-[color:var(--accent)] hover:underline">
          I have confirmed my email
        </Link>
      </Card>
      <div className="mt-4 flex justify-center">
        <LogoutButton />
      </div>
    </Container>
  );
}
