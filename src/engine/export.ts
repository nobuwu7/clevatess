// In-browser export: replay the edit in real time on an offscreen-sized canvas,
// capture video + mixed audio with MediaRecorder. No server, no upload.

import { Player } from "./player";
import type { AspectRatio, Project } from "./types";

export interface ExportResult {
  blob: Blob;
  ext: "mp4" | "webm";
  aspect: AspectRatio;
}

export function pickMime(): { mime: string; ext: "mp4" | "webm" } {
  const candidates: [string, "mp4" | "webm"][] = [
    ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"],
    ["video/webm;codecs=vp8,opus", "webm"],
    ["video/webm", "webm"],
  ];
  for (const [mime, ext] of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: "", ext: "webm" };
}

export async function exportProject(
  project: Project,
  getBlob: (id: string) => Promise<Blob | undefined>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const canvas = document.createElement("canvas");
  // A canvas must be in the document in some browsers for captureStream to tick.
  canvas.style.cssText = "position:fixed;left:-99999px;top:0;width:2px;height:2px;pointer-events:none";
  document.body.appendChild(canvas);

  const player = new Player({ audio: { ctx: audioCtx, destination: dest } });
  try {
    player.project = project;
    player.attach(canvas);
    await player.ensureAssets(project.assets, getBlob);
    await player.ready();
    await document.fonts?.ready;
    player.setProject(project);
    player.seek(0);
    await new Promise((r) => setTimeout(r, 250)); // let first seeks land

    const stream = canvas.captureStream(project.fps);
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
    const { mime, ext } = pickMime();
    const rec = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 160_000,
    });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((res) => (rec.onstop = () => res()));

    const duration = player.duration;
    if (duration <= 0) throw new Error("Nothing on the timeline to export");
    await audioCtx.resume();
    rec.start(250);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        player.pause();
        reject(new DOMException("Export cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const tick = setInterval(() => onProgress(Math.min(1, player.time / duration)), 100);
      (player as any).opts.onEnded = () => {
        clearInterval(tick);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      player.play();
    });
    rec.stop();
    await done;
    onProgress(1);
    return { blob: new Blob(chunks, { type: mime || "video/webm" }), ext, aspect: project.aspect };
  } finally {
    player.dispose();
    canvas.remove();
    audioCtx.close().catch(() => {});
  }
}
