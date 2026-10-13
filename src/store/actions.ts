// User-level actions: importing media, running agent turns, executing ops.

import { runAgent, runTranscribe } from "../ai/client";
import type { ChatMessage } from "../ai/providers";
import { decodeAsset, findSilences, wavChunks } from "../engine/audio";
import { ASYNC_OPS, applyOp, clipEnd, deleteRanges, describeOp, projectDuration, sourceRangesToTimeline, uid, type Op } from "../engine/ops";
import { appendAsset } from "../engine/project";
import type { Asset, AssetKind, Project, Transcript } from "../engine/types";
import { deleteBlob, getBlob, putBlob } from "../lib/db";
import { toast } from "../ui/toast";
import { commit, getState, setState, type ChatEntry } from "./store";

// Import ----------------------------------------------------------------

function kindOf(file: File): AssetKind | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) return "audio";
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(file.name)) return "image";
  return null;
}

function probe(file: File, kind: AssetKind): Promise<{ duration: number; width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const done = (v: { duration: number; width?: number; height?: number }) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    if (kind === "image") {
      const img = new Image();
      img.onload = () => done({ duration: 4, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("Couldn't read that image"));
      img.src = url;
      return;
    }
    const el = document.createElement(kind === "video" ? "video" : "audio") as HTMLVideoElement;
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      // Some files report Infinity until the browser scans to the end.
      if (!Number.isFinite(el.duration)) {
        el.currentTime = 1e9;
        el.ontimeupdate = () => {
          el.ontimeupdate = null;
          done({ duration: el.duration, width: el.videoWidth, height: el.videoHeight });
        };
        return;
      }
      done({ duration: el.duration, width: el.videoWidth || undefined, height: el.videoHeight || undefined });
    };
    el.onerror = () => reject(new Error(`This browser can't play “${file.name}”`));
    el.src = url;
  });
}

/** Filmstrip thumbnails for timeline clips. */
async function makeThumbs(assetId: string, blob: Blob, duration: number) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  await new Promise<void>((r) => {
    v.onloadeddata = () => r();
    v.onerror = () => r();
  });
  if (!v.videoWidth) return URL.revokeObjectURL(url);
  const step = Math.max(1, duration / 40);
  const h = 56;
  const w = Math.round((v.videoWidth / v.videoHeight) * h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const out: string[] = [];
  for (let t = 0; t < duration; t += step) {
    await new Promise<void>((r) => {
      v.onseeked = () => r();
      v.currentTime = Math.min(duration - 0.05, t + 0.01);
    });
    ctx.drawImage(v, 0, 0, w, h);
    out.push(c.toDataURL("image/jpeg", 0.6));
    if (out.length % 8 === 0) setState((s) => ({ thumbs: { ...s.thumbs, [assetId]: [...out] }, thumbStep: { ...s.thumbStep, [assetId]: step } }));
  }
  setState((s) => ({ thumbs: { ...s.thumbs, [assetId]: out }, thumbStep: { ...s.thumbStep, [assetId]: step } }));
  URL.revokeObjectURL(url);
}

export async function importFiles(files: FileList | File[], opts: { asLogo?: boolean } = {}) {
  const list = [...files];
  let added = 0;
  setState((s) => ({ importing: s.importing + list.length }));
  const done = () => setState((s) => ({ importing: Math.max(0, s.importing - 1) }));
  for (const file of list) {
    const kind = kindOf(file);
    if (!kind) {
      toast(`Skipped “${file.name}”: not a video, audio or image file`, "error");
      done();
      continue;
    }
    try {
      const meta = await probe(file, kind);
      const asset: Asset = {
        id: uid("a"),
        name: file.name,
        kind,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        mime: file.type,
        size: file.size,
      };
      await putBlob(asset.id, file);
      const s = getState();
      if (opts.asLogo && kind === "image") {
        const p = structuredClone(s.project);
        p.assets.push(asset);
        p.brand.logoAssetId = asset.id;
        p.updatedAt = Date.now();
        commit(p);
      } else {
        commit(appendAsset(s.project, asset));
        if (kind === "video") makeThumbs(asset.id, file, meta.duration).catch(() => {});
      }
      added++;
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      done();
    }
  }
  if (added && !opts.asLogo) toast(`Added ${added} file${added === 1 ? "" : "s"}`);
}

