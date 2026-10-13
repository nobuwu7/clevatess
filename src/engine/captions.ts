// Map transcript words (source time) onto the timeline and group them into caption cues.

import type { CaptionPreset, Project, Word } from "./types";

export interface Cue {
  start: number; // timeline time
  end: number;
  words: Word[]; // timeline-timed words
}

export function timelineWords(p: Project): Word[] {
  const out: Word[] = [];
  const video = p.tracks.filter((t) => t.kind === "video" || t.kind === "audio");
  const seen = new Set<string>();
  for (const t of video) {
    for (const c of t.clips) {
      if (c.type !== "media") continue;
      const tr = p.transcripts.find((x) => x.assetId === c.assetId);
      if (!tr) continue;
      // Avoid doubling words when the same span of an asset sits on two tracks.
      const key = `${c.assetId}:${c.in}:${c.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const w of tr.words) {
        if (w.end <= c.in || w.start >= c.out) continue;
        const s = Math.max(w.start, c.in);
        const e = Math.min(w.end, c.out);
        out.push({ text: w.text, start: c.start + (s - c.in), end: c.start + (e - c.in) });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function buildCues(words: Word[], maxWords: number): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const gap = prev ? w.start - prev.end : 0;
    if (cur.length >= maxWords || gap > 0.6) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  // Hold each cue until the next one starts (up to 0.5s) so captions don't flicker.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    cues[i].end = next ? Math.min(next.start, cues[i].end + 0.5) : cues[i].end + 0.5;
  }
  return cues;
}

export const CAPTION_PRESETS: { id: CaptionPreset; label: string; hint: string }[] = [
  { id: "bold-pop", label: "Bold pop", hint: "Heavy type, active word in brand colour" },
  { id: "karaoke", label: "Karaoke", hint: "Words light up as they're spoken" },
  { id: "boxed", label: "Boxed", hint: "Brand-colour box behind each line" },
  { id: "clean", label: "Clean", hint: "Sentence case with a soft shadow" },
  { id: "minimal", label: "Minimal", hint: "Small, lowercase, out of the way" },
  { id: "editorial", label: "Editorial", hint: "Serif italic, documentary feel" },
];

/** Plain SRT export so captions can leave the app. */
export function toSRT(cues: Cue[]): string {
  const ts = (t: number) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    const p = (n: number, l = 2) => String(n).padStart(l, "0");
    return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.words.map((w) => w.text).join(" ")}\n`)
    .join("\n");
}
