// Plays a project: keeps one media element per asset in sync with the timeline
// clock and draws frames onto a canvas. The exporter drives a second instance.

import { projectDuration } from "./ops";
import { activeMediaClips, renderFrame, type MediaEl } from "./render";
import type { Asset, Project } from "./types";
import { ASPECTS } from "./types";

export interface PlayerOptions {
  /** Route all audio into this node instead of the speakers (used for export). */
  audio?: { ctx: AudioContext; destination: AudioNode };
  onTime?: (t: number) => void;
  onEnded?: () => void;
}

export class Player {
  private els = new Map<string, MediaEl>();
  private urls = new Map<string, string>();
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private clockStart = 0;
  private timeAtStart = 0;
  private drawQueued = false;
  project: Project | null = null;
  time = 0;
  playing = false;

  constructor(private opts: PlayerOptions = {}) {}

  attach(canvas: HTMLCanvasElement | OffscreenCanvas | null) {
    this.ctx = canvas ? ((canvas as HTMLCanvasElement).getContext("2d", { alpha: false }) as CanvasRenderingContext2D) : null;
    this.resize();
    this.requestDraw();
  }

  private resize() {
    if (!this.ctx || !this.project) return;
    const { w, h } = ASPECTS[this.project.aspect];
    const c = this.ctx.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  /** Make sure every asset has a loaded element. Blob lookup is async (IndexedDB). */
  async ensureAssets(assets: Asset[], getBlob: (id: string) => Promise<Blob | undefined>) {
    for (const a of assets) {
      if (this.els.has(a.id)) continue;
      const blob = await getBlob(a.id);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      this.urls.set(a.id, url);
      let el: MediaEl;
      if (a.kind === "image") {
        const img = new Image();
        img.src = url;
        img.onload = () => this.requestDraw();
        el = img;
      } else {
        const m = document.createElement(a.kind === "video" ? "video" : "audio") as HTMLVideoElement | HTMLAudioElement;
        m.src = url;
        m.preload = "auto";
        m.crossOrigin = "anonymous";
        (m as HTMLVideoElement).playsInline = true;
        m.addEventListener("seeked", () => this.requestDraw());
        m.addEventListener("loadeddata", () => this.requestDraw());
        if (this.opts.audio) {
          const node = this.opts.audio.ctx.createMediaElementSource(m);
          node.connect(this.opts.audio.destination);
        }
        el = m;
      }
      this.els.set(a.id, el);
    }
    this.requestDraw();
  }

  /** Wait until every video/audio element can render its first frame. */
  async ready(timeoutMs = 15000) {
    const waits = [...this.els.values()].map(
      (el) =>
        new Promise<void>((res) => {
          if (el instanceof HTMLImageElement) return el.complete ? res() : (el.onload = () => res());
          if (el.readyState >= 2) return res();
          el.addEventListener("loadeddata", () => res(), { once: true });
          el.addEventListener("error", () => res(), { once: true });
        }),
    );
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  setProject(p: Project) {
    this.project = p;
    this.resize();
    const dur = projectDuration(p);
    if (this.time > dur) this.seek(dur);
    else {
      this.sync();
      this.requestDraw();
    }
  }

  get duration() {
    return this.project ? projectDuration(this.project) : 0;
  }

  play() {
    if (!this.project || this.playing) return;
    if (this.time >= this.duration - 0.05) this.time = 0;
    this.playing = true;
    this.clockStart = performance.now();
    this.timeAtStart = this.time;
    this.sync(true);
    const loop = () => {
      if (!this.playing) return;
      this.time = this.timeAtStart + (performance.now() - this.clockStart) / 1000;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.pause();
        this.opts.onTime?.(this.time);
        this.opts.onEnded?.();
        return;
      }
      this.sync();
      this.draw();
      this.opts.onTime?.(this.time);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const el of this.els.values()) if (!(el instanceof HTMLImageElement)) el.pause();
    this.requestDraw();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(this.duration, t));
    if (this.playing) {
      this.clockStart = performance.now();
      this.timeAtStart = this.time;
    }
    this.sync(true);
    this.requestDraw();
    this.opts.onTime?.(this.time);
  }

  /** Line up each media element with where the playhead says it should be. */
  private sync(force = false) {
    if (!this.project) return;
    const active = activeMediaClips(this.project, this.time);
    const used = new Set<string>();
    for (const { clip } of active) {
      const el = this.els.get(clip.assetId);
      if (!el || el instanceof HTMLImageElement || used.has(clip.assetId)) continue;
      used.add(clip.assetId);
      const want = clip.in + (this.time - clip.start);
      el.volume = clip.volume;
      el.muted = clip.volume === 0;
      if (this.playing) {
        if (el.paused) {
          el.currentTime = want;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - want) > 0.3) {
          el.currentTime = want;
        }
      } else {
        if (!el.paused) el.pause();
        if (force || Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
      }
    }
    for (const [id, el] of this.els) {
      if (!used.has(id) && !(el instanceof HTMLImageElement) && !el.paused) el.pause();
    }
  }

  requestDraw() {
    if (this.drawQueued || this.playing) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  draw() {
    if (!this.ctx || !this.project) return;
    this.resize();
    renderFrame(this.ctx, this.project, this.time, { get: (id) => this.els.get(id) }, !this.playing && !this.opts.audio);
  }

  element(assetId: string) {
    return this.els.get(assetId);
  }

  dispose() {
    this.pause();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    for (const el of this.els.values()) {
      if (!(el instanceof HTMLImageElement)) {
        el.removeAttribute("src");
        el.load();
      }
    }
    this.els.clear();
    this.urls.clear();
  }
}
