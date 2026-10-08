import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelInvite, inviteToWorkspace } from "@backend/brand/members";
import { brandRoute, ConflictError, readJsonBody } from "../../../../../lib/brandApi";
import { brandRepo } from "../../../../../lib/brandRepo";
import { query } from "../../../../../lib/db";
import { publicOrigin } from "../../../../../lib/publicOrigin";
import { sendInviteEmail } from "../../../../../lib/email";

const Body = z.object({ email: z.string().trim().min(3).max(254) });

/**
 * POST /api/admin/brands/<slug>/members { email }: adds someone to the
 * brand's workspace. A verified account joins at once; any other address gets
 * an invitation email and joins when it is verified (backend/brand/members.ts).
 * DELETE { email } cancels a pending invitation. Founder only.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(
    slug,
    async ({ user, brand }) => {
      const { email } = await readJsonBody(req, Body);
      let result;
      try {
        result = await inviteToWorkspace(query, brand.workspaceId, email, user.id);
      } catch (err) {
        throw new ConflictError(err instanceof Error ? err.message : "That address cannot be invited.");
      }
      let emailed = false;
      let emailError: string | null = null;
      if (result.status === "invited") {
        try {
          await sendInviteEmail(result.email, brand.name, `${publicOrigin(req)}/signup`);
          emailed = true;
        } catch (err) {
          // The invitation is saved either way: the founder can tell them by hand.
          emailError = err instanceof Error ? err.message : String(err);
        }
      }
      return NextResponse.json({ ok: true, status: result.status, emailed, emailError, members: (await brandRepo.listMembers(slug)).length });
    },
    { adminOnly: true },
  );
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(
    slug,
    async ({ brand }) => {
      const { email } = await readJsonBody(req, Body);
      if (!(await cancelInvite(query, brand.workspaceId, email))) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    },
    { adminOnly: true },
  );
}
