"use client";

import { useEffect, useState } from "react";

const KEY = "katalab.autopost-banner.dismissed";

/** Tells the customer posting for them is not available yet, once. Dismissal
 *  is a per-browser convenience (localStorage may be blocked or empty, so
 *  every access is guarded and the banner simply shows again). */
export function AutoPostBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY) !== "1") setShow(true);
    } catch {
      setShow(true);
    }
  }, []);
  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      // Not remembered: it will show again next time, which is harmless.
    }
  };

  return (
    <div role="note" className="mb-6 flex items-start justify-between gap-4 rounded-xl bg-[color:var(--bg-2)] px-4 py-3 text-sm text-[color:var(--ink)]">
      <p className="max-w-[65ch]">
        Posting to TikTok, Instagram and YouTube for you is coming soon. Until then, download each video from here and post it yourself.
      </p>
      <button type="button" onClick={dismiss} aria-label="Dismiss this message" className="shrink-0 rounded-full px-2 py-0.5 text-sm font-medium text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]">
        Dismiss
      </button>
    </div>
  );
}
