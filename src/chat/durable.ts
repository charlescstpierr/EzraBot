import type { KeyValueStorage } from "../../server/web/drafts";

const POINTER = "ezra-idb-v1";
type Write = {
  value: () => string;
  raw?: string;
  state: "waiting" | "writing" | "failed";
  timer?: ReturnType<typeof setTimeout>;
};
const writes = new Map<string, Write>();
const active = new Map<string, Promise<void>>();
const values = new Map<string, string>();
let database: IDBDatabase | null = null;
let opening: Promise<void> | null = null;
const notify = () => window.dispatchEvent(new Event("attachment-storage"));
export function attachmentStatus(): "durable" | "saving" | "failed" {
  return [...writes.values()].some((w) => w.state === "failed")
    ? "failed"
    : writes.size
      ? "saving"
      : "durable";
}
export async function hydrateAttachments(): Promise<void> {
  if (database) return;
  if (opening) return opening;
  opening = (async () => {
    try {
      database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ezra-chat-durable-v1", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("values");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await Promise.all(
        Object.keys(localStorage).map(async (key) => {
          const pointer = localStorage.getItem(key);
          if (!pointer?.startsWith(POINTER)) return;
          const value = await read(pointer, key);
          if (value !== null) values.set(key, value);
        }),
      );
    } catch {
      database = null;
    }
  })();
  await opening;
  opening = null;
}
function read(pointer: string, legacyKey: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!database) return resolve(null);
    const store = database.transaction("values").objectStore("values");
    const request = store.get(pointer);
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      if (typeof request.result === "string") return resolve(request.result);
      const legacy = store.get(legacyKey);
      legacy.onerror = () => resolve(null);
      legacy.onsuccess = () =>
        resolve(typeof legacy.result === "string" ? legacy.result : null);
    };
  });
}
function erase(id: string): Promise<void> {
  return new Promise((resolve) => {
    if (!database) return resolve();
    const tx = database.transaction("values", "readwrite");
    tx.objectStore("values").delete(id);
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}
async function commit(key: string, write: Write): Promise<void> {
  clearTimeout(write.timer);
  if (active.has(key)) return active.get(key);
  write.state = "writing";
  const task = Promise.resolve().then(async () => {
    let pointer: string | null = null;
    try {
      const raw = (write.raw ??= write.value());
      const previous = localStorage.getItem(key);
      if (raw.length >= 32768) {
        await hydrateAttachments();
        if (!database) throw Error("Stockage indisponible");
        pointer = POINTER + crypto.randomUUID();
        await new Promise<void>((resolve, reject) => {
          const tx = database!.transaction("values", "readwrite");
          tx.objectStore("values").put(raw, pointer!);
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
      }
      if (writes.get(key) !== write) {
        if (pointer) await erase(pointer);
        return;
      }
      localStorage.setItem(key, pointer ?? raw);
      if (pointer) values.set(key, raw);
      else values.delete(key);
      writes.delete(key);
      if (previous?.startsWith(POINTER)) await erase(previous);
      await erase(key);
    } catch {
      if (pointer) await erase(pointer);
      if (writes.get(key) === write) write.state = "failed";
    } finally {
      active.delete(key);
      const next = writes.get(key);
      if (next && next !== write && next.state === "waiting") {
        clearTimeout(next.timer);
        next.timer = setTimeout(() => {
          void commit(key, next);
        }, 150);
      }
      notify();
    }
  });
  active.set(key, task);
  return task;
}
function schedule(key: string, value: () => string): void {
  const previous = writes.get(key);
  clearTimeout(previous?.timer);
  const write: Write = { value, state: "waiting" };
  writes.set(key, write);
  write.timer = setTimeout(() => {
    void commit(key, write);
  }, 150);
  notify();
}
export async function flushAttachments(key?: string): Promise<boolean> {
  const selected = key ? [key] : [...writes.keys()];
  await Promise.all(
    selected.map(async (key) => {
      const write = writes.get(key);
      if (write) {
        await commit(key, write);
        const latest = writes.get(key);
        if (latest && latest !== write) await commit(key, latest);
      }
    }),
  );
  return selected.every((key) => !writes.has(key));
}
window.addEventListener("beforeunload", (event) => {
  if (!writes.size) return;
  void flushAttachments();
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage || !event.key) return;
  const key = event.key;
  if (!event.newValue?.startsWith(POINTER)) {
    values.delete(key);
    if (event.newValue === null) {
      clearTimeout(writes.get(key)?.timer);
      writes.delete(key);
    }
    notify();
    return;
  }
  const pointer = event.newValue;
  void read(pointer, key).then((value) => {
    if (localStorage.getItem(key) !== pointer) return;
    if (value !== null) values.set(key, value);
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: pointer }),
    );
  });
});
export const attachmentStorage: KeyValueStorage = {
  get length() {
    return new Set([...writes.keys(), ...Object.keys(localStorage)]).size;
  },
  key(index) {
    return (
      [...new Set([...writes.keys(), ...Object.keys(localStorage)])][index] ??
      null
    );
  },
  getItem(key) {
    const write = writes.get(key);
    if (write) return (write.raw ??= write.value());
    const value = localStorage.getItem(key);
    return value?.startsWith(POINTER) ? (values.get(key) ?? null) : value;
  },
  setDeferred: schedule,
  committed: (key) => !writes.has(key),
  flush: flushAttachments,
  durable: () => attachmentStatus() !== "failed",
  setItem(key, value) {
    if (value.length >= 32768) schedule(key, () => value);
    else {
      const previous = localStorage.getItem(key);
      localStorage.setItem(key, value);
      clearTimeout(writes.get(key)?.timer);
      writes.delete(key);
      values.delete(key);
      if (previous?.startsWith(POINTER)) void erase(previous);
      void erase(key);
      notify();
    }
  },
  removeItem(key) {
    const previous = localStorage.getItem(key);
    localStorage.removeItem(key);
    clearTimeout(writes.get(key)?.timer);
    writes.delete(key);
    values.delete(key);
    if (previous?.startsWith(POINTER)) void erase(previous);
    void erase(key);
    notify();
  },
};
