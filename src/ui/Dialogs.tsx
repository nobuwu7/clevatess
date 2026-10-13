import { useEffect, useRef, useState, type ReactNode } from "react";
import { PiCheck, PiDownloadSimple, PiSpinnerGap, PiX } from "react-icons/pi";
import { fetchServerStatus, type AISettings, type Mode } from "../ai/client";
import { chat, PRESETS, TRANSCRIBE_PRESETS } from "../ai/providers";
import { buildCues, timelineWords, toSRT } from "../engine/captions";
import { exportProject, pickMime } from "../engine/export";
import { projectDuration } from "../engine/ops";
import { ASPECTS, type AspectRatio } from "../engine/types";
import { getBlob } from "../lib/db";
import { getState, setState, useStore } from "../store/store";
import { mod, shortTime } from "./format";
import { player } from "./playback";
import { toast } from "./toast";

function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      style={wide ? { width: "min(640px, calc(100vw - 32px))" } : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
    >
      <div className="modal-inner">
        <div className="modal-head">
          <h2>{title}</h2>
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
            <PiX size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </dialog>
  );
}

const close = () => setState({ dialog: null });

// Settings ---------------------------------------------------------------

export function SettingsDialog() {
  const open = useStore((s) => s.dialog === "settings");
  const saved = useStore((s) => s.settings);
  const server = useStore((s) => s.server);
  const [s, setS] = useState<AISettings>(saved);
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "fail"; msg?: string }>({ state: "idle" });

  useEffect(() => {
    if (open) {
      setS(saved);
      setTest({ state: "idle" });
      fetchServerStatus().then((st) => setState({ server: st }));
    }
  }, [open]);

  const setMode = (mode: Mode) =>
    setS((x) => {
      // Leaving built-in for direct: start from a real provider, not the empty rules config.
      if (mode === "direct" && x.chat.kind === "builtin") {
        const first = PRESETS.find((p) => p.id === "ollama")!;
        return { ...x, mode, presetId: first.id, chat: { ...first.config } };
      }
      if (mode === "builtin") return { ...x, mode, presetId: "builtin", chat: { ...PRESETS[0].config } };
      return { ...x, mode };
    });
  const preset = PRESETS.find((p) => p.id === s.presetId);

  const runTest = async () => {
    setTest({ state: "running" });
    try {
      if (s.mode === "server") {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: 'Reply with exactly {"reply":"ok","ops":[]}' }] }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
      } else {
        await chat(s.chat, [{ role: "user", content: 'Reply with exactly {"reply":"ok","ops":[]}' }]);
      }
      setTest({ state: "ok", msg: "Connected" });
    } catch (e) {
      setTest({ state: "fail", msg: (e as Error).message });
    }
  };

  const save = () => {
    setState({ settings: s, dialog: null });
    toast("Settings saved");
  };

  return (
    <Modal
      open={open}
      title="Model settings"
      onClose={close}
      wide
      footer={
        <>
          {s.mode !== "builtin" && (
            <button className="btn" onClick={runTest} disabled={test.state === "running"} style={{ marginRight: "auto" }}>
              {test.state === "running" ? <PiSpinnerGap size={14} className="spin" /> : test.state === "ok" ? <PiCheck size={14} color="var(--ok)" /> : null}
              Test connection
            </button>
          )}
          <button className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="section-label">Where the assistant's model runs</div>
      <div className="choice-grid">
        <button className="choice" aria-pressed={s.mode === "builtin"} onClick={() => setMode("builtin")}>
          <b>Built-in</b>
          <small>Offline rules. Simple commands only.</small>
        </button>
        <button className="choice" aria-pressed={s.mode === "direct"} onClick={() => setMode("direct")}>
          <b>From this browser</b>
          <small>Local server or your own API key</small>
        </button>
        <button className="choice" aria-pressed={s.mode === "server"} onClick={() => setMode("server")}>
          <b>Deployment server</b>
          <small>Keys kept in environment variables</small>
        </button>
      </div>

      {s.mode === "direct" && (
        <>
          <div className="section-label">Provider</div>
          <div className="choice-grid">
            {PRESETS.filter((p) => p.id !== "builtin").map((p) => (
              <button
                key={p.id}
                className="choice"
                aria-pressed={s.presetId === p.id}
                onClick={() => setS((x) => ({ ...x, presetId: p.id, chat: { ...p.config, apiKey: x.presetId === p.id ? x.chat.apiKey : "" } }))}
              >
                <b>{p.label}</b>
                <small>{p.where === "local" ? "Runs on your machine" : "Cloud"}</small>
              </button>
            ))}
          </div>
          {preset?.note && <div className="note">{preset.note}</div>}
          <label className="field">
            <span>Base URL</span>
            <input className="input tabular" value={s.chat.baseUrl} onChange={(e) => setS((x) => ({ ...x, chat: { ...x.chat, baseUrl: e.target.value } }))} spellCheck={false} />
          </label>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Model</span>
              <input className="input tabular" value={s.chat.model} onChange={(e) => setS((x) => ({ ...x, chat: { ...x.chat, model: e.target.value } }))} spellCheck={false} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>API key {preset?.where === "local" && <small>(usually not needed)</small>}</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={s.chat.apiKey ?? ""}
                onChange={(e) => setS((x) => ({ ...x, chat: { ...x.chat, apiKey: e.target.value } }))}
              />
            </label>
          </div>
          <div className="note" style={{ marginTop: -4 }}>
            Keys entered here are stored only in this browser and sent straight to the provider.
          </div>
        </>
      )}

      {s.mode === "server" && (
        <div className="note">
          {server?.chat.configured ? (
            <div className="status-line">
              <i className="dot ok" /> Using {server.chat.provider} · <span className="tabular">{server.chat.model}</span>
            </div>
          ) : (
            <>
              <div className="status-line" style={{ marginBottom: 8 }}>
                <i className="dot warn" /> No model configured on this deployment
              </div>
              Set <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> or <code>GROQ_API_KEY</code> in your Vercel project, or{" "}
              <code>AI_BASE_URL</code> + <code>AI_MODEL</code> (+ <code>AI_API_KEY</code>) for any OpenAI-compatible server, including a
              self-hosted one reachable from the internet.
            </>
          )}
        </div>
      )}

      {test.state === "fail" && (
        <div className="note" style={{ color: "var(--danger)", borderColor: "rgba(255,107,94,.3)" }}>
          {test.msg}
        </div>
      )}

      <div className="section-label" style={{ marginTop: 22 }}>
        Transcription (for captions)
      </div>
      <div className="seg" role="group" style={{ marginBottom: 12 }}>
        {(["server", "direct", "off"] as const).map((m) => (
          <button key={m} aria-pressed={s.transcribeMode === m} onClick={() => setS((x) => ({ ...x, transcribeMode: m }))}>
            {m === "server" ? "Deployment server" : m === "direct" ? "From this browser" : "Off"}
          </button>
        ))}
      </div>
      {s.transcribeMode === "server" && (
        <div className="note">
          {server?.transcribe.configured ? (
            <div className="status-line">
              <i className="dot ok" /> Server transcription ready · <span className="tabular">{server.transcribe.model}</span>
            </div>
          ) : (
            <>
              Not configured. Set <code>OPENAI_API_KEY</code> or <code>GROQ_API_KEY</code>, or <code>TRANSCRIBE_BASE_URL</code> +{" "}
              <code>TRANSCRIBE_MODEL</code> for any Whisper-compatible service.
            </>
          )}
        </div>
      )}
      {s.transcribeMode === "direct" && (
        <>
          <div className="choice-grid">
            {TRANSCRIBE_PRESETS.map((p) => (
              <button
                key={p.id}
                className="choice"
                aria-pressed={s.transcribe.baseUrl === p.config.baseUrl && s.transcribe.model === p.config.model}
                onClick={() => setS((x) => ({ ...x, transcribe: { ...p.config, apiKey: x.transcribe.apiKey } }))}
              >
                <b>{p.label}</b>
                <small>{p.where === "local" ? "Runs on your machine" : "Cloud"}</small>
              </button>
            ))}
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <label className="field" style={{ flex: 2 }}>
              <span>Base URL</span>
              <input className="input tabular" value={s.transcribe.baseUrl} onChange={(e) => setS((x) => ({ ...x, transcribe: { ...x.transcribe, baseUrl: e.target.value } }))} spellCheck={false} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>API key</span>
              <input className="input" type="password" autoComplete="off" value={s.transcribe.apiKey ?? ""} onChange={(e) => setS((x) => ({ ...x, transcribe: { ...x.transcribe, apiKey: e.target.value } }))} />
            </label>
          </div>
          <label className="field">
            <span>Model</span>
            <input className="input tabular" value={s.transcribe.model} onChange={(e) => setS((x) => ({ ...x, transcribe: { ...x.transcribe, model: e.target.value } }))} spellCheck={false} />
          </label>
        </>
      )}
    </Modal>
  );
}

