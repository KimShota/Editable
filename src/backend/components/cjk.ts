/**
 * Japanese/Chinese text has no spaces between words, so anything here that
 * assumed ASCII-whitespace splitting gives real "words" — text wrapping
 * (textFit.ts, style.ts), title-splitting (TextOverlay.tsx,
 * AnimatedTitle.tsx), caption-edit re-timing (Inspector.tsx), and
 * script/transcript alignment (pipeline/tokenize.ts) — needs one shared
 * answer for "is this character CJK" and "how do I break this text into
 * breakable units", so a Japanese sentence with no whitespace doesn't get
 * treated as a single unbreakable/unalignable blob everywhere it's split.
 * Ranges: Hiragana, Katakana, CJK Unified Ideographs (+ Extension A), CJK
 * Compatibility Ideographs — ordinary Japanese text (and most Chinese)
 * without reaching into rarer supplementary-plane ideographs.
 */
const CJK_RANGE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export const isCjkChar = (ch: string): boolean => CJK_RANGE.test(ch);

export const containsCjk = (text: string): boolean => CJK_RANGE.test(text);

/** Splits text into breakable units: an ordinary whitespace-delimited run
 *  of non-CJK characters is one unit (same as an English "word"); each CJK
 *  character becomes its OWN unit, since Japanese/Chinese text can legally
 *  break between any two characters and has no spaces to split on in the
 *  first place. Whitespace itself is never emitted as a unit. */
export const splitIntoUnits = (text: string): string[] => {
  const units: string[] = [];
  let current = "";
  for (const ch of Array.from(text)) {
    if (isCjkChar(ch)) {
      if (current) {
        units.push(current);
        current = "";
      }
      units.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        units.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) units.push(current);
  return units;
};

/** Rejoins units from splitIntoUnits back into displayable text — a space
 *  between two ordinary (non-CJK) units, same as the original text's own
 *  whitespace; no space next to a CJK unit, since Japanese/Chinese text is
 *  never actually space-separated in the first place. */
export const joinUnits = (units: string[]): string =>
  units.reduce((acc, unit, i) => {
    if (i === 0) return unit;
    const needsSpace = !isCjkChar(units[i - 1]) && !isCjkChar(unit);
    return acc + (needsSpace ? " " : "") + unit;
  }, "");
