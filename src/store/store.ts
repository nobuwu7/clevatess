// App state: a tiny external store with undo history. Every committed project
// change is one undo step, whether it came from the agent or from a drag.

import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AISettings, type ServerStatus } from "../ai/client";
import type { Op } from "../engine/ops";
import { newProject } from "../engine/project";
import type { Project } from "../engine/types";
import { loadDoc, saveDoc } from "../lib/db";

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  ops?: Op[];
  error?: boolean;
  /** History length before this turn's edits, so the turn can be undone as a unit. */
  undoTo?: number;
  undone?: boolean;
}

export type SidePanel = "media" | "brand" | "captions";

export interface State {
  project: Project;
  past: Project[];
  future: Project[];
  playhead: number;
  playing: boolean;
  selectedClipId: string | null;
  pxPerSec: number;
  side: SidePanel;
  chat: ChatEntry[];
  busy: string | null; // what the agent/executor is doing right now
  settings: AISettings;
  server: ServerStatus | null;
  dialog: null | "settings" | "export" | "shortcuts";
  thumbs: Record<string, string[]>; // assetId -> filmstrip data URLs
  thumbStep: Record<string, number>; // seconds between thumbnails
  /** Cut points made by the last assistant/tool edit, so the user can see what it touched. */
  seams: number[];
  seamsKey: number;
  importing: number;
  loaded: boolean;
}

type Listener = () => void;

const initial: State = {
  project: newProject(),
  past: [],
  future: [],
  playhead: 0,
  playing: false,
  selectedClipId: null,
  pxPerSec: 60,
  side: "media",
  chat: [],
  busy: null,
  settings: typeof localStorage !== "undefined" ? loadSettings() : DEFAULT_SETTINGS,
  server: null,
  dialog: null,
  thumbs: {},
  thumbStep: {},
  seams: [],
  seamsKey: 0,
  importing: 0,
  loaded: false,
};

let state: State = initial;
const listeners = new Set<Listener>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
  if ("settings" in next && next.settings) saveSettings(next.settings);
  if ("project" in next || "chat" in next) schedulePersist();
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(initial));
}

const HISTORY_LIMIT = 100;

/** Commit a new project revision as one undoable step. */
export function commit(project: Project) {
  setState((s) => ({
    project,
    past: [...s.past, s.project].slice(-HISTORY_LIMIT),
    future: [],
    seams: [],
  }));
}

export function undo() {
  const s = getState();
  const prev = s.past[s.past.length - 1];
  if (!prev) return false;
  setState({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], seams: [] });
  return true;
}

export function redo() {
  const s = getState();
  const next = s.future[0];
  if (!next) return false;
  setState({ project: next, past: [...s.past, s.project], future: s.future.slice(1), seams: [] });
  return true;
}

/** Roll back to a point in history (used by "Undo" on an agent turn). */
export function undoTo(length: number) {
  const s = getState();
  if (length >= s.past.length + 1 || length < 0) return;
  const target = s.past[length];
  if (!target) return;
  const dropped = [...s.past.slice(length + 1), s.project];
  setState({ project: target, past: s.past.slice(0, length), future: [...dropped, ...s.future], seams: [] });
}

// Persistence -------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (!state.loaded) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    saveDoc("current", { project: state.project, chat: state.chat.slice(-60) });
  }, 400);
}

export async function hydrate() {
  const saved = await loadDoc<{ project: Project; chat: ChatEntry[] }>("current");
  if (saved?.project) {
    // Fill in fields added in later versions.
    const fresh = newProject();
    const project = {
      ...fresh,
      ...saved.project,
      captions: { ...fresh.captions, ...saved.project.captions },
      brand: { ...fresh.brand, ...saved.project.brand },
    };
    setState({ project, chat: (saved.chat ?? []).map((c) => ({ ...c, undoTo: undefined })), loaded: true });
  } else {
    setState({ loaded: true });
  }
}
