import "server-only";
import { cookies } from "next/headers";

/**
 * Demo mode: the founder's switch for showing the product (plan/ui-ux-full-flow.md
 * §2.5). It lets the onboarding wizard replay a brand's real setup, which
 * generates and saves nothing. The cookie means nothing on its own: every use
 * also requires the viewer to be an admin, so it cannot be used to see
 * anything a customer should not.
 */
export const DEMO_COOKIE = "katalab_demo";

export const isDemoMode = async (user: { isAdmin: boolean }): Promise<boolean> => user.isAdmin && (await cookies()).get(DEMO_COOKIE)?.value === "1";
