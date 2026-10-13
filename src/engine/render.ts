// Draws one frame of a project at timeline time `t` onto a 2D canvas.
// Used by both the live preview and the exporter, so what you see is what you export.

import { buildCues, timelineWords, type Cue } from "./captions";
import { clipEnd } from "./ops";
import type { MediaClip, Project, TextClip } from "./types";
import { ASPECTS } from "./types";

export type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

export interface RenderSources {
  get(assetId: string): MediaEl | undefined;
}

// Cache cues per project revision; recomputing every frame is wasteful.
let cueCache: { key: string; cues: Cue[] } | null = null;
function cuesFor(p: Project): Cue[] {
  const key = `${p.id}:${p.updatedAt}:${p.captions.maxWords}:${p.transcripts.length}`;
  if (cueCache?.key === key) return cueCache.cues;
  const cues = buildCues(timelineWords(p), p.captions.maxWords);
  cueCache = { key, cues };
  return cues;
}

const blurCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;

function drawFitted(
  ctx: CanvasRenderingContext2D,
  el: CanvasImageSource,
  sw: number,
  sh: number,
  W: number,
  H: number,
  fit: "cover" | "contain-blur",
) {
  if (!sw || !sh) return;
  const cover = Math.max(W / sw, H / sh);
  const contain = Math.min(W / sw, H / sh);
  const sameShape = Math.abs(sw / sh - W / H) < 0.02;
  if (fit === "cover" || sameShape) {
    const w = sw * cover;
    const h = sh * cover;
    ctx.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
    return;
  }
  // Blurred backdrop: downscale to a tiny canvas and scale back up. Cheap, and works
  // in every browser (ctx.filter isn't universal).
  if (blurCanvas) {
    const bw = 24;
    const bh = Math.max(1, Math.round((bw * H) / W));
    blurCanvas.width = bw;
    blurCanvas.height = bh;
    const b = blurCanvas.getContext("2d")!;
    const bc = Math.max(bw / sw, bh / sh);
    b.drawImage(el, (bw - sw * bc) / 2, (bh - sh * bc) / 2, sw * bc, sh * bc);
    ctx.save();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(blurCanvas, 0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  const w = sw * contain;
  const h = sh * contain;
  ctx.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
}

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawText(ctx: CanvasRenderingContext2D, c: TextClip, t: number, p: Project, W: number, H: number, still: boolean) {
  const local = t - c.start;
  // A paused frame shows the settled state; entrance/exit motion only plays back.
  const fadeIn = still ? 1 : easeOut(local / 0.25);
  const fadeOut = still ? 1 : easeOut((c.duration - local) / 0.2);
  const a = Math.min(fadeIn, fadeOut);
  const lift = (1 - fadeIn) * H * 0.012;
  const u = Math.min(W, H);
  const { brand } = p;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textBaseline = "alphabetic";
  if (c.role === "title") {
    const size = u * 0.085;
    ctx.font = `700 ${size}px "${brand.font}", system-ui, sans-serif`;
    ctx.textAlign = "center";
    const lines = wrap(ctx, c.text, W * 0.82);
    const lh = size * 1.08;
    const total = lines.length * lh;
    let y = H / 2 - total / 2 + size * 0.8 + lift;
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = size * 0.4;
    ctx.fillStyle = brand.text;
    for (const l of lines) {
      ctx.fillText(l, W / 2, y);
      y += lh;
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = brand.primary;
    const bar = u * 0.08 * fadeIn;
    roundRect(ctx, W / 2 - bar / 2, y - lh + size * 0.45, bar, u * 0.008, u * 0.004);
    ctx.fill();
  } else if (c.role === "lower-third") {
    const size = u * 0.042;
    ctx.font = `600 ${size}px "${brand.font}", system-ui, sans-serif`;
    ctx.textAlign = "left";
    const tw = Math.min(ctx.measureText(c.text).width, W * 0.7);
    const padX = size * 0.7;
    const x = W * 0.06;
    const y = H * 0.82 + lift;
    ctx.fillStyle = brand.primary;
    roundRect(ctx, x, y - size * 1.25, (tw + padX * 2) * (still ? 1 : easeOut(local / 0.3)), size * 1.8, size * 0.25);
    ctx.fill();
    ctx.fillStyle = contrastOn(brand.primary);
    ctx.fillText(c.text, x + padX, y, W * 0.7);
  } else {
    const size = u * 0.036;
    ctx.font = `600 ${size}px "${brand.font}", system-ui, sans-serif`;
    ctx.textAlign = "center";
    const tw = Math.min(ctx.measureText(c.text).width, W * 0.8);
    const y = H * 0.12 + lift;
    ctx.fillStyle = brand.accent;
    roundRect(ctx, W / 2 - tw / 2 - size * 0.7, y - size * 1.15, tw + size * 1.4, size * 1.65, size * 0.82);
    ctx.fill();
    ctx.fillStyle = contrastOn(brand.accent);
    ctx.fillText(c.text, W / 2, y, W * 0.8);
  }
  ctx.restore();
}

/** Black or white, whichever reads better on `hex`. */
export function contrastOn(hex: string): string {
  const m = hex.replace("#", "");
  const n = parseInt(m.length === 3 ? m.replace(/./g, "$&$&") : m, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.58 ? "#0B0B0A" : "#FFFFFF";
}

function drawCaptions(ctx: CanvasRenderingContext2D, p: Project, t: number, W: number, H: number, still: boolean) {
  if (!p.captions.enabled) return;
  const cue = cuesFor(p).find((c) => t >= c.start && t < c.end);
  if (!cue) return;
  const { brand, captions } = p;
  const u = Math.min(W, H);
  const preset = captions.preset;
  const yBase = captions.position === "top" ? H * 0.16 : captions.position === "middle" ? H * 0.55 : H * 0.84;
  const big = preset === "bold-pop" || preset === "karaoke" || preset === "boxed";
  const size = u * (big ? 0.062 : preset === "minimal" ? 0.036 : 0.048);
  const weight = preset === "minimal" ? 500 : preset === "editorial" ? 400 : big ? 800 : 600;
  const family =
    preset === "editorial" ? `"Playfair Display", Georgia, serif` : `"${brand.font}", system-ui, sans-serif`;
  const style = preset === "editorial" ? "italic " : "";
  ctx.save();
  ctx.font = `${style}${weight} ${size}px ${family}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const fmt = (s: string) =>
    preset === "bold-pop" || preset === "boxed" ? s.toUpperCase() : preset === "minimal" ? s.toLowerCase() : s;
  const words = cue.words.map((w) => ({ ...w, text: fmt(w.text) }));
  const space = ctx.measureText(" ").width;
  // Lay words into lines that fit 84% of the frame width.
  const maxW = W * 0.84;
  const lines: { w: (typeof words)[number]; width: number }[][] = [[]];
  let lineW = 0;
  for (const w of words) {
    const width = ctx.measureText(w.text).width;
    if (lineW + width > maxW && lines[lines.length - 1].length) {
      lines.push([]);
      lineW = 0;
    }
    lines[lines.length - 1].push({ w, width });
    lineW += width + space;
  }
  const lh = size * 1.18;
  // Pop the whole cue in on its first frames.
  const appear = still ? 1 : easeOut((t - cue.start) / 0.12);
  const scale = big ? 0.94 + 0.06 * appear : 1;
  ctx.translate(W / 2, yBase);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -yBase);
  let y = yBase - ((lines.length - 1) * lh) / 2;
  for (const line of lines) {
    const total = line.reduce((s, x) => s + x.width, 0) + space * (line.length - 1);
    let x = (W - total) / 2;
    if (preset === "boxed") {
      ctx.fillStyle = brand.primary;
      roundRect(ctx, x - size * 0.35, y - size * 0.95, total + size * 0.7, size * 1.3, size * 0.2);
      ctx.fill();
    }
    for (const { w, width } of line) {
      const active = t >= w.start && t < w.end + 0.05;
      const spoken = t >= w.start;
      let fill = brand.text;
      if (preset === "bold-pop" && active) fill = brand.primary;
      if (preset === "karaoke") fill = spoken ? brand.primary : "rgba(255,255,255,0.55)";
      if (preset === "boxed") fill = contrastOn(brand.primary);
      if (preset === "minimal") fill = "rgba(255,255,255,0.92)";
      if (big && preset !== "boxed") {
        ctx.lineJoin = "round";
        ctx.lineWidth = size * 0.16;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(w.text, x, y);
      } else if (preset !== "boxed") {
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = size * 0.35;
        ctx.shadowOffsetY = size * 0.04;
      }
      ctx.fillStyle = fill;
      ctx.fillText(w.text, x, y);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      x += width + space;
    }
    y += lh;
  }
  ctx.restore();
}

function drawLogo(ctx: CanvasRenderingContext2D, p: Project, src: RenderSources, W: number, H: number) {
  const id = p.brand.logoAssetId;
  if (!id) return;
  const el = src.get(id) as HTMLImageElement | undefined;
  if (!el || !(el instanceof HTMLImageElement) || !el.naturalWidth) return;
  const u = Math.min(W, H);
  const h = u * 0.075;
  const w = (el.naturalWidth / el.naturalHeight) * h;
  const m = u * 0.045;
  const pos = p.brand.logoPosition;
  const x = pos.endsWith("left") ? m : W - w - m;
  const y = pos.startsWith("top") ? m : H - h - m;
  ctx.save();
  ctx.globalAlpha = p.brand.logoOpacity;
  ctx.drawImage(el, x, y, w, h);
  ctx.restore();
}

export function activeMediaClips(p: Project, t: number): { clip: MediaClip; trackKind: string }[] {
  const out: { clip: MediaClip; trackKind: string }[] = [];
  for (const tr of p.tracks) {
    if (tr.kind === "text" || tr.muted) continue;
    for (const c of tr.clips) {
      if (c.type === "media" && t >= c.start && t < clipEnd(c)) out.push({ clip: c, trackKind: tr.kind });
    }
  }
  return out;
}

export function renderFrame(ctx: CanvasRenderingContext2D, p: Project, t: number, src: RenderSources, still = false) {
  const { w: W, h: H } = ASPECTS[p.aspect];
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  // Lower tracks first so tracks higher in the list sit on top.
  const visual = p.tracks.filter((tr) => tr.kind === "video").reverse();
  for (const tr of visual) {
    for (const c of tr.clips) {
      if (c.type !== "media" || t < c.start || t >= clipEnd(c)) continue;
      const el = src.get(c.assetId);
      if (!el) continue;
      if (el instanceof HTMLVideoElement) {
        if (el.readyState >= 2) drawFitted(ctx, el, el.videoWidth, el.videoHeight, W, H, p.brand.fit);
      } else if (el instanceof HTMLImageElement && el.naturalWidth) {
        drawFitted(ctx, el, el.naturalWidth, el.naturalHeight, W, H, p.brand.fit);
      }
    }
  }
  drawCaptions(ctx, p, t, W, H, still);
  for (const tr of p.tracks) {
    if (tr.kind !== "text") continue;
    for (const c of tr.clips) {
      if (c.type === "text" && t >= c.start && t < c.start + c.duration) drawText(ctx, c, t, p, W, H, still);
    }
  }
  drawLogo(ctx, p, src, W, H);
  ctx.restore();
}
