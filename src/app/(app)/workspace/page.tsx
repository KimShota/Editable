import type { Metadata } from "next";
import Link from "next/link";
import { listPendingInvites } from "@backend/brand/members";
import { getActiveBrand } from "../../lib/activeBrand";
import { getRequestUser } from "../../lib/auth";
import { brandRepo } from "../../lib/brandRepo";
import { query } from "../../lib/db";
import { Container, EmptyState, PageHeader, Pill } from "../../_components/ui";
import { ManageBillingButton } from "./_components/ManageBillingButton";
import { ResendVerificationButton } from "./_components/ResendVerificationButton";

export const metadata: Metadata = { title: "Workspace · Katalab" };

/**
 * Your account, your workspace and who is in it (plan/ui-ux-full-flow.md §7).
 * This is the old Account page, moved: email verification and billing work as
 * before, and an email-verification link still lands here.
 */
export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ verified?: string; verify_error?: string; upgraded?: string }> }) {
  const user = (await getRequestUser())!;
  const { verified, verify_error: verifyError, upgraded } = await searchParams;
  const premium = user.plan === "premium";
  const { active } = await getActiveBrand(user);
  const workspace = active ? await brandRepo.getWorkspace(active.slug) : null;
  const members = active ? await brandRepo.listMembers(active.slug) : [];
  const pending = workspace && user.isAdmin ? await listPendingInvites(query, workspace.id) : [];

  return (
    <Container className="max-w-3xl">
      <PageHeader kicker={workspace?.name} title="Workspace" />

      {verified && <p role="status" className="mb-6 rounded-xl bg-[color:var(--st-ready-bg)] px-4 py-3 text-sm text-[color:var(--st-ready-fg)]">Email verified. Your account is active.</p>}
      {upgraded && <p role="status" className="mb-6 rounded-xl bg-[color:var(--st-ready-bg)] px-4 py-3 text-sm text-[color:var(--st-ready-fg)]">Thank you. Your upgrade is being set up and appears here shortly.</p>}
      {verifyError && <p role="alert" className="mb-6 rounded-xl bg-[color:var(--st-bad-bg)] px-4 py-3 text-sm text-[color:var(--st-bad-fg)]">{verifyError}</p>}

      <section aria-labelledby="account-title" className="mb-10 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-6">
        <h2 id="account-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Your account</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-[color:var(--ink-dim)]">Email</dt>
            <dd className="mt-0.5 text-[color:var(--ink)]" data-testid="account-email">{user.email}</dd>
          </div>
          <div>
            <dt className="mb-1 text-sm text-[color:var(--ink-dim)]">Plan</dt>
            <dd><Pill tone={premium ? "accent" : "default"}>{premium ? "Premium" : "Free"}</Pill></dd>
          </div>
        </dl>
        {!user.emailVerifiedAt && !user.isAdmin && (
          <div className="mt-5">
            <p className="mb-2 text-sm text-[color:var(--ink-dim)]">Verify your email to finish setting up. Check your inbox for the link.</p>
            <ResendVerificationButton />
          </div>
        )}
        <div className="mt-5">
          {premium ? (
            <ManageBillingButton />
          ) : (
            <Link href="/pricing" className="inline-flex rounded-full bg-[color:var(--ink)] px-6 py-3 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]">
              See plans
            </Link>
          )}
        </div>
      </section>

      {!workspace ? (
        <EmptyState title="Your workspace is being set up">We are getting your brand ready.</EmptyState>
      ) : (
        <>
          <section aria-labelledby="members-title" className="mb-10">
            <h2 id="members-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Members of {workspace.name}</h2>
            <ul className="mt-3 flex flex-col divide-y divide-[color:var(--card-border)] rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]" aria-label="Members">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0 truncate text-[color:var(--ink)]">{m.email}</span>
                  {m.email.toLowerCase() === user.email.toLowerCase() && <span className="text-[13px] text-[color:var(--ink-dim)]">You</span>}
                </li>
              ))}
              {pending.map((p) => (
                <li key={p.email} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0 truncate text-[color:var(--ink-dim)]">{p.email}</span>
                  <span className="text-[13px] text-[color:var(--ink-dim)]">Invited</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-[color:var(--ink-dim)]">Everyone here can review and approve videos. During the pilot, Katalab adds new members for you: just ask.</p>
          </section>

          <section aria-labelledby="credits-title">
            <h2 id="credits-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">New versions</h2>
            <p className="mt-2 max-w-[65ch] text-[15px] text-[color:var(--ink-dim)]">Asking for a new take of a video is included while we run the pilot. Packs of extra versions come later.</p>
          </section>
        </>
      )}
    </Container>
  );
}
