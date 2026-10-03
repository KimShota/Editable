"use client";

import { useState } from "react";
import { ReplayGate } from "./ReplayGate";

/**
 * Step 1: what was read from the customer's website, as a form they can
 * correct (product and type, audience, tone, language, brand kit). In the
 * replay the form is real but its edits are not kept: it says so.
 */

export type WebsiteData = {
  slug: string;
  companyName: string;
  summary: string;
  product: { name: string; oneLiner: string; type: "physical" | "digital" | "service"; features: string[]; priceNote: string | null };
  audience: string;
  tone: string[];
  language: string;
  brandKit: { primaryColor: string | null; secondaryColor: string | null; accentColor: string | null; textColor: string | null; backgroundColor: string | null; headingFont: string | null; bodyFont: string | null };
  assets: { url: string; kind: string }[];
  gaps: string[];
  paceMs: number;
};

const REPLAY = [
  { stage: "Fetching your pages" },
  { stage: "Finding your product" },
  { stage: "Choosing your colors and fonts" },
  { stage: "Drafting your brand kit" },
];

const input = "w-full rounded-lg border border-[color:var(--card-border)] bg-[color:var(--bg-2)] px-4 py-3 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]";
const label = "mb-2 block text-sm font-medium text-[color:var(--ink)]";

const TYPES = [
  { value: "physical", label: "A physical product", hint: "Something you hold or wear." },
  { value: "digital", label: "An app or software", hint: "Shown through real screens." },
  { value: "service", label: "A service", hint: "Consulting, coaching, a venue." },
] as const;

const COLORS: { key: keyof WebsiteData["brandKit"]; label: string }[] = [
  { key: "primaryColor", label: "Main color" },
  { key: "secondaryColor", label: "Second color" },
  { key: "accentColor", label: "Accent" },
  { key: "textColor", label: "Text" },
  { key: "backgroundColor", label: "Background" },
];

