/** The URL a browser uses for a storage key such as
 *  "brands/acme/character/sheet/front.png": the media route serves the
 *  `brands` root at /api/media/brands/…. Each segment is encoded; the
 *  separators are kept. */
export const mediaUrl = (key: string): string => `/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
