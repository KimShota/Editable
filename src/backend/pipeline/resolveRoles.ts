import {
  Format,
  ResolvedRole,
  ResolvedRoles,
  SemanticAnchor,
  Transcript,
  TrimPoints,
  Word,
} from "./types";
import { anchoredTimeSec, clamp, concatenateTakes } from "./timing";
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
    if (!trim) throw new Error(`resolveRoles: no trim points for block "${block.id}"`);

    const rawTakes = transcript.blocks.find((b) => b.blockId === block.id)?.takes ?? [[]];
    const { words, blockDurationSec } = concatenateTakes(rawTakes, trim.takes);

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
        const fb = anchoredTimeSec(anchor.fallback, blockDurationSec);
        literalSpans.set(anchor.id, { startSec: fb, endSec: fb });
        roles.push({
          blockId: block.id,
          roleId: anchor.id,
          timeSec: fb,
          endSec: fb,
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
