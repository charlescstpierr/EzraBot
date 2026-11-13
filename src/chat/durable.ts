import type { KeyValueStorage } from "../../server/web/drafts";

const values = new Map<string, string>();
const POINTER = "ezra-idb-v1";
let database: IDBDatabase | null = null;
let pending: Promise<void> = Promise.resolve();
let failed = false;
export async function hydrateAttachments(): Promise<void> {
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ezra-chat-durable-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("values");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database!.transaction("values", "readonly");
      const cursor = tx.objectStore("values").openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (entry) {
          if (typeof entry.key === "string" && typeof entry.value === "string")
            values.set(entry.key, entry.value);
          entry.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    failed = true;
  }
}
function change(key: string, value: string | null): void {
  if (value === null) values.delete(key);
  else values.set(key, value);
  pending = pending.then(
    () =>
      new Promise<void>((resolve) => {
        if (!database) {
          failed = true;
          resolve();
          return;
        }
        const tx = database.transaction("values", "readwrite");
        const store = tx.objectStore("values");
        if (value === null) store.delete(key);
        else store.put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => {
          failed = true;
          resolve();
        };
      }),
  );
}
export async function flushAttachments(): Promise<boolean> {
  await pending;
  return !failed;
}
window.addEventListener("storage", (event) => {
  if (event.storageArea !== localStorage || !event.key) return;
  const key = event.key;
  if (!event.newValue?.startsWith(POINTER)) {
    values.delete(key);
    return;
  }
  if (!database) return;
  const request = database
    .transaction("values", "readonly")
    .objectStore("values")
    .get(key);
  request.onsuccess = () => {
    if (localStorage.getItem(key) !== event.newValue) return;
    if (typeof request.result === "string") values.set(key, request.result);
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: event.newValue }),
    );
  };
});
export const attachmentStorage: KeyValueStorage = {
  get length() {
    return new Set([...values.keys(), ...Object.keys(localStorage)]).size;
  },
  key(index) {
    return (
      [...new Set([...values.keys(), ...Object.keys(localStorage)])][index] ??
      null
    );
  },
  getItem(key) {
    const value = localStorage.getItem(key);
    return value?.startsWith(POINTER) ? (values.get(key) ?? null) : value;
  },
  setItem(key, value) {
    if (value.length < 32768) {
      localStorage.setItem(key, value);
      if (values.has(key)) change(key, null);
    } else {
      change(key, value);
      localStorage.setItem(key, POINTER + crypto.randomUUID());
      if (failed) throw Error("Stockage durable indisponible");
    }
  },
  removeItem(key) {
    change(key, null);
    localStorage.removeItem(key);
  },
};
