export type SelectionTrack = "video" | "overlay" | "sfx" | "transition" | "music" | "captions";

/** For "music" (a single object, not an array) id is the constant below —
 *  there's only ever one, so no real id is needed to address it. */
export const MUSIC_ID = "music";

export type Selection = { track: SelectionTrack; id: string } | null;
