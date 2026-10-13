# Clevatess

An open-source AI video editor. Describe an edit in plain language and it lands on a real multi-track timeline, as clips you can drag, trim or undo. Media never leaves your browser.

Inspired by two ideas, not copied from either:

- **Chat-driven editing on a real timeline** (the ChatCut idea): the assistant is an assistant editor, not a black box. Every request becomes ordinary timeline operations, shown under the reply and undoable as a unit.
- **Brand consistency at volume** (the Stanley Studio idea): set a brand kit once (colours, typeface, logo, caption style, reframing) and every title, caption and export variant follows it. One edit exports to 16:9, 9:16, 1:1 and 4:5 in a single batch.

## What it does

- **Timeline editor**: text, video and audio tracks; filmstrip thumbnails and waveforms; drag to move, drag edges to trim, snapping, split at playhead, ripple delete, undo/redo.
- **Assistant**: "remove the dead air", "add bold captions", "keep the best 30 seconds", "make a vertical version". Replies show each operation it ran; "Undo this" rolls back the whole turn. Cut marks on the ruler show exactly where the last automatic edit touched your footage.
- **Silence removal** in the browser (Web Audio), no model needed.
- **Captions** from any Whisper-compatible transcription service, six styles, word-level highlighting, `.srt` export.
- **Brand kit**: colours, typeface, logo watermark with corner and opacity, and how footage fills a frame of a different shape (blurred edges or crop).
- **Export** in the browser, with no server and no upload: MP4 where the browser supports it, WebM otherwise. Several aspect ratios in one go.
- Projects persist in IndexedDB.

## Models: swap freely, local or cloud

The assistant talks to models through one small provider layer (`src/ai/providers.ts`) that runs unchanged in the browser and on the server. Pick a mode in **Settings**:

| Mode | Where requests go | Good for |
| --- | --- | --- |
| **Built-in** | Nowhere. Offline pattern matching | Trying the editor with no setup; simple commands |
| **From this browser** | Straight from your browser to the provider | **Self-hosted models** (Ollama, LM Studio, vLLM, llama.cpp) on your own machine, or your own cloud key |
| **Deployment server** | The Vercel function, using environment variables | Sharing a deployment with a model already connected; keys stay server-side |

Supported out of the box: any **OpenAI-compatible** endpoint (OpenAI, Groq, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp server) and **Anthropic**. The agent asks for plain JSON rather than native tool calls, so small local models work too.

Local servers need to allow browser requests:

- **Ollama**: start with `OLLAMA_ORIGINS=* ollama serve`
- **LM Studio**: enable CORS in the local server settings
- **Local Whisper** (for captions): e.g. [speaches](https://github.com/speaches-ai/speaches) on `http://localhost:8000/v1`

Browsers allow an HTTPS page to call `http://localhost`, so the deployed site can use models running on your laptop.

### Server environment variables

Set any one of these in Vercel (Project → Settings → Environment Variables). See `.env.example`.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Assistant uses Anthropic (`AI_MODEL` to override the model) |
| `OPENAI_API_KEY` | Assistant uses OpenAI; also enables Whisper captions |
| `GROQ_API_KEY` | Assistant uses Groq; also enables Whisper captions |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_PROVIDER` | Any OpenAI-compatible server (including a self-hosted one reachable from the internet), or `AI_PROVIDER=anthropic` |
| `TRANSCRIBE_BASE_URL`, `TRANSCRIBE_MODEL`, `TRANSCRIBE_API_KEY` | Any Whisper-compatible transcription service |

The browser never chooses the upstream URL in server mode, so the API can't be used as an open proxy.

## Run it

```bash
npm install
npm run build
npm start            # http://localhost:5173
npm test             # engine, agent and API tests
```

`npm run build` writes Vercel's Build Output API layout to `.vercel/output`, and `npm start` serves exactly that, API included, so local runs match production. Put server env vars in `.env.local`.

## Deploy

Import the repo in Vercel with the default settings (`vercel.json` sets the build command). No framework preset is needed.

## How it fits together

```
src/engine/   timeline model and pure ops, renderer, player, audio analysis, export
src/ai/       provider layer, agent prompt and parsing, built-in rules, client routing
src/server/   Web-standard API handlers + Node adapter (one bundle, three functions)
src/store/    state with undo history; actions that execute agent ops
src/ui/       React components and the design system (styles.css)
```

Every edit, from a human drag or from the model, goes through `applyOp` in `src/engine/ops.ts`. The preview and the exporter share one renderer, so what you see is what you export.

## Limits worth knowing

- Export renders in real time in the tab; keep it in front while it runs.
- Codecs are whatever your browser can decode (H.264/AAC in Chrome and Safari; WebM everywhere).
- One media element per source file, so the same file can't play on two overlapping tracks at once.
- Transcription chunks audio into 90-second WAV pieces to stay under serverless body limits.

## Design

`DESIGN.md` documents the system. `docs/design-passes.md` records the three review passes it went through (Emil Kowalski's design-engineering principles, then Impeccable, then Taste) and what each one changed.

## License

MIT
