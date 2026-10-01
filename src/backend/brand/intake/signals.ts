/**
 * Pure HTML/CSS → "signals" for the website intake: everything a model
 * needs to draft a brand, measured from the markup instead of guessed.
 * No network here (fetchSite.ts does that), so this is unit-testable on a
 * string.
 *
 * Regex-based on purpose: the intake needs text, links, images, colours and
 * font names, not a DOM, and a parser dependency would buy nothing the
 * extraction model can't absorb (it sees the signals, not a tree).
 */

export type LinkSignal = { href: string; text: string; external: boolean };
export type ImageSignal = { src: string; alt: string };

export type PageSignals = {
  url: string;
  /** <html lang>, e.g. "en", "ja". */
  lang: string | null;
  /** hreflang alternates, e.g. { ja: "https://…/ja/" }. */
  alternates: Record<string, string>;
  title: string | null;
  meta: Record<string, string>;
  headings: string[];
  text: string;
  links: LinkSignal[];
  images: ImageSignal[];
  /** Absolute URLs of linked stylesheets, for fetchSite to pull colours and fonts from. */
  stylesheets: string[];
  icons: string[];
  /** Hex colours with occurrence counts, most frequent first (HTML only;
   *  fetchSite merges the stylesheets' in). */
  colors: ColorCount[];
  fonts: string[];
};

export type ColorCount = { hex: string; count: number };

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©" };

export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** An attribute's value from one tag's source, or null. */
export const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
};

const resolve = (href: string, base: string): string | null => {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

/** Everything a visitor reads: scripts, styles, SVG and comments removed,
 *  block boundaries kept as line breaks so sentences don't run together. */
export const visibleText = (html: string): string => {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|section|article|header|footer|li|h[1-6]|br|tr|main|nav|aside)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .split("\n")
    .map(collapse)
    .filter((line) => line.length > 0)
    .join("\n");
};

const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;

/** "#abc" → "#aabbcc", lower-cased. */
export const normalizeHex = (hex: string): string => {
  const h = hex.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
};

export const countColors = (source: string): ColorCount[] => {
  const counts = new Map<string, number>();
  for (const m of source.match(HEX) ?? []) {
    const hex = normalizeHex(m);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return mergeColorCounts([[...counts].map(([hex, count]) => ({ hex, count }))]);
};

export const mergeColorCounts = (lists: ColorCount[][]): ColorCount[] => {
  const counts = new Map<string, number>();
  for (const list of lists) for (const { hex, count } of list) counts.set(hex, (counts.get(hex) ?? 0) + count);
  return [...counts].map(([hex, count]) => ({ hex, count })).sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
};

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "inherit", "initial", "unset", "emoji", "math", "-apple-system", "blinkmacsystemfont"]);

/** OS fallback fonts that appear in almost every stylesheet's font stack
 *  (Tailwind's defaults among them). They say nothing about the brand. */
const SYSTEM_FALLBACKS = new Set(["segoe ui", "roboto", "helvetica neue", "helvetica", "arial", "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji", "sfmono-regular", "menlo", "monaco", "consolas", "liberation mono", "courier new", "ubuntu", "cantarell", "oxygen", "fira sans", "droid sans", "open sans"]);

/** Font family names from CSS `font-family` declarations and `@font-face`
 *  rules. CSS variables, generic families and OS fallbacks are dropped. */
export const fontsFromCss = (css: string): string[] => {
  const out: string[] = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/\s*!important\s*$/, "").trim().replace(/^["'\s]+|["')\s]+$/g, "");
      if (!name || name.startsWith("var(") || GENERIC_FAMILIES.has(name.toLowerCase()) || SYSTEM_FALLBACKS.has(name.toLowerCase())) continue;
      out.push(name);
    }
  }
  return uniqueInOrder(out);
};

/** next/font leaves the family in the class name ("geist_f06fb53f-module__…",
 *  "noto_sans_jp_5f3f25df-module__…"); Google Fonts links carry it in
 *  `family=`. Both are hints, humanized ("noto_sans_jp" → "Noto Sans JP"). */
export const fontsFromHtml = (html: string): string[] => {
  const out: string[] = [];
  for (const m of html.matchAll(/\b([a-z][a-z0-9_]*?)_[0-9a-f]{8}-module__/g)) out.push(humanizeFont(m[1]));
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/g)) {
    for (const fam of decodeEntities(m[1]).matchAll(/family=([^&:]+)/g)) out.push(decodeURIComponent(fam[1]).replace(/\+/g, " "));
  }
  return uniqueInOrder(out);
};

const humanizeFont = (slug: string): string =>
  slug
    .split("_")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

const uniqueInOrder = (items: string[]): string[] => {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const MAX_TEXT_CHARS = 20_000;
const MAX_LINKS = 80;
const MAX_IMAGES = 40;

export const parsePage = (html: string, url: string): PageSignals => {
  const host = new URL(url).host;
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";

  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    const content = attr(tag, "content");
    if (key && content) meta[key.toLowerCase()] = content;
  }

  const alternates: Record<string, string> = {};
  const stylesheets: string[] = [];
  const icons: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = attr(tag, "href");
    const abs = href ? resolve(href, url) : null;
    if (!abs) continue;
    if (rel === "alternate" && attr(tag, "hreflang")) alternates[attr(tag, "hreflang")!.toLowerCase()] = abs;
    else if (rel === "stylesheet") stylesheets.push(abs);
    else if (rel.includes("icon")) icons.push(abs);
  }

  const links: LinkSignal[] = [];
  const seenLinks = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, "href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    const abs = resolve(href, url);
    if (!abs || seenLinks.has(abs)) continue;
    seenLinks.add(abs);
    links.push({ href: abs, text: collapse(decodeEntities(m[2].replace(/<[^>]+>/g, " "))).slice(0, 120), external: new URL(abs).host !== host });
    if (links.length >= MAX_LINKS) break;
  }

  const images: ImageSignal[] = [];
  const seenImages = new Set<string>();
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = attr(tag, "src");
    const abs = src && !src.startsWith("data:") ? resolve(src, url) : null;
    if (!abs || seenImages.has(abs)) continue;
    seenImages.add(abs);
    images.push({ src: abs, alt: attr(tag, "alt") ?? "" });
    if (images.length >= MAX_IMAGES) break;
  }
  const ogImage = meta["og:image"] ? resolve(meta["og:image"], url) : null;
  if (ogImage && !seenImages.has(ogImage)) images.unshift({ src: ogImage, alt: "og:image" });

  const headings = [...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => collapse(decodeEntities(m[1].replace(/<[^>]+>/g, " "))))
    .filter((h) => h.length > 0)
    .slice(0, 40);

  const inlineCss = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).join(";");
  // theme-color is the site's own declaration of its brand colour: weighted
  // above a single incidental use in the markup.
  const themeHex = meta["theme-color"]?.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/i)?.[0];
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];

  return {
    url,
    lang: attr(htmlTag, "lang"),
    alternates,
    title: title ? collapse(decodeEntities(title)) : null,
    meta,
    headings,
    text: visibleText(html).slice(0, MAX_TEXT_CHARS),
    links,
    images,
    stylesheets,
    icons,
    colors: mergeColorCounts([countColors(inlineCss), themeHex ? [{ hex: normalizeHex(themeHex), count: 5 }] : []]),
    fonts: uniqueInOrder([...fontsFromHtml(html), ...fontsFromCss(inlineCss)]),
  };
};
