"use client";

import { type ReactNode, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "../../../lib/clientApi";

/**
 * The parts of a brand a customer may change (plan/ui-ux-full-flow.md §7):
 * the product, the brand kit, the schedule, and product pictures. Each section
 * saves on its own and says what happened; the server decides what is valid
 * and its reason is shown as it came. Character, voice and the cycle's angle
 * are locked and live in the page, read-only.
 */

const field = "w-full rounded-lg border border-[color:var(--card-border)] bg-[color:var(--bg-2)] px-4 py-3 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)] disabled:opacity-60";
const label = "mb-2 block text-sm font-medium text-[color:var(--ink)]";
const save = "rounded-full bg-[color:var(--ink)] px-6 py-2.5 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] transition-transform hover:scale-[1.03] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]";
const quiet = "rounded-full border border-[color:var(--card-border)] px-4 py-2 text-sm font-medium text-[color:var(--ink)] transition-colors hover:border-[color:var(--ink)] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]";

type Msg = { tone: "ok" | "bad"; text: string } | null;

function Section({ id, title, note, onSubmit, busy, dirty, msg, children }: { id: string; title: string; note?: string; onSubmit: () => void; busy: boolean; dirty: boolean; msg: Msg; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-6">
      <h2 id={`${id}-title`} className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">{title}</h2>
      {note && <p className="mt-1 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">{note}</p>}
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="mt-5 flex flex-col gap-5">
        {children}
        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" className={save} disabled={busy || !dirty}>{busy ? "Saving" : "Save"}</button>
          {msg && <p role={msg.tone === "bad" ? "alert" : "status"} className={`text-sm ${msg.tone === "bad" ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>{msg.text}</p>}
        </div>
      </form>
    </section>
  );
}

/** One section's save: sends only what the section owns, reports the server's reason on failure. */
const useSave = (slug: string) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (body: unknown) => {
    setBusy(true);
    setMsg(null);
    const res = await sendJson(`/api/brands/${slug}/settings`, body, "PATCH");
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "bad", text: res.error });
    setMsg({ tone: "ok", text: "Saved." });
    router.refresh();
  };
  return { busy, msg, run };
};

export type ProductValues = { name: string; oneLiner: string; type: "physical" | "digital" | "service"; url: string; features: string };

export function ProductForm({ slug, initial }: { slug: string; initial: ProductValues }) {
  const [v, setV] = useState(initial);
  const { busy, msg, run } = useSave(slug);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  return (
    <Section id="product" title="Product" note="What your videos promote. Changes apply to videos written from now on." onSubmit={() => run({ product: { name: v.name, oneLiner: v.oneLiner, type: v.type, url: v.url, features: v.features.split("\n").map((f) => f.trim()).filter(Boolean) } })} busy={busy} dirty={dirty} msg={msg}>
      <div>
        <label htmlFor="p-name" className={label}>Name</label>
        <input id="p-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={field} />
      </div>
      <div>
        <label htmlFor="p-liner" className={label}>In one sentence</label>
        <textarea id="p-liner" value={v.oneLiner} onChange={(e) => setV({ ...v, oneLiner: e.target.value })} rows={2} className={field} />
      </div>
      <fieldset>
        <legend className={label}>What kind of product is it?</legend>
        <div className="flex flex-wrap gap-3">
          {([["physical", "A physical product"], ["digital", "An app or software"], ["service", "A service"]] as const).map(([val, text]) => (
            <label key={val} className="flex cursor-pointer items-center gap-2 text-sm text-[color:var(--ink)]">
              <input type="radio" name="p-type" checked={v.type === val} onChange={() => setV({ ...v, type: val })} />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="p-features" className={label}>What it does, one per line</label>
        <textarea id="p-features" value={v.features} onChange={(e) => setV({ ...v, features: e.target.value })} rows={5} className={field} />
        <p className="mt-1.5 text-[13px] text-[color:var(--ink-dim)]">These are the only product facts your scripts may state.</p>
      </div>
      <div>
        <label htmlFor="p-url" className={label}>Product web address (optional)</label>
        <input id="p-url" value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} placeholder="https://" inputMode="url" className={field} />
      </div>
    </Section>
  );
}

export type KitValues = { primaryColor: string; secondaryColor: string; accentColor: string; textColor: string; backgroundColor: string; headingFont: string; bodyFont: string };
const COLORS: { key: keyof KitValues; text: string }[] = [
  { key: "primaryColor", text: "Main color" },
  { key: "secondaryColor", text: "Second color" },
  { key: "accentColor", text: "Accent" },
  { key: "textColor", text: "Text" },
  { key: "backgroundColor", text: "Background" },
];

export function KitForm({ slug, initial, logoUrl }: { slug: string; initial: KitValues; logoUrl: string | null }) {
  const [v, setV] = useState(initial);
  const { busy, msg, run } = useSave(slug);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const orNull = (s: string) => (s.trim() === "" ? null : s.trim());
  return (
    <Section id="kit" title="Brand kit" note="Applies to videos made from now on. Videos already made keep the look they were made with." onSubmit={() => run({ kit: { primaryColor: orNull(v.primaryColor), secondaryColor: orNull(v.secondaryColor), accentColor: orNull(v.accentColor), textColor: orNull(v.textColor), backgroundColor: orNull(v.backgroundColor), headingFont: orNull(v.headingFont), bodyFont: orNull(v.bodyFont) } })} busy={busy} dirty={dirty} msg={msg}>
      <div className="grid gap-4 sm:grid-cols-2">
        {COLORS.map((c) => (
          <div key={c.key}>
            <label htmlFor={`k-${c.key}`} className={label}>{c.text}</label>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="h-11 w-11 shrink-0 rounded-lg border border-[color:var(--card-border)]" style={{ background: /^#[0-9a-fA-F]{6}$/.test(v[c.key]) ? v[c.key] : "transparent" }} />
              <input id={`k-${c.key}`} value={v[c.key]} onChange={(e) => setV({ ...v, [c.key]: e.target.value })} placeholder="Not set" className={field} />
            </div>
          </div>
        ))}
        <div>
          <label htmlFor="k-heading" className={label}>Headline font</label>
          <input id="k-heading" value={v.headingFont} onChange={(e) => setV({ ...v, headingFont: e.target.value })} className={field} />
        </div>
        <div>
          <label htmlFor="k-body" className={label}>Body font</label>
          <input id="k-body" value={v.bodyFont} onChange={(e) => setV({ ...v, bodyFont: e.target.value })} className={field} />
        </div>
      </div>
      <div>
        <p className={label}>Logo</p>
        {logoUrl ? <img src={logoUrl} alt="Your current logo" className="h-16 w-auto max-w-[12rem] rounded-lg bg-[color:var(--bg-2)] object-contain p-2" /> : <p className="text-sm text-[color:var(--ink-dim)]">No logo yet. Add one under Pictures and recordings.</p>}
      </div>
    </Section>
  );
}

export type ScheduleValues = { language: string; postTime: string; timezone: string };

export function ScheduleForm({ slug, initial, timeZones }: { slug: string; initial: ScheduleValues; timeZones: string[] }) {
  const [v, setV] = useState(initial);
  const { busy, msg, run } = useSave(slug);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  return (
    <Section id="schedule" title="Language and posting time" onSubmit={() => run({ brand: v })} busy={busy} dirty={dirty} msg={msg}>
      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <label htmlFor="s-language" className={label}>Language of your videos</label>
          <select id="s-language" value={v.language} onChange={(e) => setV({ ...v, language: e.target.value })} className={field}>
            <option value="en">English</option>
            <option value="ja">Japanese</option>
          </select>
        </div>
        <div>
          <label htmlFor="s-time" className={label}>Daily posting time</label>
          <input id="s-time" type="time" value={v.postTime} onChange={(e) => setV({ ...v, postTime: e.target.value })} className={field} />
        </div>
        <div>
          <label htmlFor="s-zone" className={label}>Time zone</label>
          <input id="s-zone" list="time-zones" value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} className={field} />
          <datalist id="time-zones">{timeZones.map((z) => <option key={z} value={z} />)}</datalist>
        </div>
      </div>
    </Section>
  );
}

export type AssetView = { id: string; kind: string; url: string; isVideo: boolean };
const KIND_LABEL: Record<string, string> = { photo: "Photo", screenshot: "Screenshot", screen_recording: "Screen recording", logo: "Logo", other: "Other" };

export function AssetsSection({ slug, assets }: { slug: string; assets: AssetView[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("photo");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) return setMsg({ tone: "bad", text: "Choose a file first." });
    setBusy("upload");
    setMsg(null);
    const body = new FormData();
    body.set("kind", kind);
    body.set("file", file);
    try {
      const res = await fetch(`/api/brands/${slug}/assets`, { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not upload. Please try again.");
      if (input.current) input.current.value = "";
      setMsg({ tone: "ok", text: "Added." });
      router.refresh();
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "That did not upload." });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setMsg(null);
    const res = await sendJson(`/api/brands/${slug}/assets/${id}`, {}, "DELETE");
    setBusy(null);
    if (!res.ok) return setMsg({ tone: "bad", text: res.error });
    router.refresh();
  };

  return (
    <section id="assets" aria-labelledby="assets-title" className="scroll-mt-24 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-6">
      <h2 id="assets-title" className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">Pictures and recordings</h2>
      <p className="mt-1 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">What shows your product: photos, screenshots and screen recordings, and your logo.</p>

      {assets.length === 0 ? (
        <p className="mt-4 text-sm text-[color:var(--ink-dim)]">Nothing here yet.</p>
      ) : (
        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Product pictures and recordings">
          {assets.map((a) => (
            <li key={a.id} className="overflow-hidden rounded-xl border border-[color:var(--card-border)]">
              {a.isVideo ? <video src={a.url} controls preload="metadata" className="aspect-square w-full bg-[color:var(--ink)] object-cover" aria-label={KIND_LABEL[a.kind] ?? a.kind} /> : <img src={a.url} alt={KIND_LABEL[a.kind] ?? a.kind} className="aspect-square w-full bg-[color:var(--bg-2)] object-cover" referrerPolicy="no-referrer" />}
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-[13px] text-[color:var(--ink-dim)]">{KIND_LABEL[a.kind] ?? a.kind}</span>
                <button type="button" onClick={() => remove(a.id)} disabled={busy !== null} aria-label={`Remove this ${KIND_LABEL[a.kind]?.toLowerCase() ?? "file"}`} className="text-[13px] font-medium text-[color:var(--ink-dim)] underline-offset-4 hover:text-[color:var(--st-bad-fg)] hover:underline disabled:opacity-40">
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={upload} className="mt-6 flex flex-col gap-4 border-t border-[color:var(--card-border)] pt-5 sm:flex-row sm:items-end">
        <div>
          <label htmlFor="a-kind" className={label}>What is it?</label>
          <select id="a-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
            <option value="photo">A photo</option>
            <option value="screenshot">A screenshot</option>
            <option value="screen_recording">A screen recording</option>
            <option value="logo">My logo</option>
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor="a-file" className={label}>File</label>
          <input id="a-file" ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" className="block w-full text-sm text-[color:var(--ink)] file:mr-3 file:rounded-full file:border file:border-[color:var(--card-border)] file:bg-transparent file:px-4 file:py-2 file:text-sm file:font-medium" />
        </div>
        <button type="submit" className={quiet} disabled={busy !== null}>{busy === "upload" ? "Uploading" : "Upload"}</button>
      </form>
      <p className="mt-2 text-[13px] text-[color:var(--ink-dim)]">Pictures up to 10 MB (PNG, JPEG, WebP, GIF). Recordings up to 150 MB (MP4, WebM).</p>
      {msg && <p role={msg.tone === "bad" ? "alert" : "status"} className={`mt-3 text-sm ${msg.tone === "bad" ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>{msg.text}</p>}
    </section>
  );
}
