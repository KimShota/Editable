import {
  Format,
  ResolvedRole,
  ResolvedRoles,
  SemanticAnchor,
  TakeTrim,
  Transcript,
  TrimPoints,
  Word,
} from "./types";
import { anchoredTimeSec, clamp, concatenateTakesForMatching } from "./timing";
import { matchLiteralAnchor } from "./literal";
import { pickResolver, ResolverChoice } from "./resolvers";
import { RoleResolution, SemanticQuery } from "./resolvers/protocol";

/**
 * Module 5 — Anchor resolution (the brain).
 *
 * Two passes per voice block, cheapest first:
 *   1. LITERAL anchors — fuzzy text matching (no LLM). Near-certain, they
 *      mark block structure and capture the user's own variable words.
 *   2. SEMANTIC anchors — an LLM locates each span, searching only inside
 *      its window. Windows are bounded by the literal spans from pass 1,
 *      which is what makes semantic matching sharply more accurate than
 *      searching the whole transcript.
 *
 * Below the confidence threshold — or when no LLM is available, or the
 * call fails — an anchor degrades gracefully to its config fallback
 * position (span = fallback + fallbackDurationSec). Starts snap to word
 * starts and ends to word ends, so overlays land on word boundaries.
 *
 * All times here are TRIMMED-clip seconds (the trim-then-time rule).
 */

const CONFIDENCE_THRESHOLD = 0.6;

const snapToWordStart = (timeSec: number, words: Word[]): number => {
  if (words.length === 0) return timeSec;
  let best = words[0].startSec;
  for (const w of words) {
    if (Math.abs(w.startSec - timeSec) < Math.abs(best - timeSec)) {
      best = w.startSec;
    }
  }
  return best;
};

/**
 * Block-relative (trimmed-clip) [startSec, endSec) of a multi-take block's
 * own LAST take — a strictly more informed literal-anchor fallback than a
 * fixed blockStart+offsetSec guess whenever one's available. Undefined for
 * an ordinary single-take block (nothing to prefer over the configured
 * fallback there).
 *
 * A multi-take block's takes are already ordered to match the LINE's own
 * reading order — deriveTranscriptAndTrim (splitTake.ts) sorts same-block
 * segments by their source clip's own scriptStartIdx specifically so a
 * concatenated block plays back in the order the words were actually
 * meant to be heard (see its own doc comment) — so the LAST take is
 * exactly the part of the line most likely to hold whatever a trailing
 * marker (a named tool, a captured keyword) is pointing at, independent of
 * how many takes there are or why the block has more than one. A literal
 * anchor's own fallback.offsetSec ("push roughly past the opening words")
 * is already reaching for this same idea with a fixed guess; this is a
 * more accurate version of that same intent whenever real segment
 * boundaries are available to use instead. */
const lastTakeSpan = (takes: TakeTrim[]): { startSec: number; endSec: number } | undefined => {
  if (takes.length <= 1) return undefined;
  const startSec = takes.slice(0, -1).reduce((s, t) => s + (t.srcOutSec - t.srcInSec), 0);
  const last = takes[takes.length - 1];
  return { startSec, endSec: startSec + (last.srcOutSec - last.srcInSec) };
};

const snapToWordEnd = (timeSec: number, words: Word[]): number => {
  if (words.length === 0) return timeSec;
  let best = words[0].endSec;
  for (const w of words) {
    if (Math.abs(w.endSec - timeSec) < Math.abs(best - timeSec)) {
      best = w.endSec;
    }
  }
  return best;
};

