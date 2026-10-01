import { type ColorCount, fontsFromCss, countColors, mergeColorCounts, type PageSignals, parsePage } from "./signals";

/**
 * Fetches a brand's website for the intake: the page the customer pasted,
 * a few same-site pages most likely to describe the product, and the
 * stylesheets their colours and fonts live in.
 *
 * Bounded everywhere (pages, bytes, time) because the URL is customer input
 * and this runs on the app server.
 */

export type SiteSignals = {
  pages: PageSignals[];
  /** HTML + stylesheet colours across every fetched page, most frequent first. */
  colors: ColorCount[];
  fonts: string[];
};

export type FetchOptions = {
  /** Extra same-site pages to fetch after the entry page. */
  maxExtraPages?: number;
  maxStylesheets?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const MAX_HTML_BYTES = 3_000_000;
const MAX_CSS_BYTES = 800_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 KatalabIntake/1.0";

/** Pages that describe the product, in preference order; legal and account
 *  pages never do. */
const PRODUCT_HINT = /(product|feature|pricing|price|plan|solution|service|about|how-it-works|app|platform|download|shop|store|collection)/i;
const SKIP_HINT = /(privacy|terms|legal|cookie|login|log-in|signin|sign-in|signup|sign-up|register|account|cart|checkout|careers?|jobs?|press|contact|\.pdf$|\.zip$)/i;

export const assertFetchableUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`intake: "${raw}" is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`intake: only http(s) URLs are supported, got ${url.protocol}`);
  // Customer input fetched from our server: refuse obvious internal targets.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/i.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) || !url.hostname.includes(".")) {
    throw new Error(`intake: refusing to fetch internal host ${url.hostname}`);
  }
  return url;
};

const fetchText = async (url: string, maxBytes: number, opts: Required<Pick<FetchOptions, "timeoutMs">> & { fetchImpl: typeof fetch }): Promise<string | null> => {
  try {
    const res = await opts.fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/css,*/*;q=0.8", "accept-language": "en,ja;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch {
    return null;
  }
};

/** Same-site links worth reading for product facts, best first. */
export const pickExtraPages = (page: PageSignals, max: number): string[] => {
  const entry = new URL(page.url);
  const candidates = page.links
    .filter((l) => !l.external)
    .map((l) => ({ ...l, url: new URL(l.href) }))
    .filter((l) => l.url.pathname !== entry.pathname && !SKIP_HINT.test(l.url.pathname) && !SKIP_HINT.test(l.text))
    // Stay inside the entry page's language prefix (/en/…) when it has one.
    .filter((l) => {
      const prefix = entry.pathname.match(/^\/[a-z]{2}(?:-[a-z]{2})?\//i)?.[0];
      return !prefix || l.url.pathname.startsWith(prefix);
    })
    .map((l) => ({ href: `${l.url.origin}${l.url.pathname}`, score: (PRODUCT_HINT.test(l.url.pathname) ? 2 : 0) + (PRODUCT_HINT.test(l.text) ? 1 : 0) }));
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => (seen.has(c.href) ? false : (seen.add(c.href), true)))
    .slice(0, max)
    .map((c) => c.href);
};

export const fetchSite = async (rawUrl: string, options: FetchOptions = {}): Promise<SiteSignals> => {
  const url = assertFetchableUrl(rawUrl);
  const opts = { timeoutMs: options.timeoutMs ?? 15_000, fetchImpl: options.fetchImpl ?? fetch };

  const entryHtml = await fetchText(url.toString(), MAX_HTML_BYTES, opts);
  if (!entryHtml) throw new Error(`intake: could not fetch ${url} (network error, non-2xx status, or timeout)`);
  const entry = parsePage(entryHtml, url.toString());

  const extraUrls = pickExtraPages(entry, options.maxExtraPages ?? 3);
  const extras = (await Promise.all(extraUrls.map(async (u) => {
    const html = await fetchText(u, MAX_HTML_BYTES, opts);
    return html ? parsePage(html, u) : null;
  }))).filter((p): p is PageSignals => p !== null);
  const pages = [entry, ...extras];

  // Stylesheets are shared across pages on most sites; fetch each once.
  const cssUrls = [...new Set(pages.flatMap((p) => p.stylesheets))].slice(0, options.maxStylesheets ?? 4);
  const css = (await Promise.all(cssUrls.map((u) => fetchText(u, MAX_CSS_BYTES, opts)))).filter((c): c is string => c !== null);

  const fonts: string[] = [];
  for (const f of [...pages.flatMap((p) => p.fonts), ...css.flatMap(fontsFromCss)]) {
    if (!fonts.some((x) => x.toLowerCase() === f.toLowerCase())) fonts.push(f);
  }
  return {
    pages,
    colors: mergeColorCounts([...pages.map((p) => p.colors), ...css.map(countColors)]).slice(0, 24),
    fonts: fonts.slice(0, 16),
  };
};
