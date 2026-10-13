// Timeline operations. Every edit — from the AI agent or from a human dragging
// a clip — goes through these pure functions, so the agent can never produce
// something the user can't inspect and change by hand.

import type {
  AspectRatio,
  CaptionPreset,
  Clip,
  MediaClip,
  Project,
  TextClip,
  TextRole,
  Track,
} from "./types";

export type Op =
  | { op: "split"; at: number }
  | { op: "deleteClip"; clipId: string }
  | { op: "deleteRange"; start: number; end: number }
  | { op: "keepRanges"; ranges: { start: number; end: number }[] }
  | { op: "trim"; clipId: string; start?: number; end?: number }
  | { op: "move"; clipId: string; start: number }
  | { op: "addText"; text: string; start: number; duration: number; role?: TextRole }
  | { op: "updateText"; clipId: string; text?: string; start?: number; duration?: number; role?: TextRole }
  | { op: "setVolume"; clipId?: string; volume: number }
  | { op: "setAspect"; aspect: AspectRatio }
  | { op: "setCaptions"; enabled?: boolean; preset?: CaptionPreset; position?: "bottom" | "middle" | "top" }
  | { op: "applyBrand"; primary?: string; accent?: string; text?: string; font?: string; fit?: "cover" | "contain-blur" }
  // Async ops: need media analysis or network, so the executor runs them, not this reducer.
  | { op: "removeSilence"; thresholdDb?: number; minDuration?: number; padding?: number }
  | { op: "generateCaptions"; preset?: CaptionPreset };

export const ASYNC_OPS = new Set(["removeSilence", "generateCaptions"]);

const EPS = 1e-4;

export const uid = (p = "c") => `${p}_${Math.random().toString(36).slice(2, 9)}`;

export const clipEnd = (c: Clip) => (c.type === "media" ? c.start + (c.out - c.in) : c.start + c.duration);
export const clipDuration = (c: Clip) => clipEnd(c) - c.start;

export function projectDuration(p: Project): number {
  let d = 0;
  for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function findClip(p: Project, id: string): { track: Track; clip: Clip } | undefined {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, clip };
  }
  return undefined;
}

const clone = <T>(v: T): T => structuredClone(v);
const sortClips = (t: Track) => t.clips.sort((a, b) => a.start - b.start);

/** Split one clip at timeline time `at`, returning [left, right] (or null if `at` is outside). */
function splitClip(c: Clip, at: number): [Clip, Clip] | null {
  if (at <= c.start + EPS || at >= clipEnd(c) - EPS) return null;
  if (c.type === "media") {
    const srcAt = c.in + (at - c.start);
    return [
      { ...c, out: srcAt },
      { ...c, id: uid(), start: at, in: srcAt },
    ];
  }
  const leftDur = at - c.start;
  return [
    { ...c, duration: leftDur },
    { ...c, id: uid(), start: at, duration: c.duration - leftDur },
  ];
}

/** Remove timeline span [start, end) from video+audio tracks and close the gap (ripple delete). */
function rippleDelete(p: Project, start: number, end: number) {
  const span = end - start;
  if (span <= EPS) return;
  for (const t of p.tracks) {
    const next: Clip[] = [];
    for (const c of t.clips) {
      let pieces: Clip[] = [c];
      for (const at of [start, end]) {
        pieces = pieces.flatMap((x) => splitClip(x, at) ?? [x]);
      }
      for (const piece of pieces) {
        const s = piece.start;
        const e = clipEnd(piece);
        if (s >= start - EPS && e <= end + EPS) continue; // inside deleted span
        if (s >= end - EPS) piece.start = s - span; // after: shift left
        next.push(piece);
      }
    }
    t.clips = next;
    sortClips(t);
  }
}