export async function regenerateThumbs() {
  const { project, thumbs } = getState();
  for (const a of project.assets) {
    if (a.kind !== "video" || thumbs[a.id]) continue;
    const blob = await getBlob(a.id);
    if (blob) makeThumbs(a.id, blob, a.duration).catch(() => {});
  }
}

export async function removeAsset(assetId: string) {
  const s = getState();
  const p = structuredClone(s.project);
  p.assets = p.assets.filter((a) => a.id !== assetId);
  p.transcripts = p.transcripts.filter((t) => t.assetId !== assetId);
  for (const t of p.tracks) t.clips = t.clips.filter((c) => c.type !== "media" || c.assetId !== assetId);
  if (p.brand.logoAssetId === assetId) p.brand.logoAssetId = undefined;
  p.updatedAt = Date.now();
  commit(p);
  // Keep the blob while it's still reachable through undo history.
  const stillReferenced = s.past.some((h) => h.assets.some((a) => a.id === assetId));
  if (!stillReferenced) deleteBlob(assetId);
}

// Executor --------------------------------------------------------------

function speechAssets(p: Project): Asset[] {
  const used = new Set<string>();
  for (const t of p.tracks) for (const c of t.clips) if (c.type === "media") used.add(c.assetId);
  return p.assets.filter((a) => used.has(a.id) && (a.kind === "video" || a.kind === "audio"));
}

async function removeSilence(p: Project, op: Extract<Op, { op: "removeSilence" }>): Promise<Project> {
  let ranges: { start: number; end: number }[] = [];
  for (const a of speechAssets(p)) {
    const blob = await getBlob(a.id);
    if (!blob) continue;
    let buf: AudioBuffer;
    try {
      buf = await decodeAsset(a.id, blob);
    } catch {
      continue; // video without an audio track
    }
    const silent = findSilences(buf, op);
    ranges = ranges.concat(sourceRangesToTimeline(p, a.id, silent));
  }
  if (!ranges.length) {
    toast("No silences long enough to cut");
    return p;
  }
  const cut = ranges.reduce((n, r) => n + r.end - r.start, 0);
  toast(`Cut ${ranges.length} silence${ranges.length === 1 ? "" : "s"} · ${cut.toFixed(1)}s shorter`);
  return deleteRanges(p, ranges);
}

async function generateCaptions(p: Project, op: Extract<Op, { op: "generateCaptions" }>, signal?: AbortSignal): Promise<Project> {
  const next = structuredClone(p);
  const { settings } = getState();
  for (const a of speechAssets(p)) {
    if (next.transcripts.some((t) => t.assetId === a.id)) continue;
    const blob = await getBlob(a.id);
    if (!blob) continue;
    let buf: AudioBuffer;
    try {
      buf = await decodeAsset(a.id, blob);
    } catch {
      continue;
    }
    const chunks = await wavChunks(buf, 90);
    const transcript: Transcript = { assetId: a.id, words: [] };
    for (let i = 0; i < chunks.length; i++) {
      setState({ busy: `Transcribing ${a.name}${chunks.length > 1 ? ` · ${i + 1}/${chunks.length}` : ""}` });
      const r = await runTranscribe(settings, chunks[i].blob, signal);
      transcript.words.push(...r.words.map((w) => ({ ...w, start: w.start + chunks[i].offset, end: w.end + chunks[i].offset })));
      transcript.language ??= r.language;
    }
    next.transcripts.push(transcript);
  }
  next.captions.enabled = true;
  if (op.preset) next.captions.preset = op.preset;
  next.updatedAt = Date.now();
  return next;
}

/** Clip edges on the media tracks — where cuts are visible. */
function cutPoints(p: Project): number[] {
  const pts: number[] = [];
  for (const t of p.tracks) {
    if (t.kind === "text") continue;
    for (const c of t.clips) pts.push(c.start, clipEnd(c));
  }
  return pts;
}

