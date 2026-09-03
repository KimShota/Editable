import { splitIntoUnits } from "../components/cjk";

/**
 * Word tokenizer shared by every script/transcript matching stage
 * (alignToScript's Needleman-Wunsch, prepareTake/splitTake's take
 * ordering and marker backdating, literal.ts's marker matching) — replaces
 * the plain `text.split(/\s+/)` every one of those used to do. Ordinary
 * text still splits on whitespace, one "word" per token; Japanese/Chinese
 * text has no spaces between words, so a CJK run splits one CHARACTER per
 * token instead — the granularity these edit-distance algorithms can
 * actually work with, and close to how Whisper itself segments
 * Japanese/Chinese speech. Deliberately does NOT lowercase or strip
 * punctuation — callers that need that (see normalizedWords below) do it
 * as their own separate step, same as before, so e.g. a corrected caption
 * still gets the script's OWN casing substituted in, not a normalized one.
 */
export const tokenizeWords = splitIntoUnits;

const normalizeToken = (raw: string): string => raw.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Lowercased, punctuation-stripped word list — the "scriptWordsOf" helper
 *  prepareTake.ts and splitTake.ts each used to hand-duplicate, unified
 *  here. Unicode-aware (`\p{L}\p{N}`, not `a-z0-9`) so Japanese text
 *  survives the strip instead of being deleted outright. */
export const normalizedWords = (text: string): string[] =>
  tokenizeWords(text)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
