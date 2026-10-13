// Web-standard request handlers for the serverless API. The client never chooses the
// upstream URL in server mode, so this can't be used as an open proxy.

import { chat, ProviderError, transcribe, type ChatMessage, type ProviderConfig, type TranscribeConfig } from "../ai/providers";

type Env = Record<string, string | undefined>;

export function chatConfig(env: Env): ProviderConfig | null {
  const key = env.AI_API_KEY;
  const kind = (env.AI_PROVIDER as ProviderConfig["kind"]) || undefined;
  if (env.AI_BASE_URL || kind) {
    const k = kind ?? "openai-compatible";
    return {
      kind: k,
      baseUrl: env.AI_BASE_URL || (k === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
      model: env.AI_MODEL || (k === "anthropic" ? "claude-sonnet-5-5" : "gpt-4.1-mini"),
      apiKey: key || (k === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY),
      jsonMode: env.AI_JSON_MODE ? env.AI_JSON_MODE === "true" : k === "openai-compatible",
    };
  }
  // Shortcuts: just set a provider's usual key.
  if (env.ANTHROPIC_API_KEY)
    return { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: env.AI_MODEL || "claude-sonnet-5-5", apiKey: env.ANTHROPIC_API_KEY };
  if (env.OPENAI_API_KEY)
    return { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: env.AI_MODEL || "gpt-4.1-mini", apiKey: env.OPENAI_API_KEY, jsonMode: true };
  if (env.GROQ_API_KEY)
    return { kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: env.AI_MODEL || "llama-3.3-70b-versatile", apiKey: env.GROQ_API_KEY, jsonMode: true };
  return null;
}

export function transcribeConfig(env: Env): TranscribeConfig | null {
  if (env.TRANSCRIBE_BASE_URL)
    return { baseUrl: env.TRANSCRIBE_BASE_URL, model: env.TRANSCRIBE_MODEL || "whisper-1", apiKey: env.TRANSCRIBE_API_KEY };
  if (env.OPENAI_API_KEY) return { baseUrl: "https://api.openai.com/v1", model: env.TRANSCRIBE_MODEL || "whisper-1", apiKey: env.OPENAI_API_KEY };
  if (env.GROQ_API_KEY)
    return { baseUrl: "https://api.groq.com/openai/v1", model: env.TRANSCRIBE_MODEL || "whisper-large-v3-turbo", apiKey: env.GROQ_API_KEY };
  return null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleConfig(_req: Request, env: Env): Promise<Response> {
  const c = chatConfig(env);
  const t = transcribeConfig(env);
  let provider: string | undefined;
  if (c) {
    try {
      provider = c.kind === "anthropic" ? "Anthropic" : new URL(c.baseUrl).hostname;
    } catch {
      provider = c.kind;
    }
  }
  return json({
    chat: { configured: !!c, provider, model: c?.model },
    transcribe: { configured: !!t, model: t?.model },
  });
}

const MAX_MESSAGES = 24;
const MAX_CHARS = 60_000;

export async function handleChat(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const cfg = chatConfig(env);
  if (!cfg) return json({ error: "This deployment doesn't have a model connected yet. Open Settings to use a local model or your own key, or ask the site owner to add one." }, 503);
  let body: { messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const messages = (body.messages ?? []).filter(
    (m) => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string",
  );
  if (!messages.length || messages.length > MAX_MESSAGES) return json({ error: "Bad messages" }, 400);
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) return json({ error: "Request too large" }, 413);
  try {
    const text = await chat(cfg, messages);
    return json({ text });
  } catch (e) {
    const status = e instanceof ProviderError && e.status ? (e.status >= 500 ? 502 : e.status) : 502;
    return json({ error: (e as Error).message }, status);
  }
}

export async function handleTranscribe(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const cfg = transcribeConfig(env);
  if (!cfg) return json({ error: "Captions need a transcription service, and this deployment doesn't have one. Open Settings → Transcription to connect a local Whisper server or a cloud key." }, 503);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ error: "Empty audio" }, 400);
  if (buf.byteLength > 4_400_000) return json({ error: "Audio chunk too large" }, 413);
  try {
    const out = await transcribe(cfg, new Blob([buf], { type: "audio/wav" }));
    return json(out);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}

export const routes: Record<string, (req: Request, env: Env) => Promise<Response>> = {
  "/api/config": handleConfig,
  "/api/chat": handleChat,
  "/api/transcribe": handleTranscribe,
};
