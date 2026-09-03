import { isCjkChar, splitIntoUnits } from "@backend/components/cjk";

/** Per-character rise-in reveal for the templates page's own H1 text — pure
 *  CSS (see globals.css's `.tg-anim-ch` keyframes), no client JS: the delay
 *  stagger is baked into each span's inline style at render time, so this
 *  stays a server component like the rest of this page. Renders no heading
 *  element itself — the caller (PageHeader) still owns the single real
 *  <h1>; a screen reader gets the plain string via the sr-only span rather
 *  than reading through dozens of single-letter spans. Word spans keep
 *  literal (unwrapped) space text nodes between them so the title still
 *  wraps normally on narrow screens — an inline-block span containing only
 *  a space would NOT give the browser a line-break opportunity there
 *  (skipped next to a CJK unit — see splitIntoUnits — since Japanese/
 *  Chinese text is never actually space-separated in the first place). */
export function AnimatedTitle({ text }: { text: string }) {
  let charIndex = 0;
  const words = splitIntoUnits(text);

  return (
    <>
      <span aria-hidden="true">
        {words
          .map((word, wi) => (
            <span key={wi} className="inline-block">
              {[...word].map((ch, ci) => {
                const delay = charIndex * 0.035;
                charIndex++;
                return (
                  <span key={ci} className="tg-anim-ch" style={{ animationDelay: `${delay}s` }}>
                    {ch}
                  </span>
                );
              })}
            </span>
          ))
          .flatMap((el, i) => {
            if (i === 0) return [el];
            const needsSpace = !isCjkChar(words[i - 1]) && !isCjkChar(words[i]);
            return needsSpace ? [" ", el] : [el];
          })}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}
