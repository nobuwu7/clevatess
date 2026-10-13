import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  PiWaveform,
  PiClosedCaptioning,
  PiScissors,
  PiTrash,
  PiTextT,
  PiVideoCamera,
  PiMagicWand,
  PiMagnifyingGlassPlus,
  PiMagnifyingGlassMinus,
  PiMagnet,
  PiX,
} from "react-icons/pi";
import { decodeAsset, peaks } from "../engine/audio";
import { applyOp, clipEnd, projectDuration, type Op } from "../engine/ops";
import type { Clip, Project, Track } from "../engine/types";
import { getBlob } from "../lib/db";
import { executeOps } from "../store/actions";
import { commit, getState, setState, useStore } from "../store/store";
import { shortTime } from "./format";
import { seek } from "./playback";

const TRACK_H: Record<Track["kind"], number> = { text: 34, video: 58, audio: 44 };
const SNAP_PX = 8;

type Drag = {
  clipId: string;
  trackId: string;
  mode: "move" | "l" | "r";
  x0: number;
  orig: { start: number; end: number };
  start: number;
  end: number;
  moved: boolean;
  snapAt: number | null;
};

// Waveform peaks, computed once per asset.
const peakCache = new Map<string, Float32Array | "pending" | "none">();
const PEAKS_PER_SEC = 24;

function useAssetPeaks(assetId: string, enabled: boolean): Float32Array | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!enabled || peakCache.has(assetId)) return;
    peakCache.set(assetId, "pending");
    (async () => {
      const blob = await getBlob(assetId);
      if (!blob) return peakCache.set(assetId, "none");
      try {
        const buf = await decodeAsset(assetId, blob);
        peakCache.set(assetId, peaks(buf, Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SEC))));
      } catch {
        peakCache.set(assetId, "none");
      }
      force((n) => n + 1);
    })();
  }, [assetId, enabled]);
  const v = peakCache.get(assetId);
  return v instanceof Float32Array ? v : null;
}

function niceStep(pxPerSec: number): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * pxPerSec >= 72) ?? 600;
}

