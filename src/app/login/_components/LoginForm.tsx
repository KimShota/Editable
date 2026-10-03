"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "../../_components/ui";

const inputClass =
  "w-full rounded-lg border border-[color:var(--card-border)] bg-[color:var(--bg-2)] px-4 py-3 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]";

/** Where to go after signing in: the page the proxy bounced the user from
 *  (`?next=`), else the calendar. Only same-site absolute paths are honoured,
 *  so a crafted link can't send someone to another origin. Read at submit
 *  time, not render, so it needs no Suspense boundary. */
const destinationAfterLogin = (): string => {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/calendar";
};

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "login failed");
      router.push(destinationAfterLogin());
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="login-email" className="mb-2 block text-sm font-medium text-[color:var(--ink)]">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@somewhere.com"
            className={inputClass}
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor="login-password" className="mb-2 block text-sm font-medium text-[color:var(--ink)]">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={inputClass}
            disabled={busy}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? "Logging in…" : "Log in"}
        </Button>
      </form>
    </Card>
  );
}
