import type { Metadata } from "next";
import { getActiveBrand } from "../../lib/activeBrand";
import { getRequestUser } from "../../lib/auth";
import { brandRepo } from "../../lib/brandRepo";
import { mediaUrl } from "../../lib/mediaUrl";
import { Container, EmptyState, PageHeader } from "../../_components/ui";
import { AssetsSection, KitForm, ProductForm, ScheduleForm } from "./_components/BrandForms";

export const metadata: Metadata = { title: "Brand · Katalab" };

const SECTIONS = [
  ["product", "Product"],
  ["kit", "Brand kit"],
  ["schedule", "Language and time"],
  ["assets", "Pictures"],
  ["character", "Character"],
  ["angle", "Angle"],
  ["social", "Social accounts"],
] as const;

const locked = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0">
    <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
  </svg>
);

/** Everything about the brand in one place (plan/ui-ux-full-flow.md §7). */
export default async function BrandPage() {
  const user = (await getRequestUser())!;
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Brand" />
        <EmptyState title="Your workspace is being set up">We are getting your brand ready.</EmptyState>
      </Container>
    );
  }

  const slug = active.slug;
  const [settings, assets, character, plan, niche] = await Promise.all([brandRepo.getSettings(slug), brandRepo.listProductAssets(slug), brandRepo.getCharacter(slug), brandRepo.getPlan(slug), brandRepo.getNiche(slug)]);
  const angle = plan?.niche?.title ?? niche?.angles.find((a) => a.id === niche.chosenAngleId)?.title ?? null;
  const timeZones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
  const url = (key: string | null, source: string | null) => (key ? mediaUrl(key) : (source ?? ""));

  return (
    <Container className="max-w-4xl">
      <PageHeader kicker={active.name} title="Brand" subtitle="What your videos are about and how they look." />

      <nav aria-label="On this page" className="mb-8 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {SECTIONS.map(([id, text]) => (
          <a key={id} href={`#${id}`} className="font-medium text-[color:var(--ink-dim)] underline-offset-4 hover:text-[color:var(--ink)] hover:underline">{text}</a>
        ))}
      </nav>

      <div className="flex flex-col gap-8">
        <ProductForm slug={slug} initial={{ name: settings.product.name, oneLiner: settings.product.oneLiner, type: settings.product.type, url: settings.product.url ?? "", features: settings.product.features.join("\n") }} />
        <KitForm
          slug={slug}
          logoUrl={settings.kit.logoKey ? mediaUrl(settings.kit.logoKey) : null}
          initial={{ primaryColor: settings.kit.primaryColor ?? "", secondaryColor: settings.kit.secondaryColor ?? "", accentColor: settings.kit.accentColor ?? "", textColor: settings.kit.textColor ?? "", backgroundColor: settings.kit.backgroundColor ?? "", headingFont: settings.kit.headingFont ?? "", bodyFont: settings.kit.bodyFont ?? "" }}
        />
        <ScheduleForm slug={slug} initial={{ language: settings.brand.language, postTime: settings.brand.postTime, timezone: settings.brand.timezone }} timeZones={timeZones} />
        <AssetsSection slug={slug} assets={assets.map((a) => ({ id: a.id, kind: a.kind, url: url(a.mediaKey, a.sourceUrl), isVideo: a.kind === "screen_recording" })).filter((a) => a.url)} />

        <section id="character" aria-labelledby="character-title" className="scroll-mt-24 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="character-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Character and voice</h2>
            <p className="inline-flex items-center gap-2 rounded-full bg-[color:var(--bg-2)] px-3 py-1 text-sm text-[color:var(--ink)]">{locked}Locked for this brand</p>
          </div>
          {character ? (
            <div className="mt-4 flex flex-col gap-5 sm:flex-row">
              {character.sheet.front && <img src={mediaUrl(character.sheet.front)} alt={character.concept.name} className="h-40 w-28 shrink-0 rounded-xl bg-[color:var(--bg-2)] object-cover" />}
              <div className="min-w-0">
                <p className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">{character.concept.name}</p>
                <p className="mt-1 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">{character.concept.oneLine}</p>
                {character.voice && (
                  <div className="mt-4">
                    <p className="text-sm text-[color:var(--ink)]">Voice: {character.voice.name}</p>
                    {character.voice.sampleKey && <audio controls preload="none" src={mediaUrl(character.voice.sampleKey)} aria-label={`${character.concept.name} speaking`} className="mt-2 w-full max-w-sm" />}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[color:var(--ink-dim)]">Your character is not set up yet.</p>
          )}
          <p className="mt-4 text-sm text-[color:var(--ink-dim)]">Your character and voice stay the same in every video so people come to know them. Need a change? Contact us.</p>
        </section>

        <section id="angle" aria-labelledby="angle-title" className="scroll-mt-24 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="angle-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Angle</h2>
            {plan?.niche && <p className="inline-flex items-center gap-2 rounded-full bg-[color:var(--bg-2)] px-3 py-1 text-sm text-[color:var(--ink)]">{locked}Locked for this cycle</p>}
          </div>
          <p className="mt-3 text-[15px] text-[color:var(--ink)]">{angle ?? "No angle chosen yet."}</p>
          <p className="mt-1 text-sm text-[color:var(--ink-dim)]">{plan?.niche ? "It can change when the next cycle starts." : "You choose it when your plan is set up."}</p>
        </section>

        <section id="social" aria-labelledby="social-title" className="scroll-mt-24 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-6">
          <h2 id="social-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Social accounts</h2>
          <p className="mt-1 text-sm text-[color:var(--ink-dim)]">Posting for you is coming soon. Until then, download each video from your calendar and post it yourself.</p>
          <ul className="mt-4 flex flex-wrap gap-3" aria-label="Social accounts">
            {["TikTok", "Instagram", "YouTube"].map((n) => (
              <li key={n}>
                <button type="button" disabled className="rounded-full border border-[color:var(--card-border)] px-5 py-2 text-sm font-medium text-[color:var(--ink-dim)] opacity-60">Connect {n}</button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Container>
  );
}
