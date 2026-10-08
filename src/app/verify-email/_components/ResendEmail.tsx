"use client";

import { useState } from "react";
import { Button } from "../../_components/ui";
import { sendJson } from "../../lib/clientApi";

/** Sends the confirmation email again. Without this, someone whose first email
 *  was lost could never get in: login refuses an unconfirmed account too. */
export function ResendEmail() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await sendJson("/api/auth/resend-verification", {});
    setBusy(false);
    if (res.ok) setNotice("Sent. The new link replaces the old one.");
    else setError(res.error);
  };

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={onClick} disabled={busy}>
        {busy ? "Sending…" : "Send the email again"}
      </Button>
      {notice && <p role="status" className="text-sm text-[color:var(--ink-dim)]">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
