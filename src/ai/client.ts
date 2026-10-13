// Client-side routing between the three ways a request can be served:
//   builtin → offline rules in the browser
//   direct  → browser calls the provider itself (local servers, or your own key)
//   server  → the Vercel function calls a provider configured with env vars

import { buildMessages, parseReply, type AgentContext, type AgentReply } from "./agent";
import { builtinAgent } from "./builtin";
import { chat, transcribe, type ChatMessage, type ProviderConfig, type TranscribeConfig, type TranscribedWord } from "./providers";

export type Mode = "builtin" | "direct" | "server";

export interface AISettings {
  mode: Mode;
  presetId: string;
  chat: ProviderConfig;
  transcribeMode: "server" | "direct" | "off";
  transcribe: TranscribeConfig;
}

export interface ServerStatus {
  chat: { configured: boolean; provider?: string; model?: string };
  transcribe: { configured: boolean; model?: string };
}

export const DEFAULT_SETTINGS: AISettings = {
  mode: "builtin",
  presetId: "builtin",
  chat: { kind: "builtin", baseUrl: "", model: "rules" },
  transcribeMode: "server",
  transcribe: { baseUrl: "http://localhost:8000/v1", model: "Systran/faster-whisper-small" },
};

const KEY = "clevatess.ai.v1";

export function loadSettings(): AISettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_SETTINGS;
}

export function saveSettings(s: AISettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

export async function fetchServerStatus(): Promise<ServerStatus | null> {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function runAgent(
  settings: AISettings,
  ctx: AgentContext,
  history: ChatMessage[],
  request: string,
  signal?: AbortSignal,
): Promise<AgentReply> {
  if (settings.mode === "builtin") return builtinAgent(request, ctx);
  const messages = buildMessages(ctx, history, request);
  if (settings.mode === "direct") {
    return parseReply(await chat(settings.chat, messages, signal));
  }
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
  return parseReply(j.text);
}

export async function runTranscribe(settings: AISettings, wav: Blob, signal?: AbortSignal): Promise<{ words: TranscribedWord[]; language?: string }> {
  if (settings.transcribeMode === "off") throw new Error("Transcription is turned off in Settings.");
  if (settings.transcribeMode === "direct") return transcribe(settings.transcribe, wav, signal);
  const r = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Transcription failed (${r.status})`);
  return j;
}
