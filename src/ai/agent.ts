// The editing agent: turns a request + a compact description of the timeline into
// timeline ops. Uses plain JSON (not native tool calling) so small local models work too.

import { timelineWords } from "../engine/captions";
import { clipEnd, projectDuration, sanitizeOps, type Op } from "../engine/ops";
import type { Project } from "../engine/types";
import { extractJSON, type ChatMessage } from "./providers";

export interface AgentContext {
  project: Project;
  playhead: number;
  selectedClipId?: string | null;
}

export interface AgentReply {
  reply: string;
  ops: Op[];
  dropped: number;
}

const f = (n: number) => n.toFixed(2);

export function describeProject({ project: p, playhead, selectedClipId }: AgentContext): string {
  const lines: string[] = [];
  lines.push(`Aspect ${p.aspect}. Total duration ${f(projectDuration(p))}s. Playhead at ${f(playhead)}s.`);
  if (selectedClipId) lines.push(`Selected clip: ${selectedClipId}`);
  for (const t of p.tracks) {
    if (!t.clips.length) continue;
    lines.push(`\n${t.kind.toUpperCase()} track "${t.name}":`);
    for (const c of t.clips) {
      if (c.type === "media") {
        const a = p.assets.find((x) => x.id === c.assetId);
        lines.push(`- ${c.id}: ${f(c.start)}-${f(clipEnd(c))}s · ${a?.kind ?? "media"} "${a?.name ?? "?"}" · vol ${c.volume}`);
      } else {
        lines.push(`- ${c.id}: ${f(c.start)}-${f(clipEnd(c))}s · ${c.role} "${c.text}"`);
      }
    }
  }
  const words = timelineWords(p);
  if (words.length) {
    lines.push(`\nTRANSCRIPT (timeline seconds):`);
    // Group into sentence-ish lines so the model can choose ranges.
    let buf: string[] = [];
    let s = words[0].start;
    let budget = 9000;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      buf.push(w.text);
      const next = words[i + 1];
      const breakHere = !next || /[.!?]$/.test(w.text) || next.start - w.end > 0.8 || buf.length >= 18;
      if (breakHere) {
        const line = `[${f(s)}-${f(w.end)}] ${buf.join(" ")}`;
        budget -= line.length;
        if (budget < 0) {
          lines.push("…(transcript truncated)");
          break;
        }
        lines.push(line);
        buf = [];
        if (next) s = next.start;
      }
    }
  } else {
    lines.push(`\nNo transcript yet. Use generateCaptions first if the request depends on what is said.`);
  }
  lines.push(
    `\nCaptions: ${p.captions.enabled ? `on (${p.captions.preset}, ${p.captions.position})` : "off"}.` +
      ` Brand: primary ${p.brand.primary}, accent ${p.brand.accent}, font "${p.brand.font}", fit ${p.brand.fit}.`,
  );
  return lines.join("\n");
}

export const SYSTEM_PROMPT = `You are Clevatess, an assistant video editor working inside a real multi-track timeline.
You never render a final video yourself. You change the timeline with operations the user can inspect, undo and adjust by hand.

Reply with ONE JSON object and nothing else:
{"reply": "<one or two short sentences to the user>", "ops": [<operations, in order>]}

Operations (times are timeline seconds):
- {"op":"split","at":12.5}
- {"op":"deleteClip","clipId":"c_xxx"}
- {"op":"deleteRange","start":3.2,"end":5.0}               // ripple delete, closes the gap
- {"op":"keepRanges","ranges":[{"start":0,"end":8},{"start":20,"end":31}]}  // keep only these, in order
- {"op":"trim","clipId":"c_xxx","start":1.0,"end":9.0}     // new timeline start/end edges
- {"op":"move","clipId":"c_xxx","start":4}
- {"op":"addText","text":"How we built it","start":0,"duration":3,"role":"title|lower-third|callout"}
- {"op":"updateText","clipId":"c_xxx","text":"…"}
- {"op":"setVolume","clipId":"c_xxx","volume":0.4}         // omit clipId for every clip
- {"op":"setAspect","aspect":"16:9|9:16|1:1|4:5"}
- {"op":"setCaptions","enabled":true,"preset":"bold-pop|karaoke|boxed|clean|minimal|editorial","position":"bottom|middle|top"}
- {"op":"applyBrand","primary":"#hex","accent":"#hex","font":"…","fit":"cover|contain-blur"}
- {"op":"removeSilence","thresholdDb":-38,"minDuration":0.45}   // cuts dead air automatically
- {"op":"generateCaptions","preset":"bold-pop"}            // transcribes speech and turns captions on

Rules:
- Use only clip ids that appear in the project description.
- When picking the "best" parts, read the transcript and keep complete sentences; prefer keepRanges.
- Ops run in order, and each cut shifts later times. Prefer one keepRanges or deleteRange per request; if you must cut several ranges, list deleteRange ops from LAST to FIRST.
- If the request needs the transcript and there is none, return generateCaptions first and say you'll need another turn for the rest.
- If the request is unclear or impossible, return "ops": [] and ask one short question in "reply".
- Keep "reply" plain and brief. No markdown.`;

export function buildMessages(ctx: AgentContext, history: ChatMessage[], request: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-8),
    { role: "user", content: `PROJECT\n${describeProject(ctx)}\n\nREQUEST\n${request}` },
  ];
}

export function parseReply(text: string): AgentReply {
  const j = extractJSON(text);
  if (!j || typeof j !== "object") {
    return { reply: text.trim().slice(0, 500) || "I couldn't work out an edit from that.", ops: [], dropped: 0 };
  }
  const { ops, dropped } = sanitizeOps(j.ops);
  return { reply: typeof j.reply === "string" ? j.reply : "Done.", ops, dropped };
}
