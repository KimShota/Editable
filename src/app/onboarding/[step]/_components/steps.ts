/** The five onboarding steps, in order (plan/ui-ux-full-flow.md §3). */
export const STEPS = [
  { id: "website", label: "Your website", title: "Here is what we found on your website", blurb: "Check that it is right. Everything here can be changed." },
  { id: "character", label: "Character", title: "Meet your character", blurb: "One character stars in every video, so people come to know it." },
  { id: "voice", label: "Voice", title: "Choose its voice", blurb: "The same voice in every video." },
  { id: "niche", label: "Angle", title: "What are your videos about?", blurb: "Pick the angle for your first 14 days." },
  { id: "plan", label: "First plan", title: "Your first 14 days", blurb: "A video for every day, ready for you to review." },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export const stepIndex = (id: string): number => STEPS.findIndex((s) => s.id === id);
