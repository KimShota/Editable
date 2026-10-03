"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";

const quiet = "rounded-full border border-[color:var(--card-border)] px-4 py-2 text-sm font-medium text-[color:var(--ink)] transition-colors hover:border-[color:var(--ink)] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]";

type Msg = { tone: "ok" | "bad"; text: string } | null;

/** The founder's tools for one brand: add a member by email, cancel a pending
 *  invitation, and tell the members their plan is ready. */
export function BrandAdminActions({ slug, brandName, pending, canAnnounce }: { slug: string; brandName: string; pending: string[]; canAnnounce: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("add");
    setMsg(null);
    const res = await sendJson<{ status: string; emailed: boolean; emailError: string | null }>(`/api/admin/brands/${slug}/members`, { email });
    setBusy(null);
    if (!res.ok) return setMsg({ tone: "bad", text: res.error });
    const { status, emailed, emailError } = res.data;
    setEmail("");
    setMsg(
      status === "added"
        ? { tone: "ok", text: "Added. They can already see the brand." }
        : status === "already_member"
          ? { tone: "ok", text: "They are already a member." }
          : emailError
            ? { tone: "bad", text: `Invited, but the email failed (${emailError}). Tell them to sign up with this address.` }
            : { tone: "ok", text: emailed ? "Invited. We emailed them a link to sign up." : "Invited." },
    );
    router.refresh();
  };

  const cancel = async (address: string) => {
    setBusy(address);
    setMsg(null);
    const res = await sendJson(`/api/admin/brands/${slug}/members`, { email: address }, "DELETE");
    setBusy(null);
    if (!res.ok) return setMsg({ tone: "bad", text: res.error });
    router.refresh();
  };

  const announce = async () => {
    setBusy("announce");
    setMsg(null);
    const res = await sendJson<{ sent: number; emailError: string | null }>(`/api/admin/brands/${slug}/plan-ready`, {});
    setBusy(null);
    if (!res.ok) return setMsg({ tone: "bad", text: res.error });
    setMsg({ tone: res.data.emailError ? "bad" : "ok", text: `${res.data.sent} email${res.data.sent === 1 ? "" : "s"} sent${res.data.emailError ? `, but one failed: ${res.data.emailError}` : ""}.` });
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={`add-${slug}`} className="mb-1.5 block text-sm font-medium text-[color:var(--ink)]">Add someone to {brandName}</label>
          <input id={`add-${slug}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className="w-full rounded-lg border border-[color:var(--card-border)] bg-[color:var(--bg-2)] px-4 py-2.5 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]" />
        </div>
        <button type="submit" className={quiet} disabled={busy !== null || !email.trim()}>{busy === "add" ? "Adding" : "Add"}</button>
      </form>

      {pending.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm" aria-label="Pending invitations">
          {pending.map((p) => (
            <li key={p} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[color:var(--ink-dim)]">{p} (invited)</span>
              <button type="button" onClick={() => cancel(p)} disabled={busy !== null} aria-label={`Cancel the invitation to ${p}`} className="text-[13px] font-medium text-[color:var(--ink-dim)] underline-offset-4 hover:text-[color:var(--st-bad-fg)] hover:underline disabled:opacity-40">Cancel</button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <button type="button" onClick={announce} className={quiet} disabled={busy !== null || !canAnnounce}>{busy === "announce" ? "Sending" : "Email: your plan is ready"}</button>
        {!canAnnounce && <p className="mt-1.5 text-[13px] text-[color:var(--ink-dim)]">Available once the brand has a plan.</p>}
      </div>

      {msg && <p role={msg.tone === "bad" ? "alert" : "status"} className={`text-sm ${msg.tone === "bad" ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>{msg.text}</p>}
    </div>
  );
}