/** Snap a value to 3 decimals so floating noise doesn't accumulate across many edits. */
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function applyOp(project: Project, op: Op): Project {
  const p = clone(project);
  switch (op.op) {
    case "split": {
      for (const t of p.tracks) {
        if (t.kind === "text") continue;
        t.clips = t.clips.flatMap((c) => splitClip(c, op.at) ?? [c]);
        sortClips(t);
      }
      break;
    }
    case "deleteClip": {
      const hit = findClip(p, op.clipId);
      if (!hit) throw new Error(`No clip ${op.clipId}`);
      if (hit.track.kind === "text") {
        hit.track.clips = hit.track.clips.filter((c) => c.id !== op.clipId);
      } else {
        rippleDelete(p, hit.clip.start, clipEnd(hit.clip));
      }
      break;
    }
    case "deleteRange": {
      const s = Math.max(0, Math.min(op.start, op.end));
      const e = Math.max(op.start, op.end);
      rippleDelete(p, s, e);
      break;
    }
    case "keepRanges": {
      const dur = projectDuration(p);
      const ranges = op.ranges
        .map((r) => ({ start: Math.max(0, r.start), end: Math.min(dur, r.end) }))
        .filter((r) => r.end - r.start > EPS)
        .sort((a, b) => a.start - b.start);
      if (!ranges.length) throw new Error("keepRanges needs at least one non-empty range");
      // Delete the complement, right to left so earlier times stay valid.
      const gaps: { start: number; end: number }[] = [];
      let cursor = 0;
      for (const r of ranges) {
        if (r.start > cursor + EPS) gaps.push({ start: cursor, end: r.start });
        cursor = Math.max(cursor, r.end);
      }
      if (dur > cursor + EPS) gaps.push({ start: cursor, end: dur });
      for (const g of gaps.reverse()) rippleDelete(p, g.start, g.end);
      break;
    }
    case "trim": {
      const hit = findClip(p, op.clipId);
      if (!hit) throw new Error(`No clip ${op.clipId}`);
      const c = hit.clip;
      const asset = c.type === "media" ? p.assets.find((a) => a.id === c.assetId) : undefined;
      if (op.start !== undefined) {
        const delta = op.start - c.start;
        if (c.type === "media") {
          const newIn = Math.max(0, Math.min(c.out - 0.05, c.in + delta));
          c.start = r3(c.start + (newIn - c.in));
          c.in = r3(newIn);
        } else {
          const newDur = c.duration - delta;
          if (newDur > 0.05) {
            c.start = r3(op.start);
            c.duration = r3(newDur);
          }
        }
      }
      if (op.end !== undefined) {
        if (c.type === "media") {
          const max = asset?.kind === "image" ? Infinity : asset?.duration ?? Infinity;
          c.out = r3(Math.max(c.in + 0.05, Math.min(max, c.in + (op.end - c.start))));
        } else {
          c.duration = r3(Math.max(0.05, op.end - c.start));
        }
      }
      sortClips(hit.track);
      break;
    }
    case "move": {
      const hit = findClip(p, op.clipId);
      if (!hit) throw new Error(`No clip ${op.clipId}`);
      hit.clip.start = r3(Math.max(0, op.start));
      sortClips(hit.track);
      break;
    }
    case "addText": {
      let track = p.tracks.find((t) => t.kind === "text");
      if (!track) {
        track = { id: uid("t"), kind: "text", name: "Text", clips: [] };
        p.tracks.splice(0, 0, track);
      }
      const clip: TextClip = {
        id: uid(),
        type: "text",
        text: op.text.slice(0, 200),
        start: r3(Math.max(0, op.start)),
        duration: r3(Math.max(0.3, op.duration)),
        role: op.role ?? "title",
      };
      track.clips.push(clip);
      sortClips(track);
      break;
    }
    case "updateText": {
      const hit = findClip(p, op.clipId);
      if (!hit || hit.clip.type !== "text") throw new Error(`No text clip ${op.clipId}`);
      const c = hit.clip;
      if (op.text !== undefined) c.text = op.text.slice(0, 200);
      if (op.start !== undefined) c.start = r3(Math.max(0, op.start));
      if (op.duration !== undefined) c.duration = r3(Math.max(0.3, op.duration));
      if (op.role !== undefined) c.role = op.role;
      sortClips(hit.track);
      break;
    }
    case "setVolume": {
      const v = Math.max(0, Math.min(1, op.volume));
      for (const t of p.tracks)
        for (const c of t.clips)
          if (c.type === "media" && (!op.clipId || c.id === op.clipId)) (c as MediaClip).volume = v;
      break;
    }
    case "setAspect":
      p.aspect = op.aspect;
      break;
    case "setCaptions":
      if (op.enabled !== undefined) p.captions.enabled = op.enabled;
      if (op.preset) p.captions.preset = op.preset;
      if (op.position) p.captions.position = op.position;
      break;
    case "applyBrand":
      for (const k of ["primary", "accent", "text", "font", "fit"] as const) {
        if (op[k] !== undefined) (p.brand as any)[k] = op[k];
      }
      break;
    default:
      throw new Error(`"${(op as Op).op}" must be run by the executor`);
  }
  p.updatedAt = Date.now();
  return p;
}

