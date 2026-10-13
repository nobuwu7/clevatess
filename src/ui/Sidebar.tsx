import { useEffect, useRef, useState } from "react";
import { PiWaveform, PiFileText, PiImage, PiSpinnerGap, PiPlus, PiTrash, PiUploadSimple, PiVideoCamera, PiX } from "react-icons/pi";
import { buildCues, CAPTION_PRESETS, timelineWords, toSRT } from "../engine/captions";
import { applyOp, type Op } from "../engine/ops";
import { appendAsset } from "../engine/project";
import { contrastOn } from "../engine/render";
import type { BrandKit, CaptionPreset } from "../engine/types";
import { getBlob } from "../lib/db";
import { executeOps, importFiles, removeAsset } from "../store/actions";
import { commit, getState, setState, useStore, type SidePanel } from "../store/store";
import { bytes, shortTime } from "./format";

export const BRAND_FONTS = ["Bricolage Grotesque", "Space Grotesk", "Outfit", "Archivo Black", "DM Sans", "Playfair Display"];

export function Sidebar({ onPick }: { onPick: () => void }) {
  const side = useStore((s) => s.side);
  const tabs: { id: SidePanel; label: string }[] = [
    { id: "media", label: "Media" },
    { id: "brand", label: "Brand" },
    { id: "captions", label: "Captions" },
  ];
  return (
    <aside className="side" aria-label="Library">
      <div className="panel-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={side === t.id} onClick={() => setState({ side: t.id })}>
            {t.label}
          </button>
        ))}
        <span
          className="tab-indicator"
          aria-hidden
          style={{
            width: `calc((100% - 16px - ${(tabs.length - 1) * 2}px) / ${tabs.length} - 20px)`,
            transform: `translateX(calc(${tabs.findIndex((t) => t.id === side)} * (100% + 22px) + 10px))`,
          }}
        />
      </div>
      <div className="panel-body" role="tabpanel">
        {side === "media" && <MediaPanel onPick={onPick} />}
        {side === "brand" && <BrandPanel />}
        {side === "captions" && <CaptionsPanel />}
      </div>
    </aside>
  );
}

