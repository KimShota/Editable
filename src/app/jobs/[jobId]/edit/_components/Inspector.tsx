"use client";

import { useEffect, useState } from "react";
import type { Edl, EdlCaptionGroup } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { Selection } from "./selection";
import { CloseIcon, ScissorsIcon, TrashIcon } from "./Icons";
import {
  FONT_FAMILY_SHORTHANDS,
  FONT_OPTIONS,
  KUMAR_RED,
  TEXT_VARIANTS,
  TextVariant,
  defaultLowerThirdColor,
  defaultLowerThirdFontSize,
  defaultLowerThirdFontWeight,
  fitDidoneFontSize,
} from "@backend/components/style";

const TRANSITIONS = [
  { value: "cut", label: "Cut" },
  { value: "fade", label: "Fade" },
  { value: "whooshZoom", label: "Whoosh zoom" },
];

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] tracking-wide text-[color:var(--ed-ink-dim)] uppercase">{label}</label>
    {children}
  </div>
);

const inputClass =
  "w-full rounded-lg border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-raised)] px-2.5 py-1.5 text-sm text-[color:var(--ed-ink)] outline-none focus:border-[color:var(--ed-accent)]";

const secondaryButtonClass =
  "flex items-center justify-center gap-2 rounded-lg border border-[color:var(--ed-border-strong)] px-3 py-2 text-sm text-[color:var(--ed-ink)] transition-colors hover:border-[color:var(--ed-accent)]/50 hover:bg-[color:var(--ed-raised)] disabled:pointer-events-none disabled:opacity-30";

const dangerButtonClass =
  "flex items-center justify-center gap-2 rounded-lg border border-[color:var(--ed-danger)]/30 px-3 py-2 text-sm text-[color:var(--ed-danger)] transition-colors hover:bg-[color:var(--ed-danger)]/10 disabled:pointer-events-none disabled:opacity-30";

const sectionClass = "flex flex-col gap-4 overflow-y-auto p-4";
const actionsClass = "mt-2 flex flex-col gap-2 border-t border-[color:var(--ed-border)] pt-4";

const toggleButtonClass = (active: boolean) =>
  `flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-semibold transition-colors ${
    active
      ? "border-[color:var(--ed-accent)] bg-[color:var(--ed-accent)]/15 text-[color:var(--ed-accent)]"
      : "border-[color:var(--ed-border-strong)] text-[color:var(--ed-ink)] hover:border-[color:var(--ed-accent)]/50"
  }`;

/** Everything a TextOverlay event or a caption group might carry as an
 *  explicit style override — see TextOverlay.tsx's props / EdlCaptionGroupSchema.
 *  Absent field = following the component's own default for that field.
 *  A patch may set `null` for a field to DELETE the override (see
 *  timelineOps.ts's applySetProp) — used by "Reset to template style". */
type TextStyleOverride = {
  fontSize?: number | null;
  fontFamily?: string | null;
  color?: string | null;
  fontWeight?: number | null;
  italic?: boolean | null;
  underline?: boolean | null;
  textCase?: "upper" | "lower" | "none" | null;
};

/** The effective values TextStyleFields shows when the override above
 *  doesn't set a given field — i.e. what's ACTUALLY rendering right now
 *  (the variant/theme's own house style), computed by the caller since
 *  overlay vs. caption defaults come from different places (see
 *  effectiveOverlayDefaults / effectiveCaptionDefaults below). */
type TextStyleDefaults = { fontSize: number; fontFamily: string; color: string; fontWeight: number };

/**
 * Font/size/bold/underline/italic/case/color controls shared by a
 * TextOverlay event and a caption group — "captions and text are the
 * same thing" — the caller supplies the current override + resolved
 * defaults and wraps the emitted patch into whatever shape its own track
 * needs (overlay: nested under `params`; captions: top-level fields).
 *
 * A field is written explicitly on every interaction and DELETED (patch
 * value `null`) only via "Reset to template style" — there's no
 * per-field reset control, matching how position reset already works
 * (Inspector's caption Position section, one button for the whole group).
 */
