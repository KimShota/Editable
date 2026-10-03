/**
 * The storage-key layout of one brand (`storage/brands/<slug>/…`), in one
 * place. The CLIs (character, recreate, produce) and the app's `brandRepo`
 * all name files through these functions, so the UI and the CLIs can never
 * disagree about where something lives (plan/ui-ux-full-flow.md §2.1).
 *
 * Pure: no I/O, so it is safe to import from CLIs, route handlers and
 * checks alike. Keys are validated again by `storage.ts`'s assertValidKey
 * when they are used.
 *
 * `cardId` and `sourceId` are both "ids a script/storyboard/video is keyed
 * by". Before the plan model existed a script was keyed by its source id;
 * a card's id defaults to its source id so those files keep working
 * (plan/ui-ux-full-flow.md §2.2).
 */

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const assertBrandSlug = (slug: string, what = "brand slug"): string => {
  if (!SLUG.test(slug)) throw new Error(`${what} must be a lowercase slug (a-z, 0-9, -), got "${slug}"`);
  return slug;
};

export const isBrandSlug = (slug: unknown): slug is string => typeof slug === "string" && SLUG.test(slug);

const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const assertCardId = (id: string): string => {
  if (!CARD_ID.test(id)) throw new Error(`card id must be letters, digits, "-" or "_", got "${id}"`);
  return id;
};

export const brandRoot = (slug: string): string => `brands/${assertBrandSlug(slug)}`;

/** Files that belong to the brand as a whole. */
export const brandKeys = (slug: string) => {
  const root = brandRoot(slug);
  return {
    root,
    intake: `${root}/intake.json`,
    plan: `${root}/plan.json`,
    niche: `${root}/niche.json`,
    footage: `${root}/product/footage.json`,
    productDir: `${root}/product`,
    productAsset: (name: string) => `${root}/product/${name}`,
  };
};

/** Mascot/character design and the locked voice (character/cli.ts). */
export const characterKeys = (slug: string) => {
  const root = brandRoot(slug);
  return {
    intake: `${root}/intake.json`,
    concepts: `${root}/character/concepts.json`,
    candidate: (name: string) => {
      if (!/^c\d+-[vr]\d+$/.test(name)) throw new Error(`candidate names look like c1-v0 or c1-r2, got "${name}"`);
      return `${root}/character/candidates/${name}.png`;
    },
    candidatesDir: `${root}/character/candidates`,
    candidatesGrid: `${root}/character/candidates-grid.png`,
    sheetView: (view: string) => `${root}/character/sheet/${view}.png`,
    sheetGrid: `${root}/character/sheet-grid.png`,
    character: `${root}/character/character.json`,
    voicePreviews: `${root}/character/voice/previews.json`,
    voicePreview: (name: string) => `${root}/character/voice/${name}.mp3`,
    voiceSample: `${root}/character/voice/sample.mp3`,
  };
};

/** Viral sources, their specs, and per-card scripts/storyboards
 *  (recreation/cli.ts). */
export const recreationKeys = (slug: string) => {
  const root = brandRoot(slug);
  const sources = `${root}/sources`;
  return {
    root: sources,
    video: (id: string) => `${sources}/${id}.mp4`,
    info: (id: string) => `${sources}/${id}.info.json`,
    /** A contact sheet of the source's frames, the plan card's thumbnail. */
    sheet: (id: string) => `${sources}/${id}-sheet.jpg`,
    analysis: (id: string) => `${sources}/analysis/${id}.json`,
    keyframe: (id: string, shot: number, k: number) => `${sources}/keyframes/${id}/s${shot}-${k}.jpg`,
    spec: (id: string) => `${sources}/specs/${id}.json`,
    script: (cardId: string) => `${root}/scripts/${cardId}.json`,
    intake: `${root}/intake.json`,
    character: `${root}/character/character.json`,
    footage: `${root}/product/footage.json`,
    board: (cardId: string) => `${root}/storyboards/${cardId}`,
  };
};

/** One produced video (production/cli.ts). `take` mints a new unique take
 *  name each call, which is why it is injected: the CLI owns the stamp
 *  counter so every take stays its own immutable file. */
export const productionKeys = (slug: string, cardId: string, take: () => number = () => Date.now()) => {
  const root = `${brandRoot(slug)}/videos/${assertCardId(cardId)}`;
  return {
    root,
    tts: (i: number) => `${root}/voice/line-${i}.tts.mp3`,
    ttsWords: (i: number) => `${root}/voice/line-${i}.tts.json`,
    line: (i: number) => `${root}/voice/line-${i}.mp3`,
    lineWords: (i: number) => `${root}/voice/line-${i}.json`,
    track: `${root}/voice/track.wav`,
    timeline: `${root}/timeline.json`,
    green: (shot: string) => `${root}/stills/${shot}-green.png`,
    raw: (shot: string) => `${root}/clips/${shot}.raw.mp4`,
    request: (shot: string) => `${root}/clips/${shot}.request.json`,
    clip: (shot: string) => `${root}/clips/${shot}.mp4`,
    take: (shot: string) => `${root}/clips/${shot}.v${take()}.mp4`,
    clips: `${root}/clips.json`,
    costs: `${root}/costs.jsonl`,
    edl: `${root}/edl.json`,
    final: `${root}/final.mp4`,
    still: (shot: string) => `${brandRoot(slug)}/storyboards/${cardId}/${shot}.png`,
    /** UI-owned: caption, hashtags, posted URLs (plan §2.2). */
    post: `${root}/post.json`,
  };
};

/** The editor job id for a card's video: what `produce render` publishes
 *  under jobs/ (format "ai-video"). */
export const videoJobId = (slug: string, cardId: string): string => `${assertBrandSlug(slug)}-${assertCardId(cardId)}`;

/** Inverse of videoJobId for a known brand slug, or null if `jobId` isn't
 *  that brand's. Slugs may contain "-", so the brand is matched as a prefix
 *  against the known slugs rather than split on the first "-". */
export const parseVideoJobId = (jobId: string, knownSlugs: readonly string[]): { slug: string; cardId: string } | null => {
  const sorted = [...knownSlugs].sort((a, b) => b.length - a.length);
  for (const slug of sorted) {
    if (jobId.startsWith(`${slug}-`)) {
      const cardId = jobId.slice(slug.length + 1);
      if (CARD_ID.test(cardId)) return { slug, cardId };
    }
  }
  return null;
};
