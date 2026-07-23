"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Format } from "@backend/pipeline/types";
import { Button, Card, Pill } from "../../../_components/ui";

type AuthoringStatus =
  | { status: "idle" }
  | { status: "running"; stage: "ingest" | "analyze" | "synthesize"; startedAt: string }
  | { status: "done"; startedAt: string; finishedAt: string }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

type StatusResponse = AuthoringStatus & { draft?: { rationale: string; sourceUrl: string; format: Format } };

const STAGE_LABEL: Record<string, string> = {
  ingest: "Downloading the reel…",
  analyze: "Transcribing and sampling frames…",
  synthesize: "Reverse-engineering the structure (this is the slow one)…",
};

const POLL_MS = 2000;

export function DraftReview({ draftId }: { draftId: string }) {
  const [resp, setResp] = useState<StatusResponse | null>(null);
  const [format, setFormat] = useState<Format | null>(null);
  const [rationale, setRationale] = useState<string>("");
  const initialized = useRef(false);

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
  }, [draftId]);

  if (!resp) return <p className="text-[color:var(--ink-dim)]">Loading…</p>;

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
        <Button variant="secondary" onClick={() => (window.location.href = "/authoring/new")}>
          Try another reel
        </Button>
      </Card>
    );
  }

  if (!format) return <p className="text-[color:var(--ink-dim)]">Loading draft…</p>;

  return <ReviewForm draftId={draftId} format={format} setFormat={setFormat} rationale={rationale} />;
}

function ReviewForm({
  draftId,
  format,
  setFormat,
  rationale,
}: {
  draftId: string;
  format: Format;
  setFormat: (f: Format) => void;
  rationale: string;
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
