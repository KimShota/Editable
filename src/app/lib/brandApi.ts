import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { BrandRef } from "@backend/brand/access";
import { isBrandSlug } from "@backend/brand/keys";
import { TransitionError } from "@backend/plan/status";
import { ViralUrlError } from "@backend/recreation/viralUrl";
import { getRequestUser } from "./auth";
import { BrandAccessError, brandRepo } from "./brandRepo";
import type { SessionUser } from "./session";

/**
 * The common shell of every /api/brands/<slug>/… and /api/admin/… handler:
 * who is asking, may they open this brand, and how a failure becomes a
 * response. The request proxy already gates these paths by membership; this
 * is the second lock, and the one that knows the user.
 *
 *   400  the request is malformed (zod), or the link pasted is not allowed
 *   401  not signed in
 *   404  no such brand, or not yours (indistinguishable on purpose)
 *   409  the card is not in a state that allows that (TransitionError, or a
 *        rule such as "still being written")
 */

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export const brandRoute = async (
  slug: string,
  run: (ctx: { user: SessionUser; brand: BrandRef }) => Promise<NextResponse>,
  opts: { adminOnly?: boolean } = {},
): Promise<NextResponse> => {
  const user = await getRequestUser();
  if (!user) return NextResponse.json({ error: "log in required" }, { status: 401 });
  if (!isBrandSlug(slug) || (opts.adminOnly && !user.isAdmin)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const brand = await brandRepo.assertAccess(user, slug);
    return await run({ user, brand });
  } catch (err) {
    if (err instanceof BrandAccessError) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (err instanceof TransitionError || err instanceof ConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
    // The first reason, in the words of the schema ("a line cannot be empty"),
    // is what a person sees; every issue is kept for whoever is debugging.
    if (err instanceof ZodError) return NextResponse.json({ error: err.issues[0]?.message ?? "invalid request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
    if (err instanceof ViralUrlError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error(`brand route failed (${slug})`, err);
    return NextResponse.json({ error: "something went wrong" }, { status: 500 });
  }
};

/** Parses a JSON body, or throws the ZodError brandRoute turns into a 400. */
export const readJsonBody = async <T>(req: Request, schema: { parse: (v: unknown) => T }): Promise<T> => schema.parse(await req.json().catch(() => ({})));
