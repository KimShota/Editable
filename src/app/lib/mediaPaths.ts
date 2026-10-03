/**
 * Path-segment checks for /api/media/<root>/…, shared by the route and the
 * checks. The request proxy decides who may open a path from the RAW url
 * (the job id, the user id, the brand slug), but the route handler works on
 * the DECODED segments. A segment like `..%2Frival` is one raw segment to the
 * proxy and the two segments `..` and `rival` to the filesystem, so without
 * these checks a member of one brand (or the owner of one job) could read a
 * sibling's files by hiding a separator inside a segment they were allowed.
 */

/** True for a decoded segment that could move across folders: empty, "." or
 *  "..", or one that smuggles in a path separator or NUL. */
export const isUnsafeSegment = (segment: string): boolean => segment === "" || segment === "." || segment === ".." || /[/\\\0]/.test(segment);

export const hasUnsafeSegment = (segments: readonly string[]): boolean => segments.some(isUnsafeSegment);

/** A segment of a storage key (see backend/storage.ts assertValidKey): what
 *  a brand's files are actually named. Stricter than isUnsafeSegment, and
 *  what the `brands` root requires of every segment. */
export const isStorageKeySegment = (segment: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);

/** decodeURIComponent that returns null instead of throwing on a bad escape. */
export const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};
