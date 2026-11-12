/** Browser persistence with a page-local fallback when access or quota is refused. */
const memory = new Map<string, string | null>();
const pending = new Set<string>();
export let storageUnavailable = false;

export const storage = {
  getItem(key: string): string | null {
    if (pending.has(key)) return memory.get(key) ?? null;
    try {
      const value = window.localStorage.getItem(key);
      memory.set(key, value);
      return value;
    } catch {
      storageUnavailable = true;
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
    pending.add(key);
    try {
      window.localStorage.setItem(key, value);
      pending.delete(key);
    } catch {
      storageUnavailable = true;
    }
  },
  removeItem(key: string): void {
    memory.set(key, null);
    pending.add(key);
    try {
      window.localStorage.removeItem(key);
      pending.delete(key);
    } catch {
      storageUnavailable = true;
    }
  },
};