function TextStyleFields({
  override,
  defaults,
  onPatch,
  onResetAll,
}: {
  override: TextStyleOverride;
  defaults: TextStyleDefaults;
  onPatch: (patch: TextStyleOverride) => void;
  onResetAll: () => void;
}) {
  const fontSize = override.fontSize ?? defaults.fontSize;
  const [liveFontSize, setLiveFontSize] = useState(fontSize);
  useEffect(() => setLiveFontSize(fontSize), [fontSize]);

  const fontFamily = override.fontFamily ?? defaults.fontFamily;
  const color = override.color ?? defaults.color;
  const isBold = (override.fontWeight ?? defaults.fontWeight) >= 700;
  const isOverridden =
    override.fontSize !== undefined ||
    override.fontFamily !== undefined ||
    override.color !== undefined ||
    override.fontWeight !== undefined ||
    override.italic !== undefined ||
    override.underline !== undefined ||
    override.textCase !== undefined;

  const commitFontSize = (value: number) => onPatch({ fontSize: Math.max(8, Math.round(value)) });

  return (
    <>
      <Field label="Font">
        <select value={fontFamily} onChange={(e) => onPatch({ fontFamily: e.target.value })} className={inputClass}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label={`Font size — ${liveFontSize}px`}>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={12}
            max={200}
            step={1}
            value={liveFontSize}
            onChange={(e) => setLiveFontSize(Number(e.target.value))}
            onMouseUp={(e) => commitFontSize(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitFontSize(Number((e.target as HTMLInputElement).value))}
            className="w-full accent-[color:var(--ed-accent)]"
          />
          <input
            type="number"
            min={8}
            max={400}
            value={liveFontSize}
            onChange={(e) => setLiveFontSize(Number(e.target.value))}
            onBlur={(e) => commitFontSize(Number(e.target.value))}
            className="w-16 rounded-lg border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-raised)] px-2 py-1 text-sm text-[color:var(--ed-ink)] outline-none focus:border-[color:var(--ed-accent)]"
          />
        </div>
      </Field>

      <Field label="Style">
        <div className="flex gap-1.5">
          <button
            title="Bold"
            onClick={() => onPatch({ fontWeight: isBold ? 400 : 800 })}
            className={toggleButtonClass(isBold)}
          >
            B
          </button>
          <button
            title="Underline"
            onClick={() => onPatch({ underline: !override.underline })}
            className={`${toggleButtonClass(!!override.underline)} underline`}
          >
            U
          </button>
          <button
            title="Italic"
            onClick={() => onPatch({ italic: !override.italic })}
            className={`${toggleButtonClass(!!override.italic)} italic`}
          >
            I
          </button>
        </div>
      </Field>

      <Field label="Case">
        <div className="flex gap-1.5">
          <button title="UPPERCASE" onClick={() => onPatch({ textCase: "upper" })} className={toggleButtonClass(override.textCase === "upper")}>
            TT
          </button>
          <button title="lowercase" onClick={() => onPatch({ textCase: "lower" })} className={toggleButtonClass(override.textCase === "lower")}>
            tt
          </button>
          <button title="As typed" onClick={() => onPatch({ textCase: "none" })} className={toggleButtonClass(override.textCase === "none")}>
            Tt
          </button>
        </div>
      </Field>

      <Field label="Color">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#ffffff"}
            onChange={(e) => onPatch({ color: e.target.value })}
            className="h-8 w-12 cursor-pointer rounded-md border border-[color:var(--ed-border-strong)] bg-transparent p-0.5"
          />
          <span className="text-xs text-[color:var(--ed-ink-dim)]">{color}</span>
        </div>
      </Field>

      <button disabled={!isOverridden} onClick={onResetAll} className={secondaryButtonClass}>
        Reset to template style
      </button>
    </>
  );
}

/** A TextOverlay event's own effective style — its params override, or the
 *  variant's house default (see TEXT_VARIANTS) for whatever it doesn't set.
 *  A variant's own fontFamily (only kumarTitle sets one) is a raw CSS
 *  stack, not a Font-dropdown shorthand key — reverse-looked-up against
 *  FONT_FAMILY_SHORTHANDS so the dropdown shows "Playfair Display"
 *  selected instead of falling back to "System". */
const effectiveOverlayDefaults = (params: Record<string, unknown>): TextStyleDefaults => {
  const variant = (typeof params.variant === "string" ? params.variant : "hook") as TextVariant;
  const v = TEXT_VARIANTS[variant] ?? TEXT_VARIANTS.hook;
  const familyKey = v.fontFamily ? Object.entries(FONT_FAMILY_SHORTHANDS).find(([, stack]) => stack === v.fontFamily)?.[0] : undefined;
  return { fontSize: v.fontSize, fontFamily: familyKey ?? "system", color: v.color, fontWeight: v.fontWeight };
};

/** A caption group's own effective style — mirrors Captions.tsx's own
 *  fallback formulas exactly (see style.ts's defaultLowerThird* helpers
 *  and BigTitleCard's fitDidoneFontSize call) so the panel shows what's
 *  actually rendering, not a guess. */
const effectiveCaptionDefaults = (group: EdlCaptionGroup, edl: Edl): TextStyleDefaults =>
  group.variant === "bigTitle"
    ? { fontSize: fitDidoneFontSize(group.words[0]?.text ?? "", edl.width, edl.height), fontFamily: "playfair", color: KUMAR_RED, fontWeight: 900 }
    : {
        fontSize: defaultLowerThirdFontSize(group.theme),
        fontFamily: "system",
        color: defaultLowerThirdColor(group.theme),
        fontWeight: defaultLowerThirdFontWeight(group.theme),
      };

/** Word-count-preserving edit → each word keeps its original timing (the
 *  precise "fix a mis-transcription" case, e.g. "cloak coats" -> "Claude
 *  Codes"); a different word count → best-effort, spread evenly across the
 *  group's existing time span rather than refusing the edit outright. */
const wordsFromEditedText = (
  editedText: string,
  original: { text: string; tlStartSec: number; tlEndSec: number }[],
  tlInSec: number,
  tlOutSec: number,
): { text: string; tlStartSec: number; tlEndSec: number }[] | null => {
  const tokens = editedText.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length === original.length) {
    return original.map((w, i) => ({ ...w, text: tokens[i] }));
  }
  const span = tlOutSec - tlInSec;
  const perWord = span / tokens.length;
  return tokens.map((text, i) => ({
    text,
    tlStartSec: tlInSec + i * perWord,
    tlEndSec: tlInSec + (i + 1) * perWord,
  }));
};

