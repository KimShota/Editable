/** The `format` of a job made by the production pipeline rather than from a
 *  template: there is no format file, the EDL is the whole definition. The
 *  editor page, the render pipeline and `npm run produce` check for it.
 *  (Its own module so the app can import it without the production code.) */
export const AI_VIDEO_FORMAT = "ai-video";
