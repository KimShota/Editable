export type SelectionTrack = "video" | "overlay" | "sfx" | "transition" | "music" | "captions";

/** For "music" (a single object, not an array) id is the constant below —
 *  there's only ever one, so no real id is needed to address it. */
export const MUSIC_ID = "music";

/** One or more ids, always on the SAME track — a multi-selection only ever
 *  spans one track at a time (select 3 sfx clips together, not a clip plus
 *  an sfx). `ids` is never empty; a single selection is just `ids.length
 *  === 1`, so there's one shape to check everywhere instead of two. */
export type Selection = { track: SelectionTrack; ids: string[] } | null;

export const isSelected = (selection: Selection, track: SelectionTrack, id: string): boolean =>
  selection?.track === track && selection.ids.includes(id);

/** A plain click always replaces the selection with just this one item.
 *  An additive click (Shift held) toggles this id in/out of the CURRENT
 *  selection if it's on the same track — switching tracks always starts a
 *  fresh single-item selection, since a selection only ever spans one
 *  track (see Selection above). Toggling off the last remaining id clears
 *  the selection entirely rather than leaving an empty-but-non-null one. */
export const toggleSelect = (
  current: Selection,
  track: SelectionTrack,
  id: string,
  additive: boolean,
): Selection => {
  if (additive && current?.track === track) {
    const ids = current.ids.includes(id) ? current.ids.filter((i) => i !== id) : [...current.ids, id];
    return ids.length > 0 ? { track, ids } : null;
  }
  return { track, ids: [id] };
};