/** Cut points present after an edit that weren't there before. */
function newSeams(before: Project, after: Project): number[] {
  const old = cutPoints(before);
  const end = projectDuration(after);
  const seams = cutPoints(after).filter((t) => t > 0.01 && t < end - 0.01 && !old.some((o) => Math.abs(o - t) < 0.005));
  return [...new Set(seams.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

/** Run ops in order and commit the result as one undo step. Returns ops that actually ran.
 *  With `mark`, the new cut points are shown on the timeline as seams. */
export async function executeOps(
  ops: Op[],
  opts: { signal?: AbortSignal; mark?: boolean; quiet?: boolean } = {},
): Promise<{ ran: Op[]; errors: string[] }> {
  const { signal, mark, quiet } = opts;
  const start = getState().project;
  const busyBefore = getState().busy;
  const seamsBefore = getState().seams;
  let p = start;
  const ran: Op[] = [];
  const errors: string[] = [];
  try {
  for (const op of ops) {
    try {
      if (ASYNC_OPS.has(op.op)) {
        setState({ busy: op.op === "removeSilence" ? "Listening for silences" : "Transcribing" });
        p = op.op === "removeSilence" ? await removeSilence(p, op as any) : await generateCaptions(p, op as any, signal);
      } else {
        p = applyOp(p, op);
      }
      ran.push(op);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      errors.push(`${describeOp(op)}: ${(e as Error).message}`);
    }
  }
  } finally {
    // Tool-button runs own the busy indicator; agent turns restore their own label.
    setState({ busy: busyBefore });
  }
  if (ran.length && p !== getState().project) {
    commit(p);
    const fresh = newSeams(start, p);
    const cutsUnchanged = cutPoints(start).join() === cutPoints(p).join();
    if (mark && fresh.length) setState((s) => ({ seams: fresh, seamsKey: s.seamsKey + 1 }));
    // An edit that didn't touch the footage (a title, a colour) keeps the previous cut marks.
    else if (cutsUnchanged) setState({ seams: seamsBefore });
  }
  if (!quiet) for (const e of errors) toast(e.replace(/^[^:]+: /, ""), "error");
  return { ran, errors };
}

// Agent turn ------------------------------------------------------------

let controller: AbortController | null = null;

export function cancelAgent() {
  controller?.abort();
}

export async function sendToAgent(text: string) {
  const s = getState();
  if (s.busy) return;
  const user: ChatEntry = { id: uid("m"), role: "user", text };
  setState({ chat: [...s.chat, user], busy: "Thinking" });
  controller = new AbortController();
  const history: ChatMessage[] = s.chat
    .filter((m) => !m.error)
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.role === "assistant" ? JSON.stringify({ reply: m.text, ops: m.ops ?? [] }) : m.text }));
  try {
    const reply = await runAgent(
      s.settings,
      { project: s.project, playhead: s.playhead, selectedClipId: s.selectedClipId },
      history,
      text,
      controller.signal,
    );
    const before = getState().past.length;
    const { ran, errors } = await executeOps(reply.ops, { signal: controller.signal, mark: true, quiet: true });
    const changed = getState().past.length > before;
    const failedAll = errors.length > 0 && ran.length === 0;
    // If nothing ran, the plan in reply.reply didn't happen — show only what went wrong.
    const message = failedAll
      ? errors.map((e) => e.replace(/^[^:]+: /, "")).join(" ")
      : errors.length
        ? `${reply.reply} One step didn't work: ${errors[0].replace(/^[^:]+: /, "")}`
        : reply.reply;
    setState((st) => ({
      chat: [...st.chat, { id: uid("m"), role: "assistant", text: message, ops: ran, undoTo: changed ? before : undefined, error: failedAll }],
    }));
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "Stopped." : (e as Error).message;
    setState((st) => ({ chat: [...st.chat, { id: uid("m"), role: "assistant", text: msg, error: true }] }));
  } finally {
    controller = null;
    setState({ busy: null });
  }
}
