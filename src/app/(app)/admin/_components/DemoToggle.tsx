"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";
import { Button } from "../../../_components/ui";

/** Turns demo mode on or off for this browser (a cookie the founder owns). */
export function DemoToggle({ on }: { on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = async () => {
    setBusy(true);
    setError(null);
    const res = await sendJson("/api/admin/demo", { on: !on });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button onClick={flip} disabled={busy} variant={on ? "secondary" : "primary"}>
        {busy ? "Working" : on ? "Turn demo mode off" : "Turn demo mode on"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-[color:var(--st-bad-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}