export function Inspector({
  edl,
  selection,
  currentTimeSec,
  onOp,
  onDeselect,
}: {
  edl: Edl;
  selection: Selection;
  currentTimeSec: number;
  onOp: (op: TimelineOp) => void;
  onDeselect: () => void;
}) {
  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-[color:var(--ed-ink-dim)]">Select a clip on the timeline to edit it.</p>
      </div>
    );
  }

  const header = (title: string, subtitle?: string) => (
    <div className="flex items-center justify-between border-b border-[color:var(--ed-border)] p-4">
      <div className="min-w-0">
        <p className="truncate font-[family-name:var(--ed-font-display)] text-sm font-semibold text-[color:var(--ed-ink)]">
          {title}
        </p>
        {subtitle && <p className="truncate text-xs text-[color:var(--ed-ink-dim)]">{subtitle}</p>}
      </div>
      <button
        onClick={onDeselect}
        className="flex h-6 w-6 items-center justify-center rounded-md text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)]"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  // A multi-selection shows a generic bulk panel instead of any per-type
  // detail — move-together already happens by dragging any one of them on
  // the timeline, and split deliberately stays single-item-only (see
  // Timeline.tsx), so bulk delete is the one action that belongs here.
  if (selection.ids.length > 1) {
    const track = selection.track;
    const isBulkDeletable = (t: typeof track): t is "video" | "overlay" | "sfx" | "captions" =>
      t === "video" || t === "overlay" || t === "sfx" || t === "captions";
    const trackLabel =
      track === "video"
        ? "clips"
        : track === "overlay"
          ? "overlays"
          : track === "sfx"
            ? "sound effects"
            : track === "captions"
              ? "caption groups"
              : "items";
    const canDelete = isBulkDeletable(track) && !(track === "video" && edl.video.length - selection.ids.length <= 0);
    return (
      <div className="flex h-full flex-col">
        {header(`${selection.ids.length} ${trackLabel} selected`, "Drag any one to move them all together")}
        <div className={sectionClass}>
          <div className={actionsClass}>
            <button
              disabled={!canDelete}
              onClick={() => isBulkDeletable(track) && onOp({ type: "deleteMany", track, ids: selection.ids })}
              className={dangerButtonClass}
            >
              <TrashIcon className="h-4 w-4" />
              Delete {selection.ids.length} {trackLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const id = selection.ids[0];

  if (selection.track === "video") {
    const clip = edl.video.find((v) => v.id === id);
    if (!clip) return null;
    const isLast = edl.video[edl.video.length - 1].id === clip.id;
    const transition = edl.transitions.find((t) => t.afterClipId === clip.id);
    const canSplit = currentTimeSec > clip.tlInSec + 0.1 && currentTimeSec < clip.tlOutSec - 0.1;

    return (
      <div className="flex h-full flex-col">
        {header("Video clip", clip.blockId)}
        <div className={sectionClass}>
          <Field label="Timeline position">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
              {clip.tlInSec.toFixed(2)}s – {clip.tlOutSec.toFixed(2)}s
              <span className="text-[color:var(--ed-ink-dim)]"> ({(clip.tlOutSec - clip.tlInSec).toFixed(2)}s)</span>
            </p>
          </Field>
          <Field label="Source range">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
              {clip.srcInSec.toFixed(2)}s – {clip.srcOutSec.toFixed(2)}s
              {clip.srcDurationSec !== undefined && (
                <span className="text-[color:var(--ed-ink-dim)]"> of {clip.srcDurationSec.toFixed(2)}s source</span>
              )}
            </p>
          </Field>
          <label className="flex items-center gap-2 text-sm text-[color:var(--ed-ink)]">
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) =>
                onOp({ type: "setProp", track: "video", id: clip.id, patch: { muted: e.target.checked } })
              }
              className="accent-[color:var(--ed-accent)]"
            />
            Muted
          </label>
          <Field label={`Volume — ${Math.round(clip.volume * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              defaultValue={clip.volume}
              disabled={clip.muted}
              onChange={(e) =>
                onOp({ type: "setProp", track: "video", id: clip.id, patch: { volume: Number(e.target.value) } })
              }
              className="w-full accent-[color:var(--ed-accent)] disabled:opacity-40"
            />
          </Field>

          {!isLast && (
            <Field label="Transition after this clip">
              <select
                value={transition?.component ?? "cut"}
                onChange={(e) =>
                  onOp({ type: "setProp", track: "transition", id: clip.id, patch: { component: e.target.value } })
                }
                className={inputClass}
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className={actionsClass}>
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "video", id: clip.id, atSec: currentTimeSec })}
              className={secondaryButtonClass}
            >
              <ScissorsIcon className="h-4 w-4" />
              Split at playhead
            </button>
            <button
              disabled={edl.video.length <= 1}
              onClick={() => onOp({ type: "delete", track: "video", id: clip.id })}
              className={dangerButtonClass}
            >
              <TrashIcon className="h-4 w-4" />
              Delete clip
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "overlay") {
    const clip = edl.overlays.find((o) => o.id === id);
    if (!clip) return null;
    const canSplit = currentTimeSec > clip.tlInSec + 0.1 && currentTimeSec < clip.tlOutSec - 0.1;
    const hasText = typeof clip.params.text === "string";
    const isTextOverlay = clip.component === "TextOverlay";
    const patchTextStyle = (patch: TextStyleOverride) =>
      onOp({ type: "setProp", track: "overlay", id: clip.id, patch: { params: patch } });

    return (
      <div className="flex h-full flex-col">
        {header("Overlay", clip.component)}
        <div className={sectionClass}>
          <Field label="Timeline position">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
              {clip.tlInSec.toFixed(2)}s – {clip.tlOutSec.toFixed(2)}s
            </p>
          </Field>
          {hasText && (
            <Field label="Text">
              <textarea
                defaultValue={clip.params.text as string}
                onBlur={(e) =>
                  onOp({
                    type: "setProp",
                    track: "overlay",
                    id: clip.id,
                    patch: { params: { text: e.target.value } },
                  })
                }
                rows={3}
                className={inputClass}
              />
            </Field>
          )}
          {isTextOverlay && (
            <TextStyleFields
              override={clip.params as TextStyleOverride}
              defaults={effectiveOverlayDefaults(clip.params)}
              onPatch={patchTextStyle}
              onResetAll={() =>
                patchTextStyle({
                  fontSize: null,
                  fontFamily: null,
                  color: null,
                  fontWeight: null,
                  italic: null,
                  underline: null,
                  textCase: null,
                })
              }
            />
          )}
          <div className={actionsClass}>
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "overlay", id: clip.id, atSec: currentTimeSec })}
              className={secondaryButtonClass}
            >
              <ScissorsIcon className="h-4 w-4" />
              Split at playhead
            </button>
            <button onClick={() => onOp({ type: "delete", track: "overlay", id: clip.id })} className={dangerButtonClass}>
              <TrashIcon className="h-4 w-4" />
              Delete overlay
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "sfx") {
    const clip = edl.sfx.find((s) => s.id === id);
    if (!clip) return null;
    return (
      <div className="flex h-full flex-col">
        {header("Sound effect", clip.src.split("/").pop())}
        <div className={sectionClass}>
          <Field label={`Volume — ${Math.round(clip.volume * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              defaultValue={clip.volume}
              onChange={(e) =>
                onOp({ type: "setProp", track: "sfx", id: clip.id, patch: { volume: Number(e.target.value) } })
              }
              className="w-full accent-[color:var(--ed-accent)]"
            />
          </Field>
          <div className={actionsClass}>
            <button onClick={() => onOp({ type: "delete", track: "sfx", id: clip.id })} className={dangerButtonClass}>
              <TrashIcon className="h-4 w-4" />
              Delete sound effect
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "transition") {
    const t = edl.transitions.find((t) => t.afterClipId === id);
    if (!t) return null;
    return (
      <div className="flex h-full flex-col">
        {header("Transition", `at ${t.atSec.toFixed(2)}s`)}
        <div className={sectionClass}>
          <Field label="Style">
            <select
              value={t.component}
              onChange={(e) =>
                onOp({
                  type: "setProp",
                  track: "transition",
                  id,
                  patch: { component: e.target.value },
                })
              }
              className={inputClass}
            >
              {TRANSITIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Duration — ${t.durationSec.toFixed(2)}s`}>
            <input
              type="range"
              min={0.05}
              max={1.5}
              step={0.05}
              defaultValue={t.durationSec}
              onChange={(e) =>
                onOp({
                  type: "setProp",
                  track: "transition",
                  id,
                  patch: { durationSec: Number(e.target.value) },
                })
              }
              className="w-full accent-[color:var(--ed-accent)]"
            />
          </Field>
          <p className="text-xs text-[color:var(--ed-ink-dim)]">
            Drag the transition on the timeline to snap it onto a different cut, or drag its right edge to
            change how long it plays. It also moves automatically when you trim or reorder the clip next to it.
          </p>
          <div className={actionsClass}>
            <button onClick={() => onOp({ type: "delete", track: "transition", id })} className={dangerButtonClass}>
              <TrashIcon className="h-4 w-4" />
              Delete transition
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "music") {
    const music = edl.music.find((m) => m.id === id);
    if (!music) return null;
    const durationSec = music.durationSec ?? edl.durationSec - music.tlInSec;
    return (
      <div className="flex h-full flex-col">
        {header("Music", music.src.split("/").pop())}
        <div className={sectionClass}>
          <Field label="Timeline window">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
              {music.tlInSec.toFixed(2)}s – {(music.tlInSec + durationSec).toFixed(2)}s
              <span className="text-[color:var(--ed-ink-dim)]"> ({durationSec.toFixed(2)}s)</span>
            </p>
          </Field>
          <Field label={`Volume — ${Math.round(music.volume * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              defaultValue={music.volume}
              onChange={(e) =>
                onOp({ type: "setProp", track: "music", id: music.id, patch: { volume: Number(e.target.value) } })
              }
              className="w-full accent-[color:var(--ed-accent)]"
            />
          </Field>
          <div className={actionsClass}>
            <button onClick={() => onOp({ type: "delete", track: "music", id: music.id })} className={dangerButtonClass}>
              <TrashIcon className="h-4 w-4" />
              Delete music
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "captions") {
    const group = edl.captions.find((c) => c.id === id);
    if (!group) return null;
    // A split always lands on a word boundary (see applySplit), so the only
    // group that genuinely can't be split is a one-word one — the playhead's
    // exact position no longer decides it.
    const canSplit = group.words.length >= 2;
    const isPositioned = group.x !== undefined && group.y !== undefined;
    const patchCaptionStyle = (patch: TextStyleOverride) => onOp({ type: "setProp", track: "captions", id: group.id, patch });
    return (
      <div className="flex h-full flex-col">
        {header("Caption group", `${group.tlInSec.toFixed(2)}s – ${group.tlOutSec.toFixed(2)}s`)}
        <div className={sectionClass}>
          <Field label="Text (auto-transcribed — fix a misheard word freely)">
            <textarea
              defaultValue={group.words.map((w) => w.text).join(" ")}
              onBlur={(e) => {
                const words = wordsFromEditedText(e.target.value, group.words, group.tlInSec, group.tlOutSec);
                if (!words) {
                  e.target.value = group.words.map((w) => w.text).join(" ");
                  return;
                }
                onOp({ type: "setProp", track: "captions", id: group.id, patch: { words } });
              }}
              rows={3}
              className={inputClass}
            />
          </Field>
          <p className="text-xs text-[color:var(--ed-ink-dim)]">
            Keeping the same number of words keeps each word&apos;s original timing (best for fixing a
            mis-transcription). Adding or removing words spreads the new text evenly across the group&apos;s span
            instead.
          </p>
          {/* "Captions and text are the same thing" — same font/size/style
              controls a TextOverlay event gets, just reading/writing the
              caption group's own top-level fields instead of `params`.
              karaokeTitle isn't wired up here yet — see KaraokeTitleLayer.tsx,
              which doesn't even support the move/position editing every
              other variant already has. */}
          {group.variant !== "karaokeTitle" && (
            <TextStyleFields
              override={group as TextStyleOverride}
              defaults={effectiveCaptionDefaults(group, edl)}
              onPatch={patchCaptionStyle}
              onResetAll={() =>
                patchCaptionStyle({
                  fontSize: null,
                  fontFamily: null,
                  color: null,
                  fontWeight: null,
                  italic: null,
                  underline: null,
                  textCase: null,
                })
              }
            />
          )}
          <Field label="Position">
            <p className="text-xs text-[color:var(--ed-ink-dim)]">
              {isPositioned
                ? `Moved by hand to ${(group.x! * 100).toFixed(0)}%, ${(group.y! * 100).toFixed(0)}% of the frame. Drag it on the preview to adjust.`
                : "Placed automatically by this caption's style. Drag it on the preview to put it exactly where you want."}
            </p>
          </Field>
          <div className={actionsClass}>
            <button
              disabled={!isPositioned}
              onClick={() => onOp({ type: "setProp", track: "captions", id: group.id, patch: { x: null, y: null } })}
              className={secondaryButtonClass}
            >
              Reset position
            </button>
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "captions", id: group.id, atSec: currentTimeSec })}
              className={secondaryButtonClass}
            >
              <ScissorsIcon className="h-4 w-4" />
              Split at nearest word
            </button>
            <button
              onClick={() => onOp({ type: "delete", track: "captions", id: group.id })}
              className={dangerButtonClass}
            >
              <TrashIcon className="h-4 w-4" />
              Delete caption group
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
