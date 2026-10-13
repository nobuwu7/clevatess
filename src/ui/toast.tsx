import { useSyncExternalStore } from "react";
import { PiWarningCircle, PiCheck } from "react-icons/pi";

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
  leaving?: boolean;
}

let toasts: Toast[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
let n = 0;

export function toast(text: string, kind: "info" | "error" = "info") {
  const id = ++n;
  toasts = [...toasts.slice(-3), { id, text, kind }];
  emit();
  // Pause-free but generous: errors stay longer so they can be read.
  const ttl = kind === "error" ? 6000 : 3200;
  setTimeout(() => {
    toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
    emit();
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }, 180);
  }, ttl);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => toasts,
    () => toasts,
  );
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`} data-leaving={t.leaving || undefined}>
          {t.kind === "error" ? <PiWarningCircle size={14} /> : <PiCheck size={14} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}
