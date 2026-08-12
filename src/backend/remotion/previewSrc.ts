/** Editor-only: resolves a source clip through the transcoded preview proxy
 *  instead of the (often 4K) original — see previewMedia.ts. Export never
 *  sets `previewMode`, so `render.ts` always gets the real source. Shared by
 *  every component that plays a video in the preview (EdlVideo's own
 *  Segment/FgLayer, plus VideoOverlay/CutawayOverlay) so none of them
 *  accidentally live-decode a multi-4K-Mbps original in the browser. */
export const previewProxySrc = (jobId: string, src: string): string =>
  `/api/jobs/${jobId}/preview-proxy?src=${encodeURIComponent(src)}`;
