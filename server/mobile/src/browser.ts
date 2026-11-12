import { z } from 'zod';
import { BrowserSessionSchema, BrowserSessionStatusSchema } from './generated/mobile-protocol';
import { RemoteError, safeBase, scope, type Storage } from './controller';

const key = 'mino-browser-identity-v1';
const savedSchema = z.strictObject({ session: BrowserSessionSchema, claim: z.null() });
type Cache = Pick<Storage, 'read' | 'write' | 'remove'>;

export function createBrowserAccess(cache: Cache, origin: string, fetcher: typeof fetch = fetch) {
  const base = safeBase(origin);
  async function saved() {
    const raw = await cache.read(key);
    if (!raw) return null;
    try { return savedSchema.parse(JSON.parse(raw)); }
    catch { await cache.remove(key); return null; }
  }
  async function request(path: string, body?: unknown): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const response = await fetcher(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', 'X-Mino-Web': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
        throw new RemoteError(response.status, error.success ? error.data.code : 'browser_error', error.success ? error.data.message : 'Connexion au PC indisponible.');
      }
      return value;
    } finally { clearTimeout(timer); }
  }
  function checked(value: unknown) {
    const status = BrowserSessionStatusSchema.parse(value);
    if (status.state !== 'unpaired' && safeBase(status.session.url) !== base)
      throw Error('La réponse appartient à un autre ordinateur.');
    return status;
  }
  return {
    async readSecret(): Promise<string | null> {
      const prior = await saved();
      let value: unknown;
      try { value = await request('/m/browser/session'); }
      catch (error) {
        if (prior && !(error instanceof RemoteError)) return JSON.stringify(prior);
        throw error;
      }
      const status = checked(value);
      if (status.state === 'unpaired') {
        if (prior) await cache.remove(scope(prior.session));
        await cache.remove(key);
        return null;
      }
      if (prior && scope(prior.session) !== scope(status.session)) await cache.remove(scope(prior.session));
      const raw = JSON.stringify({ session: status.session, claim: null });
      await cache.write(key, raw);
      return raw;
    },
    async writeSecret(raw: string | null) {
      if (raw === null) { await cache.remove(key); return; }
      const value = savedSchema.parse(JSON.parse(raw));
      if (safeBase(value.session.url) !== base) throw Error('Autre ordinateur.');
      await cache.write(key, JSON.stringify(value));
    },
    async claim(deviceName: string) {
      const status = checked(await request('/m/browser/claim', { deviceName }));
      if (status.state === 'unpaired') throw Error('La demande d’accès n’a pas été enregistrée.');
      return status.session;
    },
    async forget() { await request('/m/browser/logout', {}); },
  };
}
