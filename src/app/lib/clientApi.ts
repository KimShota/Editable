/** POST/PUT JSON from a client component and read the answer, whatever it
 *  is: the API replies { error } with a status for anything it refuses, and
 *  a network failure is reported the same way, so a caller has one shape to
 *  handle. */
export type ApiResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; status: number; error: string };

export const sendJson = async <T = Record<string, unknown>>(url: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<ApiResult<T>> => {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data.error ?? "Something went wrong. Please try again." };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server. Check your connection and try again." };
  }
};
