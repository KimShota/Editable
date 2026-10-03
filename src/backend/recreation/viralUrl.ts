/**
 * Which links a customer may paste as "a viral video to recreate". yt-dlp
 * will fetch almost any URL, including addresses inside our network, so the
 * allow-list is the only thing standing between a pasted link and a request
 * from our server to somewhere it should not go. Checked at the API and again
 * in the job (the payload is just data in the queue).
 */

const HOSTS: { host: RegExp; path: RegExp }[] = [
  { host: /^(www\.)?instagram\.com$/, path: /^\/(reel|reels|p)\/[\w-]+\/?$/ },
  { host: /^(www\.|vm\.|m\.)?tiktok\.com$/, path: /^\/(@[\w.-]+\/video\/\d+|[\w-]+\/?)$/ },
  { host: /^(www\.|m\.)?youtube\.com$/, path: /^\/shorts\/[\w-]+\/?$/ },
  { host: /^youtu\.be$/, path: /^\/[\w-]+\/?$/ },
];

export class ViralUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViralUrlError";
  }
}

/** The cleaned URL (no query or fragment, https), or a ViralUrlError saying
 *  what to paste instead. */
export const parseViralUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ViralUrlError("That does not look like a link.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ViralUrlError("Paste a web link (https://…).");
  if (url.username || url.password) throw new ViralUrlError("That link has a login in it.");
  if (url.port && url.port !== "443" && url.port !== "80") throw new ViralUrlError("That link points to an unusual port.");
  const rule = HOSTS.find((h) => h.host.test(url.hostname.toLowerCase()));
  if (!rule || !rule.path.test(url.pathname)) {
    throw new ViralUrlError("Paste a link to an Instagram reel, a TikTok video or a YouTube Short.");
  }
  return `https://${url.hostname.toLowerCase()}${url.pathname}`;
};
