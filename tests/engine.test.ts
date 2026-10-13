import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinAgent } from "../src/ai/builtin";
import { describeProject, parseReply } from "../src/ai/agent";
import { extractJSON, normalizeWords } from "../src/ai/providers";
import { buildCues, timelineWords, toSRT } from "../src/engine/captions";
import { applyOp, clipEnd, deleteRanges, projectDuration, sanitizeOps, sourceRangesToTimeline } from "../src/engine/ops";
import { appendAsset, newProject } from "../src/engine/project";
import type { Asset, Project } from "../src/engine/types";
import { chatConfig, handleChat, handleConfig, transcribeConfig } from "../src/server/handlers";

const vid = (id: string, duration: number): Asset => ({ id, name: `${id}.mp4`, kind: "video", duration, mime: "video/mp4", size: 1 });

function twoClips(): Project {
  let p = newProject();
  p = appendAsset(p, vid("a1", 10));
  p = appendAsset(p, vid("a2", 6));
  return p;
}
const videoClips = (p: Project) => p.tracks.find((t) => t.kind === "video")!.clips;

test("appendAsset places clips back to back", () => {
  const p = twoClips();
  const [a, b] = videoClips(p);
  assert.equal(a.start, 0);
  assert.equal(b.start, 10);
  assert.equal(projectDuration(p), 16);
});

test("split cuts every clip under the playhead", () => {
  const p = applyOp(twoClips(), { op: "split", at: 4 });
  const clips = videoClips(p);
  assert.equal(clips.length, 3);
  assert.equal(clipEnd(clips[0]), 4);
  assert.equal(clips[1].start, 4);
  assert.equal((clips[1] as any).in, 4);
  assert.equal(projectDuration(p), 16);
});

test("deleteRange ripples later clips left", () => {
  const p = applyOp(twoClips(), { op: "deleteRange", start: 2, end: 5 });
  assert.equal(projectDuration(p), 13);
  const clips = videoClips(p);
  assert.equal(clips.length, 3);
  assert.equal(clips[1].start, 2);
  assert.equal((clips[1] as any).in, 5);
  assert.equal(clips[2].start, 7);
});

test("keepRanges keeps only the chosen sections, in order", () => {
  const p = applyOp(twoClips(), { op: "keepRanges", ranges: [{ start: 12, end: 14 }, { start: 1, end: 3 }] });
  assert.equal(projectDuration(p), 4);
  const clips = videoClips(p);
  assert.equal((clips[0] as any).in, 1);
  assert.equal((clips[1] as any).assetId, "a2");
  assert.equal((clips[1] as any).in, 2);
});

test("text clips inside a deleted range are removed, later ones shift", () => {
  let p = twoClips();
  p = applyOp(p, { op: "addText", text: "Inside", start: 3, duration: 1 });
  p = applyOp(p, { op: "addText", text: "After", start: 12, duration: 2 });
  p = applyOp(p, { op: "deleteRange", start: 2, end: 6 });
  const text = p.tracks.find((t) => t.kind === "text")!.clips as any[];
  assert.deepEqual(text.map((c) => c.text), ["After"]);
  assert.equal(text[0].start, 8);
});

test("trim moves the in point and clamps the out point to the source", () => {
  let p = twoClips();
  const id = videoClips(p)[0].id;
  p = applyOp(p, { op: "trim", clipId: id, start: 2, end: 50 });
  const c = videoClips(p)[0] as any;
  assert.equal(c.start, 2);
  assert.equal(c.in, 2);
  assert.equal(c.out, 10);
});