function MediaPanel({ onPick }: { onPick: () => void }) {
  const assets = useStore((s) => s.project.assets);
  const thumbs = useStore((s) => s.thumbs);
  const logoId = useStore((s) => s.project.brand.logoAssetId);
  const list = assets.filter((a) => a.id !== logoId);
  const importing = useStore((s) => s.importing);
  return (
    <>
      {importing > 0 && (
        <div className="importing" role="status">
          <PiSpinnerGap size={14} className="spin" /> Importing {importing} file{importing === 1 ? "" : "s"}…
        </div>
      )}
      <button className="drop-hint" onClick={onPick} style={{ width: "100%", cursor: "pointer", background: "transparent" }}>
        <PiUploadSimple size={18} />
        <span>
          <b style={{ color: "var(--text)", fontWeight: 500 }}>Add media</b>
          <br />
          or drop files anywhere
        </span>
      </button>
      {list.length > 0 && <div className="section-label">In this project</div>}
      {list.map((a) => (
        <div className="asset" key={a.id}>
          <div className="asset-thumb" style={thumbs[a.id]?.[0] ? { backgroundImage: `url(${thumbs[a.id][0]})` } : undefined}>
            {!thumbs[a.id]?.[0] && (a.kind === "audio" ? <PiWaveform size={16} /> : a.kind === "image" ? <PiImage size={16} /> : <PiVideoCamera size={16} />)}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="asset-name" title={a.name}>
              {a.name}
            </div>
            <div className="asset-meta tabular">
              {a.kind === "image" ? "Still" : shortTime(a.duration)} · {bytes(a.size)}
            </div>
          </div>
          <div className="asset-actions">
            <button className="btn btn-ghost btn-icon btn-sm" title="Add to end of timeline" onClick={() => commit(appendAsset(getState().project, a))}>
              <PiPlus size={14} />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" title="Remove from project" onClick={() => removeAsset(a.id)}>
              <PiTrash size={14} />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function setBrand(patch: Partial<BrandKit>) {
  const p = structuredClone(getState().project);
  Object.assign(p.brand, patch);
  p.updatedAt = Date.now();
  commit(p);
}

/** Coalesce colour-picker drags into one undo step. */
function useDebouncedBrand() {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [draft, setDraft] = useState<Partial<BrandKit>>({});
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    draft,
    set(patch: Partial<BrandKit>) {
      setDraft((d) => ({ ...d, ...patch }));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setBrand(patch);
        setDraft({});
      }, 180);
    },
  };
}

function BrandPanel() {
  const brand = useStore((s) => s.project.brand);
  const { draft, set } = useDebouncedBrand();
  const b = { ...brand, ...draft };
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let u: string | null = null;
    if (brand.logoAssetId) getBlob(brand.logoAssetId).then((bl) => bl && setLogoUrl((u = URL.createObjectURL(bl))));
    else setLogoUrl(null);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [brand.logoAssetId]);

  return (
    <>
      <p style={{ margin: "0 2px 14px", color: "var(--muted)" }}>
        Set it once. Titles, captions and every export variant pick it up, and the assistant can apply it on request.
      </p>
      <label className="field">
        <span>Brand name</span>
        <input className="input" value={b.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <div className="section-label">Colours</div>
      <div className="swatches" style={{ marginBottom: 16 }}>
        {(["primary", "accent", "text"] as const).map((k) => (
          <label className="swatch" key={k}>
            <span className="swatch-chip" style={{ background: b[k] }}>
              <input type="color" value={b[k]} onChange={(e) => set({ [k]: e.target.value })} aria-label={`${k} colour`} />
            </span>
            <span style={{ textTransform: "capitalize", lineHeight: 1.3 }}>
              {k}
              <span className="tabular" style={{ display: "block", color: "var(--faint)", textTransform: "none" }}>
                {b[k].toUpperCase()}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="section-label">Typeface</div>
      <div className="font-grid" style={{ marginBottom: 16 }}>
        {BRAND_FONTS.map((f) => (
          <button key={f} className="font-option" aria-pressed={b.font === f} style={{ fontFamily: `"${f}"` }} onClick={() => setBrand({ font: f })}>
            {f.split(" ")[0]}
          </button>
        ))}
      </div>
      <div className="section-label">Logo</div>
      <div className="logo-slot" style={{ marginBottom: 10 }}>
        {logoUrl ? <img src={logoUrl} alt="Logo" /> : <span style={{ color: "var(--faint)" }}>No logo</span>}
        <span style={{ flex: 1 }} />
        {logoUrl && (
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Remove logo" onClick={() => setBrand({ logoAssetId: undefined })}>
            <PiX size={14} />
          </button>
        )}
        <button className="btn btn-sm" onClick={() => logoInput.current?.click()}>
          {logoUrl ? "Replace" : "Upload"}
        </button>
        <input
          ref={logoInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            if (e.target.files?.length) importFiles(e.target.files, { asLogo: true });
            e.target.value = "";
          }}
        />
      </div>
      {logoUrl && (
        <div className="field">
          <span>Corner</span>
          <div className="seg" role="group">
            {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((pos) => (
              <button key={pos} aria-pressed={b.logoPosition === pos} onClick={() => setBrand({ logoPosition: pos })}>
                {pos.replace("top-", "↑ ").replace("bottom-", "↓ ")}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <span>When the shape doesn't match</span>
        <div className="seg" role="group">
          <button aria-pressed={b.fit === "contain-blur"} onClick={() => setBrand({ fit: "contain-blur" })}>
            Blur the edges
          </button>
          <button aria-pressed={b.fit === "cover"} onClick={() => setBrand({ fit: "cover" })}>
            Crop to fill
          </button>
        </div>
        <small>Used when a 16:9 shot goes into a vertical or square cut.</small>
      </div>
      <div
        className="preset-sample"
        style={{ height: 72, background: `linear-gradient(135deg, ${b.primary}22, #15140f)`, fontFamily: `"${b.font}"`, fontSize: 18, fontWeight: 700, color: b.text }}
      >
        <span>
          {b.name || "Your brand"} <span style={{ background: b.primary, color: contrastOn(b.primary), padding: "0 6px", borderRadius: 4 }}>on air</span>
        </span>
      </div>
    </>
  );
}

function presetStyle(id: CaptionPreset, brand: BrandKit): React.CSSProperties {
  const base: React.CSSProperties = { fontFamily: `"${brand.font}"`, color: brand.text };
  switch (id) {
    case "bold-pop":
      return { ...base, fontWeight: 800, textTransform: "uppercase", WebkitTextStroke: "0.5px #000", textShadow: "0 2px 0 #000" };
    case "karaoke":
      return { ...base, fontWeight: 800 };
    case "boxed":
      return { ...base, fontWeight: 800, textTransform: "uppercase", background: brand.primary, color: contrastOn(brand.primary), padding: "2px 6px", borderRadius: 4 };
    case "clean":
      return { ...base, fontWeight: 600, textShadow: "0 2px 8px rgba(0,0,0,.6)" };
    case "minimal":
      return { ...base, fontWeight: 500, fontSize: 12, textTransform: "lowercase", opacity: 0.9 };
    case "editorial":
      return { ...base, fontFamily: '"Playfair Display", Georgia, serif', fontStyle: "italic", fontSize: 15 };
  }
}

function CaptionsPanel() {
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const { captions, brand } = project;
  const hasMedia = project.tracks.some((t) => t.kind !== "text" && t.clips.length);
  const hasTranscript = project.transcripts.length > 0;
  const set = (op: Op) => commit(applyOp(getState().project, op));

  const downloadSRT = () => {
    const srt = toSRT(buildCues(timelineWords(project), captions.maxWords));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([srt], { type: "text/plain" }));
    a.download = `${project.name || "captions"}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <>
      {!hasTranscript ? (
        <div className="note">
          Captions come from a transcript of the speech. Transcription runs through the service set in Settings: a local Whisper server or a
          cloud one.
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-primary btn-sm" disabled={!hasMedia || !!busy} onClick={() => executeOps([{ op: "generateCaptions" }])}>
              Transcribe and add captions
            </button>
          </div>
        </div>
      ) : (
        <div className="field">
          <span>Show captions</span>
          <div className="seg" role="group">
            <button aria-pressed={captions.enabled} onClick={() => set({ op: "setCaptions", enabled: true })}>
              On
            </button>
            <button aria-pressed={!captions.enabled} onClick={() => set({ op: "setCaptions", enabled: false })}>
              Off
            </button>
          </div>
        </div>
      )}
      <div className="section-label">Style</div>
      <div className="preset-grid" style={{ marginBottom: 16 }}>
        {CAPTION_PRESETS.map((p) => (
          <button key={p.id} className="preset" aria-pressed={captions.preset === p.id} title={p.hint} onClick={() => set({ op: "setCaptions", preset: p.id })}>
            <span className="preset-sample">
              <span style={presetStyle(p.id, brand)}>
                {p.id === "karaoke" ? (
                  <>
                    <span style={{ color: brand.primary }}>say it </span>
                    <span style={{ opacity: 0.55 }}>loud</span>
                  </>
                ) : p.id === "bold-pop" ? (
                  <>
                    say it <span style={{ color: brand.primary }}>loud</span>
                  </>
                ) : (
                  "Say it loud"
                )}
              </span>
            </span>
            <span className="preset-name">{p.label}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <span>Position</span>
        <div className="seg" role="group">
          {(["top", "middle", "bottom"] as const).map((pos) => (
            <button key={pos} aria-pressed={captions.position === pos} onClick={() => set({ op: "setCaptions", position: pos })} style={{ textTransform: "capitalize" }}>
              {pos}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>
          Words per caption <span className="tabular" style={{ color: "var(--text)" }}>{captions.maxWords}</span>
        </span>
        <input
          type="range"
          min={1}
          max={8}
          value={captions.maxWords}
          style={{ accentColor: "var(--accent)" }}
          onChange={(e) => {
            const p = structuredClone(getState().project);
            p.captions.maxWords = +e.target.value;
            p.updatedAt = Date.now();
            commit(p);
          }}
        />
      </label>
      {hasTranscript && (
        <button className="btn btn-sm" onClick={downloadSRT}>
          <PiFileText size={14} /> Download .srt
        </button>
      )}
    </>
  );
}
