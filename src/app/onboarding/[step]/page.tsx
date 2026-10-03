import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isBrandSlug } from "@backend/brand/keys";
import { getRequestUser } from "../../lib/auth";
import { brandRepo, BrandAccessError } from "../../lib/brandRepo";
import { isDemoMode } from "../../lib/demo";
import { mediaUrl } from "../../lib/mediaUrl";
import { CharacterStep } from "./_components/CharacterStep";
import { NicheStep } from "./_components/NicheStep";
import { PlanStep } from "./_components/PlanStep";
import { STEPS, stepIndex } from "./_components/steps";
import { VoiceStep } from "./_components/VoiceStep";
import { WebsiteStep } from "./_components/WebsiteStep";
import { WizardShell } from "./_components/WizardShell";

export const metadata: Metadata = { title: "Setup · Katalab" };

/**
 * Onboarding (plan/ui-ux-full-flow.md §3), as a replay: it plays back how a
 * brand that already exists was set up, from the files that setup made, with
 * the pacing of a live one. It generates and saves nothing (the one real
 * action, picking the angle, is the same call a live setup makes).
 *
 * Live onboarding for new brands is Phase 2. Until then this is the
 * founder's demo tool, so it needs an admin in demo mode and `?replay=<slug>`
 * naming a brand they can open; anyone else is sent home.
 */
export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ step: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { step } = await params;
  const at = stepIndex(step);
  if (at === -1) notFound();

  const user = await getRequestUser();
  if (!user) redirect("/login");
  const replay = (await searchParams).replay;
  if (!user.isAdmin || typeof replay !== "string") redirect("/calendar");
  if (!(await isDemoMode(user))) redirect("/admin/demo");
  if (!isBrandSlug(replay)) notFound();
  try {
    await brandRepo.assertAccess(user, replay);
  } catch (err) {
    if (err instanceof BrandAccessError) notFound();
    throw err;
  }

  const slug = replay;
  const brand = await brandRepo.getBrand(slug);
  // Shorter pauses in the test environment, so a walkthrough takes seconds.
  const paceMs = process.env.KATALAB_STUB_PROVIDERS === "1" ? 0.04 : 1;
  const here = (i: number) => `/onboarding/${STEPS[i].id}?replay=${slug}`;

  let body;
  let hideNext = false;

  if (step === "website") {
    const intake = await brandRepo.getIntake(slug);
    if (!intake) notFound();
    const product = intake.products[intake.recommendedProductIndex] ?? intake.products[0];
    body = (
      <WebsiteStep
        slug={slug}
        paceMs={paceMs}
        companyName={intake.companyName}
        summary={intake.summary}
        product={{ name: product.name, oneLiner: product.oneLiner, type: product.type, features: product.features, priceNote: product.priceNote }}
        audience={product.audience || intake.audience}
        tone={intake.tone}
        language={brand.language}
        brandKit={{ ...intake.brandKit }}
        assets={intake.assets.map((a) => ({ url: a.url, kind: a.kind }))}
        gaps={intake.gaps}
      />
    );
  } else if (step === "character") {
    const [character, concepts, candidates] = await Promise.all([brandRepo.getCharacter(slug), brandRepo.getConcepts(slug), brandRepo.listCandidates(slug)]);
    if (!character) {
      body = <p className="rounded-2xl border border-dashed border-[color:var(--card-border)] px-5 py-10 text-center text-[15px] text-[color:var(--ink-dim)]">This brand has no locked character yet.</p>;
    } else {
      const chosenConcept = Number(/c(\d+)-/.exec(character.baseImageKey)?.[1] ?? 0);
      const mine = candidates.filter((c) => c.concept === chosenConcept);
      body = (
        <CharacterStep
          slug={slug}
          paceMs={paceMs}
          concepts={concepts.map((c, index) => ({ index, name: c.name, form: c.form, oneLine: c.oneLine, personality: c.personality, signatureProp: c.signatureProp, catchphrase: c.catchphrase }))}
          chosenConcept={chosenConcept}
          variations={mine.filter((c) => c.kind === "variation").map((c) => ({ name: c.name, url: mediaUrl(c.key) }))}
          refinements={mine.filter((c) => c.kind === "refinement").map((c) => ({ name: c.name, url: mediaUrl(c.key) }))}
          base={{ name: /\/(c\d+-[vr]\d+)\.png$/.exec(character.baseImageKey)?.[1] ?? "base", url: mediaUrl(character.baseImageKey) }}
          characterName={character.concept.name}
          kind={character.kind}
          sheet={Object.entries(character.sheet).map(([view, key]) => ({ view, url: mediaUrl(key) }))}
        />
      );
    }
  } else if (step === "voice") {
    const [character, auditions] = await Promise.all([brandRepo.getCharacter(slug), brandRepo.getVoiceAuditions(slug)]);
    body = (
      <VoiceStep
        slug={slug}
        paceMs={paceMs}
        characterName={character?.concept.name ?? "Your character"}
        voiceName={character?.voice?.name ?? ""}
        sampleUrl={character?.voice?.sampleKey ? mediaUrl(character.voice.sampleKey) : null}
        portraitUrl={character?.sheet.front ? mediaUrl(character.sheet.front) : null}
        auditions={auditions.map((a) => ({ name: a.name, url: mediaUrl(a.key), kind: a.generatedVoiceId ? "designed" : "library", chosen: Boolean(character?.voice && (a.libraryVoiceId === character.voice.voiceId || a.generatedVoiceId === character.voice.voiceId)) }))}
      />
    );
  } else if (step === "niche") {
    const [niche, plan, sources] = await Promise.all([brandRepo.getNiche(slug), brandRepo.getPlan(slug), brandRepo.listSources(slug)]);
    hideNext = true;
    body = (
      <NicheStep
        slug={slug}
        paceMs={paceMs}
        angles={niche?.angles ?? []}
        chosenId={niche?.chosenAngleId ?? plan?.niche?.angleId ?? null}
        lockedTitle={plan?.niche?.title ?? null}
        isAdmin={user.isAdmin}
        poolThumbs={sources.flatMap((s) => (s.thumbKey ? [mediaUrl(s.thumbKey)] : [])).slice(0, 4)}
        nextHref={here(at + 1)}
      />
    );
  } else {
    const [plan, niche] = await Promise.all([brandRepo.getPlan(slug), brandRepo.getNiche(slug)]);
    hideNext = true;
    body = <PlanStep slug={slug} paceMs={paceMs} videos={plan?.cards.length ?? 0} nicheTitle={plan?.niche?.title ?? niche?.angles.find((a) => a.id === niche.chosenAngleId)?.title ?? null} />;
  }

  return (
    <WizardShell step={step} slug={slug} brandName={brand.name} hideNext={hideNext}>
      {body}
    </WizardShell>
  );
}
