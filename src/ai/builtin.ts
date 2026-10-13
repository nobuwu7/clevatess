// Offline command understanding — the "builtin" provider. Handles the common
// edits with plain pattern matching so the editor is useful with no model at all.

import { clipEnd, findClip, projectDuration, type Op } from "../engine/ops";
import type { CaptionPreset } from "../engine/types";
import type { AgentContext, AgentReply } from "./agent";

const PRESETS: CaptionPreset[] = ["bold-pop", "karaoke", "boxed", "clean", "minimal", "editorial"];

function parseTime(s: string): number | null {
  const mmss = s.match(/(\d+):(\d{1,2}(?:\.\d+)?)/);
  if (mmss) return +mmss[1] * 60 + +mmss[2];
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/);
  if (sec) return +sec[1];
  const min = s.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)\b/);
  if (min) return +min[1] * 60;
  return null;
}

const quoted = (s: string) => s.match(/["“'‘](.+?)["”'’]/)?.[1];

export function builtinAgent(input: string, ctx: AgentContext): AgentReply {
  const s = input.toLowerCase().trim();
  const { project: p, playhead, selectedClipId } = ctx;
  const dur = projectDuration(p);
  const ops: Op[] = [];
  const say: string[] = [];

  if (!dur && !/brand|colou?r|font|aspect|vertical|square|landscape|portrait/.test(s)) {
    return { reply: "Add a clip first. Drop a video onto the editor.", ops: [], dropped: 0 };
  }

  // Dead air / silence
  if (/silen|dead air|pauses?|gaps?|tighten|jump ?cut/.test(s)) {
    const aggressive = /aggress|tight|all/.test(s);
    ops.push({ op: "removeSilence", minDuration: aggressive ? 0.3 : 0.5, thresholdDb: aggressive ? -34 : -38 });
    say.push("Cutting the silences.");
  }

  // Captions
  if (/caption|subtit/.test(s)) {
    if (/(off|remove|hide|no )/.test(s) && !/add|generate|turn on/.test(s)) {
      ops.push({ op: "setCaptions", enabled: false });
      say.push("Captions off.");
    } else {
      const preset = PRESETS.find((x) => s.includes(x.replace("-", " ")) || s.includes(x));
      const hasTranscript = p.transcripts.length > 0;
      if (hasTranscript) ops.push({ op: "setCaptions", enabled: true, ...(preset ? { preset } : {}) });
      else ops.push({ op: "generateCaptions", ...(preset ? { preset } : {}) });
      say.push(hasTranscript ? `Captions on${preset ? ` in ${preset}` : ""}.` : "Transcribing for captions.");
    }
  }
  const pos = s.match(/captions? (?:at|to) the (top|middle|bottom)/);
  if (pos) ops.push({ op: "setCaptions", position: pos[1] as "top" | "middle" | "bottom" });

  // Aspect
  const aspect =
    /vertical|9:16|tiktok|reels?|shorts/.test(s) ? "9:16" :
    /square|1:1/.test(s) ? "1:1" :
    /portrait|4:5/.test(s) ? "4:5" :
    /landscape|16:9|youtube|horizontal|widescreen/.test(s) ? "16:9" : null;
  if (aspect && /make|turn|switch|format|aspect|version|convert|vertical|square|portrait|landscape|for/.test(s)) {
    ops.push({ op: "setAspect", aspect });
    say.push(`Switched to ${aspect}.`);
  }

  // Titles and text
  if (/title|lower.third|callout|text|heading/.test(s) && /add|put|insert|show|title card/.test(s)) {
    const text = quoted(input) ?? input.replace(/.*?(?:title|text|lower third|callout)\s*(?:saying|that says|:)?\s*/i, "").trim();
    const role = /lower.third|name/.test(s) ? "lower-third" : /callout/.test(s) ? "callout" : "title";
    const at = parseTime(s) ?? (/end/.test(s) ? Math.max(0, dur - 3) : /start|beginning|intro|open/.test(s) ? 0 : playhead);
    if (text) {
      ops.push({ op: "addText", text: text.slice(0, 80), start: at, duration: role === "title" ? 3 : 4, role });
      say.push(`Added a ${role.replace("-", " ")}.`);
    }
  }

  // Split
  if (/\bsplit\b|\bcut (?:here|at)\b|razor/.test(s)) {
    const at = parseTime(s) ?? playhead;
    ops.push({ op: "split", at });
    say.push(`Split at ${at.toFixed(1)}s.`);
  }

  // Delete selection
  if (/(delete|remove) (?:this|the selected|selected|clip)/.test(s) && selectedClipId) {
    ops.push({ op: "deleteClip", clipId: selectedClipId });
    say.push("Removed the selected clip.");
  }

  // Keep first / last N seconds
  const first = s.match(/(?:first|opening|keep the first|trim to(?: the first)?|only) (\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)/);
  if (first) {
    ops.push({ op: "keepRanges", ranges: [{ start: 0, end: Math.min(dur, +first[1]) }] });
    say.push(`Trimmed to the first ${first[1]}s.`);
  }
  const last = s.match(/last (\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)/);
  if (last) {
    ops.push({ op: "keepRanges", ranges: [{ start: Math.max(0, dur - +last[1]), end: dur }] });
    say.push(`Kept the last ${last[1]}s.`);
  }
  const range = s.match(/(?:cut|delete|remove) (?:from )?(\d+(?:\.\d+)?)\s*s?\s*(?:to|-|–|until) (\d+(?:\.\d+)?)\s*s?/);
  if (range) {
    ops.push({ op: "deleteRange", start: +range[1], end: +range[2] });
    say.push(`Cut ${range[1]}-${range[2]}s.`);
  }

  // Volume
  if (/mute/.test(s)) {
    const target = selectedClipId && findClip(p, selectedClipId)?.clip.type === "media" ? selectedClipId : undefined;
    ops.push({ op: "setVolume", clipId: target, volume: 0 });
    say.push(target ? "Muted the selected clip." : "Muted everything.");
  } else {
    const vol = s.match(/volume (?:to )?(\d+)\s*%?/);
    if (vol) {
      ops.push({ op: "setVolume", clipId: selectedClipId ?? undefined, volume: Math.min(100, +vol[1]) / 100 });
      say.push(`Volume ${vol[1]}%.`);
    }
  }

  // Brand
  if (/brand|on.brand/.test(s) && /apply|use|make/.test(s)) {
    ops.push({ op: "applyBrand" });
    if (!p.captions.enabled && p.transcripts.length) ops.push({ op: "setCaptions", enabled: true });
    say.push("Brand kit applied.");
  }
  const hex = s.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/);
  if (hex && /colou?r|primary|brand/.test(s)) {
    ops.push({ op: "applyBrand", primary: `#${hex[1]}` });
    say.push(`Brand colour set to #${hex[1]}.`);
  }
  if (/fill the frame|crop to fill|no bars/.test(s)) ops.push({ op: "applyBrand", fit: "cover" });
  if (/blur(red)? (background|bars)|letterbox/.test(s)) ops.push({ op: "applyBrand", fit: "contain-blur" });

  if (!ops.length) {
    return {
      reply:
        "I can do that once a model is connected (Settings). Offline I understand things like “remove the silences”, “add captions”, “make it vertical”, “add a title \"Launch day\"”, or “keep the first 30 seconds”.",
      ops: [],
      dropped: 0,
    };
  }
  void clipEnd;
  return { reply: say.join(" ") || "Done.", ops, dropped: 0 };
}