export const resolveRoles = async (
  format: Format,
  transcript: Transcript,
  trims: TrimPoints,
  choice: ResolverChoice = "auto",
): Promise<ResolvedRoles> => {
  const resolver = pickResolver(choice);
  const roles: ResolvedRole[] = [];

  for (const block of format.blocks) {
    const anchors = [...block.roles, ...block.anchors];
    if (block.kind !== "voice" || anchors.length === 0) continue;

    const trim = trims.blocks.find((b) => b.blockId === block.id);
    if (!trim) {
      // An `optional` voice block that was never filmed has no trim entry
      // at all (see BlockSchema's doc comment / assemble.ts's matching
      // skip) — nothing to resolve anchors against, and nothing wrong.
      if (block.optional) continue;
      throw new Error(`resolveRoles: no trim points for block "${block.id}"`);
    }

    const rawTakes = transcript.blocks.find((b) => b.blockId === block.id)?.takes ?? [[]];
    // Matching, not the filtered/trimmed word list captions use: a phrase
    // whisper mistimed into a padding/dead-air region trim.ts cut from
    // playback must still be findable (see concatenateTakesForMatching).
    const { words, blockDurationSec } = concatenateTakesForMatching(rawTakes, trim.takes);

    // Pass 1 — literal anchors. Their spans scaffold the semantic windows;
    // a missed match contributes its fallback so windows stay computable.
    const literalSpans = new Map<string, { startSec: number; endSec: number }>();
    for (const anchor of anchors) {
      if (anchor.kind !== "literal") continue;
      const match = words.length > 0 ? matchLiteralAnchor(anchor, words) : null;
      if (match) {
        const span = {
          startSec: clamp(match.startSec, 0, blockDurationSec),
          endSec: clamp(match.endSec, 0, blockDurationSec),
        };
        // A greedy capture (literal.ts's MAX_CAPTURE_WORDS) has no notion
        // of "this is the next block's line" — on a continuous take with no
        // clean pause after the anchor, it can run most of the way through
        // a short block. Not fatal (captions/edges just look off for that
        // anchor), but easy to miss without a flag.
        const capturedWords = match.capturedText ? match.capturedText.split(/\s+/).filter(Boolean).length : 0;
        if (words.length > 0 && capturedWords / words.length > 0.6) {
          console.warn(
            `resolveRoles: anchor "${anchor.id}" in block "${block.id}" captured ${capturedWords}/${words.length} ` +
              `words of the block (${match.quote ?? ""} → ${match.capturedText ?? ""}) — likely ran past the block's own line`,
          );
        }
        literalSpans.set(anchor.id, span);
        roles.push({
          blockId: block.id,
          roleId: anchor.id,
          timeSec: span.startSec,
          endSec: span.endSec,
          captureStartSec:
            match.captureStartSec !== undefined
              ? clamp(match.captureStartSec, 0, blockDurationSec)
              : undefined,
          confidence: clamp(match.confidence, 0, 1),
          source: "literal",
          quote: match.quote,
          capturedText: match.capturedText,
        });
      } else {
        const takeSpan = lastTakeSpan(trim.takes);
        const fb = takeSpan?.startSec ?? anchoredTimeSec(anchor.fallback, blockDurationSec);
        const fbEnd = takeSpan?.endSec ?? fb;
        literalSpans.set(anchor.id, { startSec: fb, endSec: fbEnd });
        roles.push({
          blockId: block.id,
          roleId: anchor.id,
          timeSec: fb,
          endSec: fbEnd,
          // Not a real captured phrase (no text was matched at all) — but
          // when takeSpan is available, [fb, fbEnd) is still a genuine,
          // segment-boundary-derived span worth flagging as "the part
          // that matters" for caption emphasis (assemble.ts's
          // captureSpans) and the "captureStart" overlay-timing edge,
          // same as a real capture would. Left unset for the ordinary
          // single-take case, where a fixed-offset fallback point is no
          // better a signal than blockStart itself.
          captureStartSec: takeSpan ? fb : undefined,
          confidence: 0,
          source: "fallback",
        });
      }
    }

    // Pass 2 — semantic anchors, windowed by the literal spans.
    const semantics = anchors.filter((a): a is SemanticAnchor => a.kind === "semantic");
    const queries = new Map<string, SemanticQuery>();
    for (const anchor of semantics) {
      const after = anchor.window?.afterAnchor
        ? literalSpans.get(anchor.window.afterAnchor)
        : undefined;
      const before = anchor.window?.beforeAnchor
        ? literalSpans.get(anchor.window.beforeAnchor)
        : undefined;
      let windowStartSec = clamp(after?.endSec ?? 0, 0, blockDurationSec);
      let windowEndSec = clamp(before?.startSec ?? blockDurationSec, 0, blockDurationSec);
      if (windowEndSec <= windowStartSec) {
        // Degenerate window (a literal fell back oddly) — search everything.
        windowStartSec = 0;
        windowEndSec = blockDurationSec;
      }
      queries.set(anchor.id, {
        id: anchor.id,
        description: anchor.description,
        form: anchor.form,
        windowStartSec,
        windowEndSec,
      });
    }

    let resolutions: RoleResolution[] = [];
    if (resolver && words.length > 0 && queries.size > 0) {
      try {
        resolutions = await resolver.resolveBlock({
          blockId: block.id,
          anchors: [...queries.values()],
          words,
          blockDurationSec,
        });
      } catch (err) {
        console.warn(
          `resolveRoles: ${resolver.name} failed on block "${block.id}" (${(err as Error).message}) — using fallbacks`,
        );
      }
    }

    for (const anchor of semantics) {
      const query = queries.get(anchor.id)!;
      const hit = resolutions.find((r) => r.roleId === anchor.id);
      if (hit && hit.confidence >= CONFIDENCE_THRESHOLD) {
        const startSec = clamp(
          snapToWordStart(hit.timeSec, words),
          query.windowStartSec,
          query.windowEndSec,
        );
        const endSec = clamp(snapToWordEnd(hit.endSec, words), startSec, blockDurationSec);
        roles.push({
          blockId: block.id,
          roleId: anchor.id,
          timeSec: startSec,
          endSec,
          confidence: clamp(hit.confidence, 0, 1),
          source: "llm",
          quote: hit.quote,
        });
      } else {
        const startSec = anchoredTimeSec(anchor.fallback, blockDurationSec);
        roles.push({
          blockId: block.id,
          roleId: anchor.id,
          timeSec: startSec,
          endSec: clamp(startSec + anchor.fallbackDurationSec, startSec, blockDurationSec),
          confidence: hit ? clamp(hit.confidence, 0, 1) : 0,
          source: "fallback",
        });
      }
    }
  }

  return { resolver: resolver?.name ?? "fallback", roles };
};
