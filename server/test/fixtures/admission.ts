import { join } from 'node:path';
import type { Admission } from '../../src/admission.js';
import { loadMascots } from '../../src/domain.js';
import { openStore, type Store } from '../../src/store.js';

const mascots = loadMascots(new URL('../../../assets/mascots.json', import.meta.url));
const stores = new Map<string, Store>();

/**
 * The real admission registry of a data folder, in `admission.sqlite` there, for a missions registry tested without the chat.
 * One store per folder, kept open: the database is locked while a store uses it.
 */
export function admissionIn(dataDir: string): Admission {
  let store = stores.get(dataDir);
  if (!store) {
    store = openStore({ path: join(dataDir, 'admission.sqlite'), mascots });
    stores.set(dataDir, store);
  }
  return store.admission;
}