export function Timeline() {
  const project = useStore((s) => s.project);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const selected = useStore((s) => s.selectedClipId);
  const busy = useStore((s) => s.busy);
  const seams = useStore((s) => s.seams);
  const seamsKey = useStore((s) => s.seamsKey);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snap, setSnap] = useState(true);
  const dur = projectDuration(project);
  const [viewW, setViewW] = useState(800);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const contentW = Math.max(viewW, (dur + 8) * pxPerSec);
  const step = niceStep(pxPerSec);

  // Keep the playhead on screen while playing.
  useEffect(() => {
    let raf = 0;
    const follow = () => {
      const el = scrollRef.current;
      const s = getState();
      if (el && s.playing) {
        const x = s.playhead * s.pxPerSec;
        if (x > el.scrollLeft + el.clientWidth - 60) el.scrollLeft = x - 60;
        else if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Ctrl/⌘ + wheel zooms around the cursor.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const s = getState();
      const tAtCursor = (el.scrollLeft + e.clientX - rect.left) / s.pxPerSec;
      const next = Math.min(400, Math.max(8, s.pxPerSec * Math.exp(-e.deltaY * 0.01)));
      setState({ pxPerSec: next });
      requestAnimationFrame(() => (el.scrollLeft = tAtCursor * next - (e.clientX - rect.left)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const snapPoints = useMemo(() => {
    const pts: number[] = [0];
    for (const t of project.tracks) for (const c of t.clips) pts.push(c.start, clipEnd(c));
    return pts;
  }, [project]);

  const timeFromEvent = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / pxPerSec);
  };

  const scrub = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seek(Math.min(dur, timeFromEvent(e.clientX)));
    const move = (ev: PointerEvent) => seek(Math.min(dur, timeFromEvent(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const beginDrag = (e: React.PointerEvent, track: Track, clip: Clip, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setState({ selectedClipId: clip.id });
    const d: Drag = {
      clipId: clip.id,
      trackId: track.id,
      mode,
      x0: e.clientX,
      orig: { start: clip.start, end: clipEnd(clip) },
      start: clip.start,
      end: clipEnd(clip),
      moved: false,
      snapAt: null,
    };
    setDrag(d);
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 3) return;
    const dt = dx / pxPerSec;
    const others = snap ? snapPoints.filter((p) => Math.abs(p - drag.orig.start) > 1e-6 && Math.abs(p - drag.orig.end) > 1e-6) : [];
    if (snap) others.push(getState().playhead);
    const tol = SNAP_PX / pxPerSec;
    const snapTo = (t: number) => {
      let best: number | null = null;
      for (const p of others) if (Math.abs(p - t) < tol && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
      return best;
    };
    let { start, end } = drag.orig;
    let snapAt: number | null = null;
    if (drag.mode === "move") {
      start = Math.max(0, drag.orig.start + dt);
      const len = drag.orig.end - drag.orig.start;
      const s1 = snapTo(start);
      const s2 = snapTo(start + len);
      if (s1 !== null) {
        start = s1;
        snapAt = s1;
      } else if (s2 !== null) {
        start = s2 - len;
        snapAt = s2;
      }
      end = start + len;
    } else if (drag.mode === "l") {
      start = Math.min(drag.orig.end - 0.1, Math.max(0, drag.orig.start + dt));
      const s = snapTo(start);
      if (s !== null && s < drag.orig.end - 0.1) (start = s), (snapAt = s);
    } else {
      end = Math.max(drag.orig.start + 0.1, drag.orig.end + dt);
      const s = snapTo(end);
      if (s !== null && s > drag.orig.start + 0.1) (end = s), (snapAt = s);
    }
    setDrag({ ...drag, start, end, moved: true, snapAt });
  };

  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) return;
    const p = getState().project;
    try {
      if (d.mode === "move") commit(applyOp(p, { op: "move", clipId: d.clipId, start: d.start }));
      else if (d.mode === "l") commit(applyOp(p, { op: "trim", clipId: d.clipId, start: d.start }));
      else commit(applyOp(p, { op: "trim", clipId: d.clipId, end: d.end }));
    } catch {
      /* clip vanished mid-drag (e.g. agent edit) */
    }
  };

  const run = (ops: Op[]) => executeOps(ops);
  const playhead = getState().playhead;

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="tl-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => run([{ op: "split", at: getState().playhead }])} disabled={!dur} title="Split at playhead (S)">
          <PiScissors size={14} /> Split
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => selected && run([{ op: "deleteClip", clipId: selected }])}
          disabled={!selected}
          title="Delete selected (⌫)"
        >
          <PiTrash size={14} /> Delete
        </button>
        <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px" }} />
        <button className="btn btn-ghost btn-sm" onClick={() => executeOps([{ op: "removeSilence" }], { mark: true })} disabled={!dur || !!busy} title="Cut silent gaps">
          <PiMagicWand size={14} /> Cut silences
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => run([{ op: "addText", text: "Your title", start: getState().playhead, duration: 3, role: "title" }])}
          disabled={!dur}
        >
          <PiTextT size={14} /> Text
        </button>
        <button className="btn btn-ghost btn-sm hide-sm" onClick={() => setState({ side: "captions" })} disabled={!dur}>
          <PiClosedCaptioning size={14} /> Captions
        </button>
        <span style={{ flex: 1 }} />
        {seams.length > 0 && (
          <span className="seam-legend hide-sm" title="Where the last automatic edit cut your footage">
            <i />
            {seams.length} new cut{seams.length === 1 ? "" : "s"}
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Hide cut marks" onClick={() => setState({ seams: [] })} style={{ width: 22, height: 22 }}>
              <PiX size={12} />
            </button>
          </span>
        )}
        <button
          className="btn btn-ghost btn-icon btn-sm"
          aria-pressed={snap}
          title={snap ? "Snapping on" : "Snapping off"}
          onClick={() => setSnap(!snap)}
          style={{ color: snap ? "var(--accent)" : undefined }}
        >
          <PiMagnet size={14} />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Zoom out" onClick={() => setState({ pxPerSec: Math.max(8, pxPerSec / 1.5) })}>
          <PiMagnifyingGlassMinus size={14} />
        </button>
        <input
          className="zoom hide-sm"
          type="range"
          min={8}
          max={400}
          value={pxPerSec}
          aria-label="Zoom"
          onChange={(e) => setState({ pxPerSec: +e.target.value })}
        />
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Zoom in" onClick={() => setState({ pxPerSec: Math.min(400, pxPerSec * 1.5) })}>
          <PiMagnifyingGlassPlus size={14} />
        </button>
      </div>
      <div className="tl-body">
        <div className="tl-heads">
          {project.tracks.map((t) => (
            <div className="tl-head" key={t.id} style={{ ["--track-h" as any]: `${TRACK_H[t.kind]}px` }}>
              {t.kind === "video" ? <PiVideoCamera size={13} /> : t.kind === "audio" ? <PiWaveform size={13} /> : <PiTextT size={13} />}
              {t.name}
            </div>
          ))}
        </div>
        <div className="tl-scroll" ref={scrollRef} onPointerDown={(e) => e.target === e.currentTarget && setState({ selectedClipId: null })}>
          <div className="tl-content" style={{ width: contentW }}>
            <div className="ruler" onPointerDown={scrub}>
              {Array.from({ length: Math.ceil(contentW / pxPerSec / step) + 1 }, (_, i) => (
                <span key={i} className="tick tabular" style={{ left: i * step * pxPerSec }}>
                  {shortTime(i * step)}
                </span>
              ))}
              {Array.from({ length: Math.ceil(contentW / pxPerSec / step) }, (_, i) => (
                <span key={`m${i}`} className="tick minor" style={{ left: (i + 0.5) * step * pxPerSec }} />
              ))}
            </div>
            {project.tracks.map((t) => (
              <div
                key={t.id}
                className="track"
                style={{ ["--track-h" as any]: `${TRACK_H[t.kind]}px` }}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  setState({ selectedClipId: null });
                  scrub(e);
                }}
              >
                {t.clips.map((c) => {
                  const live = drag?.clipId === c.id ? drag : null;
                  const start = live ? live.start : c.start;
                  const end = live ? live.end : clipEnd(c);
                  return (
                    <ClipView
                      key={c.id}
                      clip={c}
                      track={t}
                      project={project}
                      left={start * pxPerSec}
                      width={Math.max(4, (end - start) * pxPerSec)}
                      pxPerSec={pxPerSec}
                      trimIn={live && live.mode === "l" && c.type === "media" ? c.in + (live.start - live.orig.start) : undefined}
                      selected={selected === c.id}
                      dragging={!!live?.moved}
                      onDown={(e, mode) => beginDrag(e, t, c, mode)}
                      onMove={onDragMove}
                      onUp={endDrag}
                    />
                  );
                })}
              </div>
            ))}
            {!dur && <div className="tl-empty">Clips you add land here.</div>}
            {seams.map((t, i) => (
              <div key={`${seamsKey}-${i}`} className="seam" data-fresh style={{ left: t * pxPerSec, animationDelay: `${Math.min(i, 12) * 30}ms` }} />
            ))}
            {drag?.snapAt != null && <div className="snap-line" style={{ left: drag.snapAt * pxPerSec }} />}
            <Playhead pxPerSec={pxPerSec} onScrub={scrub} initial={playhead} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Playhead({ pxPerSec, onScrub }: { pxPerSec: number; onScrub: (e: React.PointerEvent) => void; initial: number }) {
  const t = useStore((s) => s.playhead);
  return (
    <div className="playhead" style={{ transform: `translateX(${t * pxPerSec}px)` }}>
      <div className="playhead-knob" onPointerDown={onScrub} />
    </div>
  );
}

interface ClipProps {
  clip: Clip;
  track: Track;
  project: Project;
  left: number;
  width: number;
  pxPerSec: number;
  trimIn?: number;
  selected: boolean;
  dragging: boolean;
  onDown: (e: React.PointerEvent, mode: Drag["mode"]) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: () => void;
}

const ClipView = memo(function ClipView(p: ClipProps) {
  const { clip, track } = p;
  const asset = clip.type === "media" ? p.project.assets.find((a) => a.id === clip.assetId) : undefined;
  const label = clip.type === "text" ? clip.text : asset?.name ?? "Missing media";
  const kindClass = track.kind === "text" ? "clip-text" : track.kind === "audio" ? "clip-audio" : "clip-video";
  return (
    <div
      className={`clip ${kindClass}${p.selected ? " selected" : ""}${p.dragging ? " dragging" : ""}`}
      style={{ transform: `translateX(${p.left}px)`, width: p.width }}
      onPointerDown={(e) => p.onDown(e, "move")}
      onPointerMove={p.onMove}
      onPointerUp={p.onUp}
      onPointerCancel={p.onUp}
      onDoubleClick={() => seek(clip.start)}
      role="button"
      aria-label={`${track.kind} clip ${label}`}
      aria-pressed={p.selected}
    >
      {clip.type === "media" && asset?.kind === "video" && (
        <Filmstrip assetId={asset.id} inPoint={p.trimIn ?? clip.in} width={p.width} pxPerSec={p.pxPerSec} />
      )}
      {clip.type === "media" && asset?.kind === "image" && <ImageStrip assetId={asset.id} />}
      {clip.type === "media" && track.kind === "audio" && (
        <Wave assetId={clip.assetId} inPoint={p.trimIn ?? clip.in} width={p.width} pxPerSec={p.pxPerSec} />
      )}
      <span className="clip-label">{label}</span>
      <span className="handle l" onPointerDown={(e) => p.onDown(e, "l")} />
      <span className="handle r" onPointerDown={(e) => p.onDown(e, "r")} />
    </div>
  );
});

function Filmstrip({ assetId, inPoint, width, pxPerSec }: { assetId: string; inPoint: number; width: number; pxPerSec: number }) {
  const thumbs = useStore((s) => s.thumbs[assetId]);
  const stepSec = useStore((s) => s.thumbStep[assetId]);
  if (!thumbs?.length || !stepSec) return null;
  const thumbW = 56 * (16 / 9) * 0.9; // approx; thumbnails keep their own ratio via object-fit
  const count = Math.max(1, Math.ceil(width / thumbW));
  return (
    <div className="filmstrip">
      {Array.from({ length: count }, (_, i) => {
        const t = inPoint + (i * thumbW) / pxPerSec;
        const idx = Math.min(thumbs.length - 1, Math.max(0, Math.floor(t / stepSec)));
        return <img key={i} src={thumbs[idx]} alt="" style={{ width: thumbW }} draggable={false} />;
      })}
    </div>
  );
}

function ImageStrip({ assetId }: { assetId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    getBlob(assetId).then((b) => b && setUrl((u = URL.createObjectURL(b))));
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [assetId]);
  if (!url) return null;
  return <div className="filmstrip" style={{ background: `url(${url}) left center / auto 100% repeat-x` }} />;
}

function Wave({ assetId, inPoint, width, pxPerSec }: { assetId: string; inPoint: number; width: number; pxPerSec: number }) {
  const data = useAssetPeaks(assetId, true);
  const path = useMemo(() => {
    if (!data) return "";
    const h = 36;
    const mid = h / 2;
    let d = "";
    const step = 2;
    for (let x = 0; x < width; x += step) {
      const t = inPoint + x / pxPerSec;
      const v = data[Math.floor(t * PEAKS_PER_SEC)] ?? 0;
      const a = Math.max(0.5, Math.min(mid - 2, v * mid * 1.6));
      d += `M${x} ${mid - a}V${mid + a}`;
    }
    return d;
  }, [data, inPoint, width, pxPerSec]);
  if (!path) return null;
  return (
    <svg className="wave" viewBox={`0 0 ${width} 36`} preserveAspectRatio="none" style={{ top: 4, height: "calc(100% - 8px)" }}>
      <path d={path} stroke="var(--wave)" strokeWidth={1.2} strokeLinecap="round" opacity={0.85} />
    </svg>
  );
}
