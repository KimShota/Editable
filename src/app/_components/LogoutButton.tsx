"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-full border border-white/12 px-4 py-2 font-[family-name:var(--font-display)] text-[13px] tracking-wide text-[color:var(--ink-dim)] transition-colors hover:border-white/30 hover:text-[color:var(--ink)] disabled:opacity-40"
    >
      {busy ? "Logging out…" : "Log out"}
    </button>
  );
}