/** Convert source-time silent ranges for a clip's asset into timeline ranges. */
export function sourceRangesToTimeline(
  p: Project,
  assetId: string,
  ranges: { start: number; end: number }[],
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const t of p.tracks) {
    if (t.kind !== "video" && t.kind !== "audio") continue;
    for (const c of t.clips) {
      if (c.type !== "media" || c.assetId !== assetId) continue;
      for (const r of ranges) {
        const s = Math.max(r.start, c.in);
        const e = Math.min(r.end, c.out);
        if (e - s > EPS) out.push({ start: c.start + (s - c.in), end: c.start + (e - c.in) });
      }
    }
  }
  // Merge overlaps so we never double-delete.
  out.sort((a, b) => a.start - b.start);
  const merged: typeof out = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Delete many timeline ranges at once (right to left). */
export function deleteRanges(p: Project, ranges: { start: number; end: number }[]): Project {
  let next = p;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    next = applyOp(next, { op: "deleteRange", start: r.start, end: r.end });
  }
  return next;
}

/** Light runtime validation for ops coming from a model. Returns the ops it could make sense of. */
export function sanitizeOps(raw: unknown): { ops: Op[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const ops: Op[] = [];
  let dropped = 0;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  for (const o of list) {
    if (!o || typeof o !== "object" || typeof (o as any).op !== "string") {
      dropped++;
      continue;
    }
    const x = o as any;
    const ok = (() => {
      switch (x.op) {
        case "split":
          return num(x.at);
        case "deleteClip":
        case "move":
        case "trim":
        case "updateText":
          return typeof x.clipId === "string" && (x.op !== "move" || num(x.start));
        case "deleteRange":
          return num(x.start) && num(x.end);
        case "keepRanges":
          return Array.isArray(x.ranges) && x.ranges.every((r: any) => num(r?.start) && num(r?.end));
        case "addText":
          return typeof x.text === "string" && num(x.start) && num(x.duration);
        case "setVolume":
          return num(x.volume);
        case "setAspect":
          return ["16:9", "9:16", "1:1", "4:5"].includes(x.aspect);
        case "setCaptions":
        case "applyBrand":
        case "removeSilence":
        case "generateCaptions":
          return true;
        default:
          return false;
      }
    })();
    if (ok) ops.push(x as Op);
    else dropped++;
  }
  return { ops, dropped };
}

export function describeOp(op: Op): string {
  const t = (n: number) => `${n.toFixed(1)}s`;
  switch (op.op) {
    case "split":
      return `Split at ${t(op.at)}`;
    case "deleteClip":
      return "Deleted a clip";
    case "deleteRange":
      return `Cut ${t(op.start)}-${t(op.end)}`;
    case "keepRanges":
      return `Kept ${op.ranges.length} section${op.ranges.length === 1 ? "" : "s"}`;
    case "trim":
      return "Trimmed a clip";
    case "move":
      return `Moved a clip to ${t(op.start)}`;
    case "addText":
      return `Added "${op.text.slice(0, 28)}${op.text.length > 28 ? "…" : ""}"`;
    case "updateText":
      return "Edited text";
    case "setVolume":
      return `Volume ${Math.round(op.volume * 100)}%`;
    case "setAspect":
      return `Aspect ${op.aspect}`;
    case "setCaptions":
      return op.enabled === false ? "Captions off" : `Captions${op.preset ? ` · ${op.preset}` : ""}`;
    case "applyBrand":
      return "Applied brand kit";
    case "removeSilence":
      return "Removed silences";
    case "generateCaptions":
      return "Generated captions";
  }
}
