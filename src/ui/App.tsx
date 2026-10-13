import { useEffect, useRef, useState } from "react";
import { PiQuestion, PiArrowClockwise, PiSlidersHorizontal, PiArrowCounterClockwise, PiUploadSimple } from "react-icons/pi";
import { fetchServerStatus } from "../ai/client";
import { applyOp, findClip } from "../engine/ops";
import { executeOps, importFiles, regenerateThumbs } from "../store/actions";
import { commit, getState, hydrate, redo, setState, undo, useStore } from "../store/store";
import { Chat } from "./Chat";
import { ExportDialog, SettingsDialog, ShortcutsDialog } from "./Dialogs";
import { isTyping, mod } from "./format";
import { bootPlayer, seek, togglePlay } from "./playback";
import { Preview } from "./Preview";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { Toaster } from "./toast";

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h7.2l-3 16H5.5A1.5 1.5 0 0 1 4 18.5z" fill="currentColor" />
      <path d="M14.3 4h4.2A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-7.2z" fill="currentColor" opacity=".45" />
    </svg>
  );
}

export function App() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const name = useStore((s) => s.project.name);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const hasClips = useStore((s) => s.project.tracks.some((t) => t.clips.length));
  const loaded = useStore((s) => s.loaded);

  useEffect(() => {
    hydrate().then(() => {
      bootPlayer();
      regenerateThumbs();
    });
    fetchServerStatus().then((server) => setState({ server }));
  }, []);

  // Keyboard: no animation is tied to any of these — they fire many times a day.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        if (isTyping(e)) return;
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (isTyping(e) || s.dialog || meta || e.altKey) return;
      const frame = 1 / s.project.fps;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "s":
        case "S":
          executeOps([{ op: "split", at: s.playhead }]);
          break;
        case "Backspace":
        case "Delete":
          if (s.selectedClipId && findClip(s.project, s.selectedClipId)) {
            e.preventDefault();
            commit(applyOp(s.project, { op: "deleteClip", clipId: s.selectedClipId }));
            setState({ selectedClipId: null });
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(s.playhead - (e.shiftKey ? 1 : frame));
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(s.playhead + (e.shiftKey ? 1 : frame));
          break;
        case "Home":
          seek(0);
          break;
        case "/":
          e.preventDefault();
          document.getElementById("ask")?.focus();
          break;
        case "?":
          setState({ dialog: "shortcuts" });
          break;
        case "Escape":
          setState({ selectedClipId: null });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drop files anywhere.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragOver(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const pick = () => fileInput.current?.click();

  if (!loaded) return null;

  return (
    <div className="app">
      <header className="head">
        <div className="wordmark">
          <Logo />
          Clevatess
        </div>
        <input
          className="project-name"
          aria-label="Project name"
          value={name}
          onChange={(e) => setState((s) => ({ project: { ...s.project, name: e.target.value } }))}
        />
        <span className="head-spacer" />
        <div className="head-group">
          <button className="btn btn-ghost btn-icon" aria-label="Undo" title={`Undo (${mod}Z)`} onClick={undo} disabled={!canUndo}>
            <PiArrowCounterClockwise size={16} />
          </button>
          <button className="btn btn-ghost btn-icon" aria-label="Redo" title={`Redo (${mod}⇧Z)`} onClick={redo} disabled={!canRedo}>
            <PiArrowClockwise size={16} />
          </button>
          <button className="btn btn-ghost btn-icon hide-sm" aria-label="Keyboard shortcuts" onClick={() => setState({ dialog: "shortcuts" })}>
            <PiQuestion size={16} />
          </button>
          <button className="btn btn-ghost btn-icon" aria-label="Model settings" onClick={() => setState({ dialog: "settings" })}>
            <PiSlidersHorizontal size={16} />
          </button>
          <button className="btn hide-sm" onClick={pick}>
            <PiUploadSimple size={14} /> Import
          </button>
          <button className="btn btn-primary" onClick={() => setState({ dialog: "export" })} disabled={!hasClips}>
            Export
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          hidden
          onChange={(e) => {
            if (e.target.files?.length) importFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </header>
      <Sidebar onPick={pick} />
      <Preview onPick={pick} />
      <Chat />
      <Timeline />
      <SettingsDialog />
      <ExportDialog />
      <ShortcutsDialog />
      <Toaster />
      <div className="drop-overlay" data-on={dragOver} aria-hidden>
        <div>Drop to add to the timeline</div>
      </div>
    </div>
  );
}
