import { useEffect, useRef, useState } from "react";
import {
  PiArrowUpBold,
  PiClosedCaptioning,
  PiCrop,
  PiPalette,
  PiRectangle,
  PiScissors,
  PiDeviceMobile,
  PiTextT,
  PiArrowCounterClockwise,
  PiSpeakerHigh,
  PiMagicWand,
} from "react-icons/pi";
import { describeOp, type Op } from "../engine/ops";
import { PRESETS } from "../ai/providers";
import { cancelAgent, sendToAgent } from "../store/actions";
import { setState, undoTo, useStore, type ChatEntry } from "../store/store";

const OP_ICON: Partial<Record<Op["op"], typeof PiScissors>> = {
  split: PiScissors,
  deleteClip: PiScissors,
  deleteRange: PiScissors,
  keepRanges: PiCrop,
  trim: PiCrop,
  addText: PiTextT,
  updateText: PiTextT,
  setVolume: PiSpeakerHigh,
  setAspect: PiRectangle,
  setCaptions: PiClosedCaptioning,
  generateCaptions: PiClosedCaptioning,
  applyBrand: PiPalette,
  removeSilence: PiMagicWand,
};

function useProviderStatus() {
  const settings = useStore((s) => s.settings);
  const server = useStore((s) => s.server);
  if (settings.mode === "builtin") return { label: "Built-in · offline", tone: "" };
  if (settings.mode === "direct") {
    const preset = PRESETS.find((p) => p.id === settings.presetId);
    return { label: `${preset?.label ?? "Custom"} · ${settings.chat.model}`, tone: "ok" };
  }
  if (server?.chat.configured) return { label: `Server · ${server.chat.model}`, tone: "ok" };
  return { label: "Server · not set up", tone: "warn" };
}

export function Chat() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.busy);
  const hasClips = useStore((s) => s.project.tracks.some((t) => t.clips.length));
  const mode = useStore((s) => s.settings.mode);
  const pastLen = useStore((s) => s.past.length);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const status = useProviderStatus();
  // Messages restored from a previous session shouldn't all animate in at once.
  const restored = useRef(new Set(chat.map((m) => m.id)));

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, busy]);

  // Grow the textarea with its content.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [text]);

  const send = (value = text) => {
    const v = value.trim();
    if (!v || busy) return;
    setText("");
    sendToAgent(v);
  };

  const suggestions = [
    { icon: PiMagicWand, text: "Remove the dead air" },
    { icon: PiClosedCaptioning, text: "Add bold captions" },
    { icon: PiDeviceMobile, text: "Make a vertical version for Reels" },
    { icon: PiTextT, text: 'Add a title "Launch day" at the start' },
    ...(mode !== "builtin" ? [{ icon: PiCrop, text: "Keep the best 30 seconds" }] : []),
  ];

  return (
    <aside className="chat" aria-label="Assistant">
      <div className="chat-head">
        Assistant
        <button className="provider-pill" onClick={() => setState({ dialog: "settings" })} title="Model settings">
          <i className={`dot ${status.tone}`} />
          <span>{status.label}</span>
        </button>
      </div>
      <div className="messages" ref={listRef}>
        {chat.length === 0 && (
          <div className="suggestions">
            <p>{hasClips ? "Describe an edit. Each change lands on the timeline, so you can tweak or undo it." : "Add a clip, then ask for an edit."}</p>
            {suggestions.map((s, i) => (
              <button
                key={s.text}
                className="suggestion"
                style={{ animationDelay: `${i * 45}ms` }}
                disabled={!hasClips || !!busy}
                onClick={() => send(s.text)}
              >
                <s.icon size={15} />
                {s.text}
              </button>
            ))}
          </div>
        )}
        {chat.map((m) => (
          <Message key={m.id} m={m} fresh={!restored.current.has(m.id)} canUndo={m.undoTo !== undefined && !m.undone && pastLen > (m.undoTo ?? 0)} />
        ))}
        {busy && (
          <div className="busy" aria-live="polite">
            <span className="pulse">{busy}…</span>
            <button className="btn btn-ghost btn-sm" onClick={cancelAgent}>
              Stop
            </button>
          </div>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="composer-box">
          <label className="sr-only" htmlFor="ask">
            Describe an edit
          </label>
          <textarea
            id="ask"
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={hasClips ? "Cut the pauses, then add captions…" : "Add a clip to start"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn btn-primary btn-icon send" type="submit" aria-label="Send" disabled={!text.trim() || !!busy}>
            <PiArrowUpBold size={16} />
          </button>
        </div>
      </form>
    </aside>
  );
}

function Message({ m, canUndo, fresh }: { m: ChatEntry; canUndo: boolean; fresh: boolean }) {
  if (m.role === "user")
    return (
      <div className="msg msg-user" data-fresh={fresh || undefined}>
        {m.text}
      </div>
    );
  return (
    <div className={`msg msg-assistant${m.error ? " error" : ""}${m.undone ? " is-undone" : ""}`} data-fresh={fresh || undefined}>
      {m.text}
      {!!m.ops?.length && (
        <div className="op-list">
          {m.ops.map((op, i) => {
            const Icon = OP_ICON[op.op] ?? PiMagicWand;
            return (
              <span className="op" key={i}>
                <Icon size={12} />
                {describeOp(op)}
              </span>
            );
          })}
        </div>
      )}
      {canUndo && (
        <div className="msg-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              undoTo(m.undoTo!);
              setState((s) => ({ chat: s.chat.map((c) => (c.id === m.id ? { ...c, undone: true } : c)) }));
            }}
          >
            <PiArrowCounterClockwise size={13} /> Undo this
          </button>
        </div>
      )}
      {m.undone && (
        <div className="undone-note">
          <PiArrowCounterClockwise size={12} /> Undone
        </div>
      )}
    </div>
  );
}