export function WebsiteStep(d: WebsiteData) {
  const [company, setCompany] = useState(d.companyName);
  const [summary, setSummary] = useState(d.summary);
  const [product, setProduct] = useState(d.product.name);
  const [oneLiner, setOneLiner] = useState(d.product.oneLiner);
  const [type, setType] = useState<string>(d.product.type);
  const [features, setFeatures] = useState(d.product.features.join("\n"));
  const [audience, setAudience] = useState(d.audience);
  const [tone, setTone] = useState(d.tone.join(", "));
  const [language, setLanguage] = useState(d.language);
  const [kit, setKit] = useState(d.brandKit);

  return (
    <ReplayGate id={`${d.slug}.website`} title="Reading your website" steps={REPLAY} durationMs={5000 * d.paceMs}>
      <form onSubmit={(e) => e.preventDefault()} className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-label="What we found">
        <p className="lg:col-span-2 text-sm text-[color:var(--ink-dim)]">You can change anything below. In this replay your changes are not kept.</p>

        <section aria-labelledby="brand-title" className="flex flex-col gap-5">
          <h2 id="brand-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Your brand</h2>
          <div>
            <label htmlFor="company" className={label}>Company name</label>
            <input id="company" value={company} onChange={(e) => setCompany(e.target.value)} className={input} />
          </div>
          <div>
            <label htmlFor="summary" className={label}>What the company does</label>
            <textarea id="summary" value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} className={input} />
          </div>
          <div>
            <label htmlFor="language" className={label}>Language of your videos</label>
            <select id="language" value={language} onChange={(e) => setLanguage(e.target.value)} className={input}>
              <option value="en">English</option>
              <option value="ja">Japanese</option>
            </select>
          </div>
        </section>

        <section aria-labelledby="product-title" className="flex flex-col gap-5">
          <h2 id="product-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">The product to promote</h2>
          <div>
            <label htmlFor="product" className={label}>Product name</label>
            <input id="product" value={product} onChange={(e) => setProduct(e.target.value)} className={input} />
          </div>
          <div>
            <label htmlFor="oneliner" className={label}>In one sentence</label>
            <textarea id="oneliner" value={oneLiner} onChange={(e) => setOneLiner(e.target.value)} rows={2} className={input} />
          </div>
          <fieldset>
            <legend className={label}>What kind of product is it?</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {TYPES.map((t) => (
                <label key={t.value} className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border p-3 text-sm ${type === t.value ? "border-[color:var(--ink)] bg-[color:var(--card)]" : "border-[color:var(--card-border)]"}`}>
                  <span className="flex items-center gap-2 font-medium text-[color:var(--ink)]">
                    <input type="radio" name="type" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} />
                    {t.label}
                  </span>
                  <span className="text-[13px] text-[color:var(--ink-dim)]">{t.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="features" className={label}>What it does, one per line</label>
            <textarea id="features" value={features} onChange={(e) => setFeatures(e.target.value)} rows={5} className={input} />
            {d.product.priceNote && <p className="mt-1.5 text-[13px] text-[color:var(--ink-dim)]">Price on your site: {d.product.priceNote}</p>}
          </div>
        </section>

        <section aria-labelledby="audience-title" className="flex flex-col gap-5">
          <h2 id="audience-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Who it is for</h2>
          <div>
            <label htmlFor="audience" className={label}>Your audience</label>
            <textarea id="audience" value={audience} onChange={(e) => setAudience(e.target.value)} rows={3} className={input} />
          </div>
          <div>
            <label htmlFor="tone" className={label}>How you sound, separated by commas</label>
            <input id="tone" value={tone} onChange={(e) => setTone(e.target.value)} className={input} />
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Tone">
              {tone.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                <li key={t} className="rounded-full bg-[color:var(--bg-2)] px-3 py-1 text-[13px] text-[color:var(--ink)]">{t}</li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="kit-title" className="flex flex-col gap-5">
          <h2 id="kit-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Your brand kit</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {COLORS.map((c) => (
              <div key={c.key}>
                <label htmlFor={`color-${c.key}`} className={label}>{c.label}</label>
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="h-10 w-10 shrink-0 rounded-lg border border-[color:var(--card-border)]" style={{ background: kit[c.key] ?? "transparent" }} />
                  <input id={`color-${c.key}`} value={kit[c.key] ?? ""} placeholder="Not found" onChange={(e) => setKit((k) => ({ ...k, [c.key]: e.target.value }))} className={input} />
                </div>
              </div>
            ))}
            <div>
              <label htmlFor="heading-font" className={label}>Headline font</label>
              <input id="heading-font" value={kit.headingFont ?? ""} placeholder="Not found" onChange={(e) => setKit((k) => ({ ...k, headingFont: e.target.value }))} className={input} />
            </div>
            <div>
              <label htmlFor="body-font" className={label}>Body font</label>
              <input id="body-font" value={kit.bodyFont ?? ""} placeholder="Not found" onChange={(e) => setKit((k) => ({ ...k, bodyFont: e.target.value }))} className={input} />
            </div>
          </div>
        </section>

        <section aria-labelledby="assets-title" className="lg:col-span-2">
          <h2 id="assets-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Pictures and recordings</h2>
          {d.assets.length > 0 ? (
            <ul className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {d.assets.map((a) => (
                <li key={a.url} className="overflow-hidden rounded-xl bg-[color:var(--bg-2)]">
                  <img src={a.url} alt={`${a.kind} from your website`} referrerPolicy="no-referrer" className="aspect-square w-full object-cover" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-[color:var(--ink-dim)]">We did not find pictures on your site.</p>
          )}
          {d.gaps.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-medium text-[color:var(--ink)]">We could not find</h3>
              <ul className="mt-1.5 list-disc pl-5 text-sm text-[color:var(--ink-dim)]">
                {d.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </form>
    </ReplayGate>
  );
}
