import { redirect } from "next/navigation";

/** The account page moved into the workspace screen. Old links (and any email
 *  link already sent) keep working, with their query string. */
export default async function AccountRedirect({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, value);
  redirect(`/workspace${params.size ? `?${params}` : ""}`);
}