test("silence in source time maps through cuts onto the timeline", () => {
  let p = applyOp(twoClips(), { op: "deleteRange", start: 0, end: 2 }); // a1 now plays source 2..10 at 0..8
  const ranges = sourceRangesToTimeline(p, "a1", [{ start: 1, end: 3 }, { start: 6, end: 7 }]);
  assert.deepEqual(ranges, [{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  p = deleteRanges(p, ranges);
  assert.equal(projectDuration(p), 12);
});

test("captions map transcript words through edits", () => {
  let p = twoClips();
  p.transcripts.push({ assetId: "a1", words: [
    { text: "Hello", start: 0.5, end: 0.9 },
    { text: "there.", start: 1.0, end: 1.4 },
    { text: "Cut", start: 3, end: 3.5 },
    { text: "kept", start: 6, end: 6.5 },
  ] });
  p = applyOp(p, { op: "deleteRange", start: 2.5, end: 4 });
  const words = timelineWords(p);
  assert.deepEqual(words.map((w) => w.text), ["Hello", "there.", "kept"]);
  assert.equal(words[2].start, 4.5);
  const cues = buildCues(words, 4);
  assert.equal(cues.length, 2); // sentence end splits the cue
  assert.match(toSRT(cues), /00:00:00,500 --> /);
});

test("sanitizeOps drops malformed model output", () => {
  const { ops, dropped } = sanitizeOps([{ op: "split", at: 2 }, { op: "split" }, { op: "explode" }, "x", { op: "setAspect", aspect: "9:16" }]);
  assert.equal(ops.length, 2);
  assert.equal(dropped, 3);
});

test("extractJSON tolerates fences and chatter", () => {
  assert.deepEqual(extractJSON('Sure!\n```json\n{"reply":"ok","ops":[]}\n```'), { reply: "ok", ops: [] });
  assert.deepEqual(extractJSON('Here: {"a":{"b":"}"}} trailing'), { a: { b: "}" } });
  const r = parseReply('{"reply":"Cut it","ops":[{"op":"deleteRange","start":1,"end":2}]}');
  assert.equal(r.ops.length, 1);
});

test("normalizeWords handles segment-only Whisper output", () => {
  const w = normalizeWords({ segments: [{ start: 0, end: 2, text: " one two " }] });
  assert.equal(w.length, 2);
  assert.equal(w[0].start, 0);
  assert.ok(Math.abs(w[1].end - 2) < 1e-9);
});

test("builtin agent understands common commands", () => {
  const p = twoClips();
  const ctx = { project: p, playhead: 3 };
  assert.equal(builtinAgent("remove the dead air", ctx).ops[0].op, "removeSilence");
  assert.deepEqual(builtinAgent("make it vertical for tiktok", ctx).ops[0], { op: "setAspect", aspect: "9:16" });
  assert.equal(builtinAgent("add captions", ctx).ops[0].op, "generateCaptions");
  const t = builtinAgent('add a title "Launch day" at the start', ctx).ops[0] as any;
  assert.equal(t.text, "Launch day");
  assert.equal(t.start, 0);
  assert.deepEqual(builtinAgent("keep the first 5 seconds", ctx).ops[0], { op: "keepRanges", ranges: [{ start: 0, end: 5 }] });
  assert.equal(builtinAgent("split here", ctx).ops[0].op, "split");
  assert.equal(builtinAgent("write me a poem", ctx).ops.length, 0);
});

test("describeProject lists clips and transcript", () => {
  const p = twoClips();
  p.transcripts.push({ assetId: "a1", words: [{ text: "Hi.", start: 0, end: 0.5 }] });
  const d = describeProject({ project: p, playhead: 1 });
  assert.match(d, /VIDEO track/);
  assert.match(d, /\[0\.00-0\.50\] Hi\./);
});

test("server config: env shortcuts and no open proxy", async () => {
  assert.equal(chatConfig({}), null);
  assert.equal(chatConfig({ ANTHROPIC_API_KEY: "k" })!.kind, "anthropic");
  const custom = chatConfig({ AI_BASE_URL: "http://gpu:8000/v1", AI_MODEL: "m" })!;
  assert.equal(custom.kind, "openai-compatible");
  assert.equal(transcribeConfig({ GROQ_API_KEY: "g" })!.model, "whisper-large-v3-turbo");
  const cfg = await (await handleConfig(new Request("http://x/api/config"), {})).json();
  assert.equal(cfg.chat.configured, false);
  const r = await handleChat(new Request("http://x/api/chat", { method: "POST", body: "{}" }), {});
  assert.equal(r.status, 503);
});
