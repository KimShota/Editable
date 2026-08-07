"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Format } from "@backend/pipeline/types";
import type { VerifyResult } from "@backend/authoring/types";
import { Button, Card, Pill } from "../../../_components/ui";

type AuthoringStatus =
  | { status: "idle" }
  | { status: "running"; stage: "ingest" | "analyze" | "synthesize" | "verify"; startedAt: string }
  | { status: "done"; startedAt: string; finishedAt: string }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

type VerifyMedia = { sourceUrl: string | null; renderUrl: string | null };

type StatusResponse = AuthoringStatus & {
  draft?: { rationale: string; sourceUrl: string; format: Format };
  verify?: VerifyResult;
  verifyMedia?: VerifyMedia;
};

const STAGE_LABEL: Record<string, string> = {
  ingest: "Downloading the reel…",
  analyze: "Transcribing and sampling frames…",
  synthesize: "Reverse-engineering the structure (this is the slow one)…",
  verify: "Self-checking the draft against the reference (rendering + comparing)…",
};

const POLL_MS = 2000;

export function DraftReview({ draftId }: { draftId: string }) {
  const [resp, setResp] = useState<StatusResponse | null>(null);
  const [format, setFormat] = useState<Format | null>(null);
  const [rationale, setRationale] = useState<string>("");
  const initialized = useRef(false);
  // Bumped by "Run verify" to re-enter the poll loop below — the loop's own
  // setTimeout chain stops for good once a run reaches done/error, so
  // without this a verify triggered from the button would spawn its child
  // process but the UI would never notice it finished.
  const [pollNonce, setPollNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const res = await fetch(`/api/authoring/${draftId}`);
      const data: StatusResponse = await res.json();
      if (cancelled) return;
      setResp(data);
      if (data.draft && !initialized.current) {
        initialized.current = true;
        setFormat(data.draft.format);
        setRationale(data.draft.rationale);
      }
      if (data.status === "running") {
        setTimeout(poll, POLL_MS);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [draftId, pollNonce]);

  if (!resp) return <p className="text-[color:var(--ink-dim)]">Loading…</p>;

  // Full-page states only apply before a draft format exists at all — once
  // the review form is up, a later "running"/"error" status (from a
  // re-verify) is shown INLINE in VerifyCard instead of replacing the page
  // the reviewer is actively editing.
  if (!format) {
    if (resp.status === "running") {
      return (
        <Card className="flex items-center gap-3 p-6">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[color:var(--accent)]" />
          <p className="text-sm text-[color:var(--ink)]">{STAGE_LABEL[resp.stage] ?? "Working…"}</p>
        </Card>
      );
    }
    if (resp.status === "error") {
      return (
        <Card className="p-6">
          <p className="mb-2 text-sm font-medium text-red-400">Authoring failed</p>
          <pre className="mb-4 max-h-64 overflow-auto rounded-lg bg-black/30 p-3 text-xs whitespace-pre-wrap text-[color:var(--ink-dim)]">
            {resp.error}
          </pre>
          <Button variant="secondary" onClick={() => (window.location.href = "/reverse-engineer")}>
            Try another reel
          </Button>
        </Card>
      );
    }
    return <p className="text-[color:var(--ink-dim)]">Loading draft…</p>;
  }

  return (
    <ReviewForm
      draftId={draftId}
      format={format}
      setFormat={setFormat}
      rationale={rationale}
      verify={resp.verify}
      verifyMedia={resp.verifyMedia}
      verifyRunning={resp.status === "running"}
      verifyError={resp.status === "error" ? resp.error : undefined}
      onRunVerify={() => setPollNonce((n) => n + 1)}
    />
  );
}

function ReviewForm({
  draftId,
  format,
  setFormat,
  rationale,
  verify,
  verifyMedia,
  verifyRunning,
  verifyError,
  onRunVerify,
}: {
  draftId: string;
  format: Format;
  setFormat: (f: Format) => void;
  rationale: string;
  verify?: VerifyResult;
  verifyMedia?: VerifyMedia;
  verifyRunning: boolean;
  verifyError?: string;
  onRunVerify: () => void;
}) {
  const router = useRouter();
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState(() => JSON.stringify(format, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const patchField = <K extends "id" | "name" | "niche" | "description">(key: K, value: Format[K]) => {
    const next = { ...format, [key]: value };
    setFormat(next);
    setRawText(JSON.stringify(next, null, 2));
  };

  const patchSlotInstructions = (blockId: string, slotName: string, value: string) => {
    const next: Format = {
      ...format,
      blocks: format.blocks.map((b) =>
        b.id !== blockId
          ? b
          : { ...b, slots: b.slots.map((s) => (s.name !== slotName ? s : { ...s, instructions: value })) },
      ),
    };
    setFormat(next);
    setRawText(JSON.stringify(next, null, 2));
  };

  const applyRawText = () => {
    try {
      const parsed = JSON.parse(rawText);
      setFormat(parsed);
      setRawError(null);
    } catch (err) {
      setRawError((err as Error).message);
    }
  };

  const runVerify = async () => {
    await fetch(`/api/authoring/${draftId}/verify`, { method: "POST" });
    onRunVerify();
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/authoring/${draftId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(format),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "save failed");
      router.push(`/templates/${data.formatId}`);
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <p className="mb-1 text-[11px] tracking-[0.2em] text-[color:var(--accent)] uppercase">What we found</p>
        <p className="text-sm leading-relaxed text-[color:var(--ink-dim)]">{rationale}</p>
      </Card>

      <VerifyCard
        verify={verify}
        verifyMedia={verifyMedia}
        running={verifyRunning}
        error={verifyError}
        onRunVerify={runVerify}
      />

      <Card className="flex flex-col gap-4 p-6">
        <Field label="Format id (kebab-case, must be unique)" value={format.id} onChange={(v) => patchField("id", v)} />
        <Field label="Name" value={format.name} onChange={(v) => patchField("name", v)} />
        <Field label="Niche" value={format.niche} onChange={(v) => patchField("niche", v)} />
        <div>
          <label className="mb-1 block text-xs font-medium text-[color:var(--ink-dim)]">Description</label>
          <textarea
            value={format.description}
            onChange={(e) => patchField("description", e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-white/12 bg-black/20 px-3 py-2 text-sm text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]"
          />
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        {format.blocks.map((block) => (
          <Card key={block.id} className="p-6">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                {block.title}
              </h3>
              <Pill>{block.kind === "voice" ? "spoken" : "b-roll"}</Pill>
              {block.captions && <Pill>captions</Pill>}
            </div>

            <div className="flex flex-col gap-3">
              {block.slots.map((slot) => (
                <div key={slot.name}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs font-medium text-[color:var(--ink)]">{slot.name}</span>
                    <span className="text-[11px] text-[color:var(--ink-dim)]">
                      {slot.mediaType}
                      {!slot.required && ", optional"}
                    </span>
                  </div>
                  <textarea
                    value={slot.instructions}
                    onChange={(e) => patchSlotInstructions(block.id, slot.name, e.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-[color:var(--ink-dim)] outline-none focus:border-[color:var(--accent)]"
                  />
                </div>
              ))}
            </div>

            {block.anchors.length > 0 && (
              <div className="mt-4 border-t border-white/10 pt-3">
                <p className="mb-2 text-[11px] tracking-wide text-[color:var(--ink-faint)] uppercase">
                  Anchors (edit via raw JSON below)
                </p>
                <ul className="flex flex-col gap-1">
                  {block.anchors.map((a) => (
                    <li key={a.id} className="text-xs text-[color:var(--ink-dim)]">
                      <span className="font-mono text-[color:var(--ink)]">{a.id}</span>
                      {" — "}
                      {a.kind === "literal"
                        ? `says "${a.phrases[0]}"${a.capture ? " (captures what follows)" : ""}`
                        : a.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {block.events.length > 0 && (
              <div className="mt-3">
                <p className="mb-2 text-[11px] tracking-wide text-[color:var(--ink-faint)] uppercase">Events</p>
                <ul className="flex flex-col gap-1">
                  {block.events.map((ev) => (
                    <li key={ev.id} className="text-xs text-[color:var(--ink-dim)]">
                      <span className="font-mono text-[color:var(--ink)]">{ev.id}</span> — {ev.kind} ·{" "}
                      {ev.component.component}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        ))}
      </div>

      <Card className="p-6">
        <button
          onClick={() => setShowRaw((v) => !v)}
          className="text-sm font-medium text-[color:var(--accent)]"
        >
          {showRaw ? "Hide" : "Show"} advanced: edit raw JSON
        </button>
        {showRaw && (
          <div className="mt-3">
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              onBlur={applyRawText}
              rows={16}
              spellCheck={false}
              className="w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-[color:var(--ink-dim)] outline-none focus:border-[color:var(--accent)]"
            />
            {rawError && <p className="mt-2 text-xs text-red-400">Invalid JSON: {rawError}</p>}
          </div>
        )}
      </Card>

      <div className="sticky bottom-6 z-10 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[color:var(--bg)]/90 p-5 backdrop-blur-md">
        <div>
          <p className="text-sm text-[color:var(--ink)]">
            {format.blocks.length} blocks · saves as <span className="font-mono">formats/{format.id}.json</span>
          </p>
          {saveError && <p className="text-xs text-red-400">{saveError}</p>}
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save to library"}
        </Button>
      </div>
    </div>
  );
}

/** Shows the self-verification score (see verify.ts) — a render of the
 *  draft against the reference clip's OWN footage, frame-compared back
 *  against the reference itself. This is a measured signal, not a
 *  pass/fail gate: no threshold is asserted here (see verify.ts's own doc
 *  comment on why one isn't hardcoded yet) — the reviewer reads the score
 *  and per-block breakdown and decides whether to trust the draft, without
 *  needing to manually reposition/resize/retime anything themselves. */
/** blockId keyed only by whether ssim was actually measured — a block
 *  that splitTake couldn't locate in the reference is SKIPPED, not scored
 *  zero, so overallScore is a minimum over however many blocks happened to
 *  match this run. Surfacing "measured N/M" next to the score is what
 *  makes that legible: a high score over few measured blocks (an anchor
 *  regression hiding as a good number) reads very differently from the
 *  same score over all of them. */
function measuredCount(verify: VerifyResult): { measured: number; total: number } {
  return { measured: verify.blocks.filter((b) => b.ssim !== undefined).length, total: verify.blocks.length };
}

function VerifyCard({
  verify,
  verifyMedia,
  running,
  error,
  onRunVerify,
}: {
  verify?: VerifyResult;
  verifyMedia?: VerifyMedia;
  running: boolean;
  error?: string;
  onRunVerify: () => void;
}) {
  const counts = verify ? measuredCount(verify) : undefined;

  return (
    <Card className="p-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[11px] tracking-[0.2em] text-[color:var(--accent)] uppercase">Self-verification</p>
        {verify?.overallScore !== undefined && <Pill>min SSIM {verify.overallScore.toFixed(3)}</Pill>}
        {counts && <Pill tone={counts.measured < counts.total ? "accent" : "default"}>{`measured ${counts.measured}/${counts.total}`}</Pill>}
        <div className="ml-auto">
          <Button variant="secondary" onClick={onRunVerify} disabled={running}>
            {running ? "Verifying…" : verify ? "Re-run verify" : "Run verify"}
          </Button>
        </div>
      </div>
      <p className="mb-3 text-xs text-[color:var(--ink-dim)]">
        Renders this draft using the reference reel&apos;s own footage as the &quot;user&quot;, then compares it back
        against the reference frame-by-frame — a check that the choreography (positions, timing, reveals) actually
        reproduces, not just a human eyeballing it. Re-verifying checks the saved draft as synthesized; edits below
        aren&apos;t reflected until you save.
      </p>

      {running && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 p-3">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[color:var(--accent)]" />
          <p className="text-xs text-[color:var(--ink)]">Rendering + comparing — this takes a few minutes.</p>
        </div>
      )}
      {!running && error && (
        <div className="mb-3 rounded-lg border border-red-400/30 bg-red-400/10 p-3">
          <p className="text-xs font-medium text-red-400">Last verify run failed</p>
          <pre className="mt-1 max-h-40 overflow-auto text-[11px] whitespace-pre-wrap text-red-300/80">{error}</pre>
        </div>
      )}

      {!running && verifyMedia && (verifyMedia.sourceUrl || verifyMedia.renderUrl) && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] tracking-wide text-[color:var(--ink-faint)] uppercase">Original reel</p>
            {verifyMedia.sourceUrl ? (
              <video controls playsInline className="w-full rounded-lg bg-black" src={verifyMedia.sourceUrl} />
            ) : (
              <div className="flex aspect-9/16 items-center justify-center rounded-lg border border-white/10 bg-black/20 p-3 text-center text-xs text-[color:var(--ink-faint)]">
                Reference reel not found on disk
              </div>
            )}
          </div>
          <div>
            <p className="mb-1 text-[11px] tracking-wide text-[color:var(--ink-faint)] uppercase">Recreation</p>
            {verifyMedia.renderUrl ? (
              <video controls playsInline className="w-full rounded-lg bg-black" src={verifyMedia.renderUrl} />
            ) : (
              <div className="flex aspect-9/16 items-center justify-center rounded-lg border border-white/10 bg-black/20 p-3 text-center text-xs text-[color:var(--ink-faint)]">
                Not yet rendered — run verify above
              </div>
            )}
          </div>
        </div>
      )}

      {verify ? (
        <>
          <ul className="flex flex-col gap-1">
            {verify.blocks.map((b) => (
              <li key={b.blockId} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-[color:var(--ink)]">{b.blockId}</span>
                {b.ssim !== undefined ? (
                  <span className="text-[color:var(--ink-dim)]">ssim {b.ssim.toFixed(3)}</span>
                ) : (
                  <span className="text-[color:var(--ink-faint)]">skipped — {b.skipped}</span>
                )}
              </li>
            ))}
          </ul>
          {verify.diagnostics.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-[color:var(--ink-dim)]">
                {verify.diagnostics.length} diagnostic{verify.diagnostics.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {verify.diagnostics.map((d, i) => (
                  <li key={i} className="text-[11px] text-[color:var(--ink-faint)]">
                    {d}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        !running && <p className="text-xs text-[color:var(--ink-faint)]">Not yet verified.</p>
      )}
    </Card>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[color:var(--ink-dim)]">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/12 bg-black/20 px-3 py-2 text-sm text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]"
      />
    </div>
  );
}
