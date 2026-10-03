import type { ReactNode } from "react";

/** The wizard is a focused flow: no sidebar, just the steps. */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-[100dvh]">{children}</div>;
}
