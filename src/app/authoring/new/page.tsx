import { redirect } from "next/navigation";

/** This page moved to /reverse-engineer (same "paste a reel URL" flow,
 *  just properly named and given a real nav entry instead of being a
 *  button buried on the templates page). Kept as a redirect rather than
 *  deleted so any bookmarked/linked /authoring/new URL still works. */
export default function AuthoringNewRedirect() {
  redirect("/reverse-engineer");
}