// Export -------------------------------------------------------------------

type JobState = { aspect: AspectRatio; progress: number; url?: string; size?: number; error?: string; ext?: string };

function AspectGlyph({ a }: { a: AspectRatio }) {
  const { w, h } = ASPECTS[a];
  const s = 16 / Math.max(w, h);
  return <span className="aspect-glyph" style={{ width: w * s, height: h * s }} />;
}

export function ExportDialog() {
  const open = useStore((s) => s.dialog === "export");
  const project = useStore((s) => s.project);
  const [picked, setPicked] = useState<Set<AspectRatio>>(new Set([project.aspect]));
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const dur = projectDuration(project);
  const { ext } = pickMime();
  const hasTranscript = project.transcripts.length > 0;

  useEffect(() => {
    if (open && !running) {
      setPicked(new Set([project.aspect]));
      setJobs((j) => {
        j.forEach((x) => x.url && URL.revokeObjectURL(x.url));
        return [];
      });
    }
  }, [open]);

  const start = async () => {
    const list = (["16:9", "9:16", "1:1", "4:5"] as AspectRatio[]).filter((a) => picked.has(a));
    setJobs(list.map((aspect) => ({ aspect, progress: 0 })));
    setRunning(true);
    player.pause();
    setState({ playing: false });
    abort.current = new AbortController();
    for (const aspect of list) {
      try {
        const variant = { ...structuredClone(getState().project), aspect };
        const res = await exportProject(
          variant,
          getBlob,
          (f) => setJobs((js) => js.map((j) => (j.aspect === aspect ? { ...j, progress: f } : j))),
          abort.current.signal,
        );
        const url = URL.createObjectURL(res.blob);
        setJobs((js) => js.map((j) => (j.aspect === aspect ? { ...j, progress: 1, url, size: res.blob.size, ext: res.ext } : j)));
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setJobs((js) => js.map((j) => (j.url ? j : { ...j, error: "Cancelled" })));
          break;
        }
        setJobs((js) => js.map((j) => (j.aspect === aspect ? { ...j, error: (e as Error).message } : j)));
      }
    }
    setRunning(false);
  };

  const fileName = (a: AspectRatio, e = ext) => `${(project.name || "clevatess").replace(/[^\w-]+/g, "-")}-${a.replace(":", "x")}.${e}`;

  return (
    <Modal
      open={open}
      title="Export"
      onClose={() => {
        if (running) abort.current?.abort();
        close();
      }}
      footer={
        running ? (
          <button className="btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        ) : (
          <>
            {hasTranscript && (
              <button
                className="btn btn-ghost"
                style={{ marginRight: "auto" }}
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([toSRT(buildCues(timelineWords(project), project.captions.maxWords))], { type: "text/plain" }));
                  a.download = `${project.name || "captions"}.srt`;
                  a.click();
                }}
              >
                Captions .srt
              </button>
            )}
            <button className="btn btn-primary" onClick={start} disabled={!picked.size || !dur}>
              Export {picked.size > 1 ? `${picked.size} versions` : ""}
            </button>
          </>
        )
      }
    >
      {!jobs.length ? (
        <>
          <p style={{ margin: "0 0 14px", color: "var(--muted)" }}>
            One edit, every shape. Each version reframes with your brand kit's fit setting and keeps captions, titles and logo placed for that
            frame.
          </p>
          {(["16:9", "9:16", "1:1", "4:5"] as AspectRatio[]).map((a) => (
            <label className="variant" key={a}>
              <input
                type="checkbox"
                checked={picked.has(a)}
                onChange={(e) => {
                  const n = new Set(picked);
                  e.target.checked ? n.add(a) : n.delete(a);
                  setPicked(n);
                }}
              />
              <span>
                <AspectGlyph a={a} />
                {ASPECTS[a].label} <span style={{ color: "var(--faint)" }}>{a}</span>
              </span>
              <span className="tabular" style={{ color: "var(--faint)", fontSize: 12 }}>
                {ASPECTS[a].w}×{ASPECTS[a].h}
              </span>
            </label>
          ))}
          <div className="note" style={{ marginTop: 12, marginBottom: 0 }}>
            Rendering happens in this tab, in real time ({shortTime(dur)} per version), as .{ext}. Keep the tab in front until it finishes.
          </div>
        </>
      ) : (
        jobs.map((j) => (
          <div className="variant" key={j.aspect} style={{ gridTemplateColumns: "1fr auto" }}>
            <div>
              <AspectGlyph a={j.aspect} />
              {ASPECTS[j.aspect].label} <span style={{ color: "var(--faint)" }}>{j.aspect}</span>
              {j.error ? (
                <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 4 }}>{j.error}</div>
              ) : !j.url ? (
                <div className="progress" aria-label={`${Math.round(j.progress * 100)}%`}>
                  <i style={{ transform: `scaleX(${j.progress})` }} />
                </div>
              ) : null}
            </div>
            {j.url ? (
              <a className="btn btn-sm" href={j.url} download={fileName(j.aspect, j.ext)}>
                <PiDownloadSimple size={14} /> {((j.size ?? 0) / 1024 / 1024).toFixed(1)} MB
              </a>
            ) : (
              <span className="tabular" style={{ color: "var(--faint)", fontSize: 12 }}>
                {j.error ? "" : `${Math.round(j.progress * 100)}%`}
              </span>
            )}
          </div>
        ))
      )}
    </Modal>
  );
}

// Shortcuts ---------------------------------------------------------------

export function ShortcutsDialog() {
  const open = useStore((s) => s.dialog === "shortcuts");
  const rows: [string, string[]][] = [
    ["Play / pause", ["Space"]],
    ["Split at playhead", ["S"]],
    ["Delete selected clip", ["⌫"]],
    ["Step one frame", ["←", "→"]],
    ["Jump one second", ["⇧", "←/→"]],
    ["Undo", [mod, "Z"]],
    ["Redo", [mod, "⇧", "Z"]],
    ["Focus the assistant", ["/"]],
    ["Zoom timeline", [mod, "scroll"]],
  ];
  return (
    <Modal open={open} title="Keyboard shortcuts" onClose={close}>
      {rows.map(([label, keys]) => (
        <div className="shortcut-row" key={label}>
          <span>{label}</span>
          <span className="row" style={{ gap: 4 }}>
            {keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </span>
        </div>
      ))}
    </Modal>
  );
}
