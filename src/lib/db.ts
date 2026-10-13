// Minimal IndexedDB wrapper: media blobs and the project document live in the browser.

const DB = "clevatess";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= open());

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// In-memory fallback so the editor still works in private windows where IDB is blocked.
const memory = new Map<string, Blob>();

export async function putBlob(id: string, blob: Blob) {
  memory.set(id, blob);
  try {
    await tx("blobs", "readwrite", (s) => s.put(blob, id));
  } catch {
    /* memory copy is enough for this session */
  }
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  const m = memory.get(id);
  if (m) return m;
  try {
    const b = await tx<Blob | undefined>("blobs", "readonly", (s) => s.get(id));
    if (b) memory.set(id, b);
    return b;
  } catch {
    return undefined;
  }
}

export async function deleteBlob(id: string) {
  memory.delete(id);
  try {
    await tx("blobs", "readwrite", (s) => s.delete(id));
  } catch {}
}

export async function saveDoc<T>(key: string, value: T) {
  try {
    await tx("projects", "readwrite", (s) => s.put(value, key));
  } catch {}
}

export async function loadDoc<T>(key: string): Promise<T | undefined> {
  try {
    return await tx<T | undefined>("projects", "readonly", (s) => s.get(key));
  } catch {
    return undefined;
  }
}
