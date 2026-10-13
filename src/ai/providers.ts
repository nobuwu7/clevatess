// Swappable model providers. Runs unchanged in the browser ("direct" mode — e.g. a local
// Ollama or LM Studio, or your own cloud key) and in the Vercel function ("server" mode —
// keys stay in environment variables). Only `fetch`, `FormData` and `Blob` are used.

export type ProviderKind = "openai-compatible" | "anthropic" | "builtin";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Ask the server for a strict JSON response when it supports it. */
  jsonMode?: boolean;
}

export interface TranscribeConfig {
  baseUrl: string; // OpenAI-compatible: POST {baseUrl}/audio/transcriptions
  model: string;
  apiKey?: string;
}

export interface Preset {
  id: string;
  label: string;
  where: "cloud" | "local" | "device";
  config: ProviderConfig;
  transcribe?: TranscribeConfig;
  note?: string;
}

// Defaults are starting points — every field is editable in Settings.
export const PRESETS: Preset[] = [
  {
    id: "builtin",
    label: "Built-in (no model)",
    where: "device",
    config: { kind: "builtin", baseUrl: "", model: "rules" },
    note: "Understands simple commands offline. Connect a model for open-ended edits.",
  },
  {
    id: "ollama",
    label: "Ollama",
    where: "local",
    config: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", jsonMode: true },
    note: "Start Ollama with OLLAMA_ORIGINS=* so the browser can reach it.",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    where: "local",
    config: { kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "local-model" },
    note: "Enable CORS in LM Studio's server settings.",
  },
  {
    id: "vllm",
    label: "vLLM / llama.cpp / custom",
    where: "local",
    config: { kind: "openai-compatible", baseUrl: "http://localhost:8000/v1", model: "your-model" },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    where: "cloud",
    config: { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  },
  {
    id: "openai",
    label: "OpenAI",
    where: "cloud",
    config: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", jsonMode: true },
    transcribe: { baseUrl: "https://api.openai.com/v1", model: "whisper-1" },
  },
  {
    id: "groq",
    label: "Groq",
    where: "cloud",
    config: { kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", jsonMode: true },
    transcribe: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    where: "cloud",
    config: { kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/auto" },
  },
];

export const TRANSCRIBE_PRESETS: { id: string; label: string; where: "cloud" | "local"; config: TranscribeConfig; note?: string }[] = [
  { id: "speaches", label: "Local Whisper (speaches / faster-whisper)", where: "local", config: { baseUrl: "http://localhost:8000/v1", model: "Systran/faster-whisper-small" } },
  { id: "openai", label: "OpenAI Whisper", where: "cloud", config: { baseUrl: "https://api.openai.com/v1", model: "whisper-1" } },
  { id: "groq", label: "Groq Whisper", where: "cloud", config: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" } },
];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const isBrowser = typeof window !== "undefined";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export class ProviderError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.error || j.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || res.statusText;
  }
}

export async function chat(cfg: ProviderConfig, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  if (cfg.kind === "builtin") throw new ProviderError("The built-in provider runs without a model");
  if (cfg.kind === "anthropic") return chatAnthropic(cfg, messages, signal);
  return chatOpenAI(cfg, messages, signal);
}

async function chatOpenAI(cfg: ProviderConfig, messages: ChatMessage[], signal?: AbortSignal) {
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0.2 };
  if (cfg.jsonMode) body.response_format = { type: "json_object" };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.baseUrl.includes("openrouter.ai")) {
    headers["X-Title"] = "Clevatess";
  }
  let res: Response;
  try {
    res = await fetch(`${trimSlash(cfg.baseUrl)}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ProviderError(
      isBrowser
        ? `Couldn't reach ${cfg.baseUrl}. If it's a local server, check it's running and allows browser (CORS) requests.`
        : `Couldn't reach ${cfg.baseUrl}`,
    );
  }
  // Some servers reject response_format; retry once without it.
  if (!res.ok && cfg.jsonMode && (res.status === 400 || res.status === 422)) {
    return chatOpenAI({ ...cfg, jsonMode: false }, messages, signal);
  }
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ProviderError("The model returned an empty response");
  return content;
}

async function chatAnthropic(cfg: ProviderConfig, messages: ChatMessage[], signal?: AbortSignal) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
  if (isBrowser) headers["anthropic-dangerous-direct-browser-access"] = "true";
  let res: Response;
  try {
    res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, max_tokens: 2048, system, messages: rest, temperature: 0.2 }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ProviderError(`Couldn't reach ${cfg.baseUrl}`);
  }
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  const j = await res.json();
  const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  if (!text) throw new ProviderError("The model returned an empty response");
  return text;
}

export interface TranscribedWord {
  text: string;
  start: number;
  end: number;
}

export async function transcribe(
  cfg: TranscribeConfig,
  audio: Blob,
  signal?: AbortSignal,
): Promise<{ words: TranscribedWord[]; language?: string }> {
  const form = new FormData();
  form.append("file", audio, "audio.wav");
  form.append("model", cfg.model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${trimSlash(cfg.baseUrl)}/audio/transcriptions`, { method: "POST", headers, body: form, signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ProviderError(`Couldn't reach the transcription server at ${cfg.baseUrl}`);
  }
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  const j = await res.json();
  return { words: normalizeWords(j), language: j.language };
}

/** Whisper servers differ: some return word timings, some only segments. Normalise to words. */
export function normalizeWords(j: any): TranscribedWord[] {
  const clean = (s: string) => String(s).trim();
  if (Array.isArray(j.words) && j.words.length) {
    return j.words
      .map((w: any) => ({ text: clean(w.word ?? w.text), start: +w.start, end: +w.end }))
      .filter((w: TranscribedWord) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
  }
  const out: TranscribedWord[] = [];
  for (const s of j.segments ?? []) {
    if (Array.isArray(s.words) && s.words.length) {
      for (const w of s.words) out.push({ text: clean(w.word ?? w.text), start: +w.start, end: +w.end });
      continue;
    }
    // No word timings: spread the segment's words evenly, weighted by length.
    const words = clean(s.text).split(/\s+/).filter(Boolean);
    const total = words.reduce((n, w) => n + w.length + 1, 0);
    let t = +s.start;
    const span = +s.end - +s.start;
    for (const w of words) {
      const d = (span * (w.length + 1)) / total;
      out.push({ text: w, start: t, end: t + d });
      t += d;
    }
  }
  return out.filter((w) => w.text);
}

/** Pull the first JSON object out of a model reply, tolerating code fences and chatter. */
export function extractJSON(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {}
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
