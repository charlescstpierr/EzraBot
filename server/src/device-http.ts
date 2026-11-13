import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { createBrowserStatic } from './browser-static.js';
import type { BrowserAdmission } from './web-admission.js';
import { DeviceError, type Devices } from './devices.js';
import { resolveChoice } from './domain.js';
import type { Engine } from './engine.js';
import { CommandSchema, LIMITS, type AppView } from './protocol.js';
import { MobileSnapshotSchema } from './mobile-protocol.js';
import type { Store } from './store.js';
import type { Worker } from './worker.js';
import type { AgentRoutes } from './agent-http.js';

type Options = { store: Store; worker: Worker; engine: Engine; devices: Devices; publicUrl: string; allowedOrigins?: readonly string[]; longPollMs?: number; browserAdmission?: BrowserAdmission; browserClientDir?: string; agents?: AgentRoutes };
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const browserCookie = '__Host-mino-device';
type Credentials = { kind: 'none' } | { kind: 'bearer'; token: string } | { kind: 'cookie'; token: string };
function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) count++;
  return count;
}
function credentials(req: IncomingMessage): Credentials {
  const cookies: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() !== 'cookie') continue;
    for (const cookie of (req.rawHeaders[i + 1] ?? '').split(';')) {
      const separator = cookie.indexOf('=');
      const name = (separator < 0 ? cookie : cookie.slice(0, separator)).trim();
      if (name === browserCookie) cookies.push(separator < 0 ? '' : cookie.slice(separator + 1).trim());
    }
  }
  const authorizations = headerCount(req, 'authorization');
  if (authorizations > 1 || cookies.length > 1 || (authorizations && cookies.length)) throw new DeviceError(400, 'ambiguous_credentials', 'Identifiants contradictoires.');
  const cookie = cookies[0];
  if (cookie !== undefined) return { kind: 'cookie', token: cookie };
  if (authorizations) return { kind: 'bearer', token: req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '' };
  return { kind: 'none' };
}
function setCookie(res: ServerResponse, token: string, expires: number): void {
  const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  res.setHeader('set-cookie', `${browserCookie}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}`);
}
function clearCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${browserCookie}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}
function cookieExpiry(device: ReturnType<Devices['authenticate']>): number {
  return device.state === 'pending' ? device.created + 30 * 24 * 60 * 60_000 : device.expires;
}

export function createDeviceHandler(options: Options) {
  const originSet = new Set(options.allowedOrigins ?? []);
  const publicOrigin = new URL(options.publicUrl).origin;
  const host = new URL(options.publicUrl).host;
  const browserStatic = options.browserClientDir ? createBrowserStatic(options.browserClientDir) : undefined;
  const claimRates = new Map<string, { at: number; count: number }>();
  function send(res: ServerResponse, status: number, value: unknown) {
    const body = JSON.stringify(value);
    res.writeHead(status, headers); res.end(body);
  }
  async function read(req: IncomingMessage): Promise<unknown> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new DeviceError(415, 'content_type', 'Format refusé.');
    const parts: Buffer[] = []; let bytes = 0;
    for await (const part of req) { const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part)); bytes += buffer.length; if (bytes > LIMITS.requestBodyBytes) throw new DeviceError(413, 'body_too_large', 'Cette demande est trop volumineuse.'); parts.push(buffer); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new DeviceError(400, 'invalid_json', 'Contenu JSON invalide.'); }
  }
  const snapshot = () => {
    const view: AppView = { ...options.store.view(), engine: options.engine.status() };
    return MobileSnapshotSchema.parse({ ...view, schemaVersion: 1 });
  };
  function limitClaim(req: IncomingMessage): void {
    const address = req.socket.remoteAddress ?? 'unknown';
    let rate = claimRates.get(address);
    if (!rate || Date.now() - rate.at > 60_000) {
      if (claimRates.size >= 256) { const first = claimRates.keys().next().value; if (first !== undefined) claimRates.delete(first); }
      rate = { at: Date.now(), count: 0 }; claimRates.set(address, rate);
    }
    if (++rate.count > 30) throw new DeviceError(429, 'rate_limit', 'Trop de tentatives. Réessayez dans une minute.');
  }
  function browserIdentity(auth: Credentials) {
    if (auth.kind !== 'cookie') return null;
    try { return options.devices.authenticate(auth.token, options.devices.spaceId, true); }
    catch (error) {
      if (error instanceof DeviceError && (error.status === 401 || error.code === 'space_mismatch')) return null;
      throw error;
    }
  }
  function browserSession(res: ServerResponse, token: string, device: ReturnType<Devices['authenticate']>) {
    setCookie(res, token, cookieExpiry(device));
    return { state: device.state, session: { kind: 'cookie', url: publicOrigin, spaceId: device.space, deviceId: device.id }, confirmCode: device.code, expiresAt: new Date(device.expires).toISOString() };
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (headerCount(req, 'host') !== 1 || req.headers.host !== host) throw new DeviceError(421, 'host_refused', 'Hôte refusé.');
    const auth = credentials(req);
    const url = new URL(req.url ?? '/', options.publicUrl);
    const browserRoute = url.pathname.startsWith('/m/browser/');
    const browserApi = browserRoute || (url.pathname.startsWith('/m/') && auth.kind === 'cookie');
    const origin = req.headers.origin;
    if (browserApi) {
      if (auth.kind === 'bearer') throw new DeviceError(400, 'ambiguous_credentials', 'Cette connexion utilise un cookie Safari.');
      if (req.headers['x-mino-web'] !== '1' || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new DeviceError(403, 'browser_request_refused', 'Ouvre Mino depuis son adresse Safari.');
      if ((req.method === 'POST' && origin !== publicOrigin) || (origin !== undefined && origin !== publicOrigin)) throw new DeviceError(403, 'origin_refused', 'Origine refusée.');
    } else {
      if (origin && origin !== publicOrigin && !originSet.has(origin)) throw new DeviceError(403, 'origin_refused', 'Origine refusée.');
      if (origin && originSet.has(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); }
      if (req.method === 'OPTIONS' && origin && originSet.has(origin)) { res.writeHead(204, { ...headers, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'Content-Type, Authorization, X-Mino-Space' }); res.end(); return; }
    }
    if (!url.pathname.startsWith('/m/')) {
      if (browserStatic?.(req, res)) return;
      throw new DeviceError(404, 'not_found', 'Introuvable.');
    }
    if (req.method === 'GET' && url.pathname === '/m/browser/session') {
      const device = browserIdentity(auth);
      if (!device || auth.kind !== 'cookie') {
        if (auth.kind === 'cookie') clearCookie(res);
        send(res, 200, { state: 'unpaired' }); return;
      }
      send(res, 200, browserSession(res, auth.token, device)); return;
    }
    if (req.method === 'POST' && url.pathname === '/m/browser/claim') {
      limitClaim(req);
      const input = z.strictObject({ deviceName: z.string().trim().min(1).max(50) }).safeParse(await read(req));
      if (!input.success) throw new DeviceError(422, 'invalid_pairing', 'Donne un nom à cet appareil, entre 1 et 50 caractères.');
      const prior = browserIdentity(auth);
      if (prior && auth.kind === 'cookie') { send(res, 200, browserSession(res, auth.token, prior)); return; }
      if (auth.kind === 'cookie') clearCookie(res);
      if (!options.browserAdmission) throw new DeviceError(503, 'browser_unavailable', 'La connexion Safari n’est pas configurée.');
      const claim = options.browserAdmission.claim(input.data.deviceName);
      send(res, 200, browserSession(res, claim.token, claim.device)); return;
    }
    if (req.method === 'POST' && url.pathname === '/m/browser/logout') {
      const device = browserIdentity(auth);
      if (device) options.devices.revoke(device.id);
      req.resume();
      clearCookie(res); send(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/m/pair/claim') {
      if (auth.kind === 'cookie') throw new DeviceError(400, 'ambiguous_credentials', 'Cette connexion utilise un cookie Safari.');
      limitClaim(req);
      send(res, 200, options.devices.claim(await read(req))); return;
    }
    const token = auth.kind === 'none' ? '' : auth.token;
    const space = auth.kind === 'cookie' ? options.devices.spaceId : typeof req.headers['x-mino-space'] === 'string' ? req.headers['x-mino-space'] : '';
    if (req.method === 'GET' && url.pathname === '/m/pair/status') {
      const status = options.devices.pairStatus(token, space);
      if (auth.kind === 'cookie') setCookie(res, token, cookieExpiry(options.devices.authenticate(token, space, true)));
      send(res, 200, status); return;
    }
    options.devices.authenticate(token, space);
    if (options.agents && await options.agents.handle(req, res, url, 'device', () => options.devices.authenticate(token, space))) return;
    if (req.method === 'GET' && url.pathname === '/m/view') {
      const after = url.searchParams.get('after');
      if (after !== null && /^\d+$/.test(after) && Number(after) === options.store.rev) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); unstore(); unauth(); res.off('close', done); resolve(); };
          const unstore = options.store.onChange(done); const unauth = options.devices.onChange(done);
          const timer = setTimeout(done, options.longPollMs ?? 25_000); res.on('close', done);
        });
      }
      if (res.destroyed) return;
      options.devices.authenticate(token, space);
      send(res, 200, snapshot()); return;
    }
    if (req.method === 'GET' && url.pathname === '/m/catalog') { const status = await options.engine.catalog(); options.devices.authenticate(token, space); send(res, 200, status); return; }
    if (req.method === 'POST' && url.pathname === '/m/commands') {
      const parsed = CommandSchema.safeParse(await read(req));
      if (!parsed.success) throw new DeviceError(422, 'invalid_command', 'Cette commande est invalide.');
      const command = parsed.data;
      if (command.type === 'storage.purge' || command.type === 'bot.select') throw new DeviceError(403, 'command_refused', 'Cette commande se fait sur l’ordinateur.');
      if (command.type === 'bot.configure' || (command.type === 'bot.create' && command.model != null)) {
        const catalog = await options.engine.catalog();
        if (catalog.state !== 'ready') throw new DeviceError(409, 'choice_unavailable', 'Le catalogue est indisponible.');
        const result = resolveChoice(catalog.models, command.type === 'bot.configure' ? command : { model: command.model ?? null, effort: null, speed: 'standard' });
        if (!result.ok) throw new DeviceError(422, 'choice_unavailable', result.message);
      }
      options.devices.authenticate(token, space);
      const result = options.store.dispatch(command, { activeWorkIds: options.worker.activeWorkIds });
      if (result.ok) options.worker.sync();
      send(res, result.ok ? 200 : 409, { ...result, view: snapshot() }); return;
    }
    throw new DeviceError(404, 'not_found', 'Introuvable.');
  }
  return (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((error: unknown) => {
      if (res.destroyed) return;
      if (res.headersSent) { res.end(); return; }
      if (error instanceof DeviceError) send(res, error.status, { ok: false, code: error.code, message: error.message });
      else send(res, 500, { ok: false, code: 'internal', message: 'La demande a rencontré une erreur. Son résultat peut déjà être enregistré. Conservez son identifiant pour vérifier.' });
    });
  };
}

export function createDeviceServer(options: Options & { cert: string; key: string }) {
  const url = new URL(options.publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('MINO_DEVICE_URL doit être une origine HTTPS sans chemin ni identifiant.');
  const cert = new X509Certificate(options.cert);
  const name = url.hostname.replace(/^\[|\]$/g, '');
  if (!(isIP(name) ? cert.checkIP(name) : cert.checkHost(name)) || !cert.checkPrivateKey(createPrivateKey(options.key)) || cert.validToDate.getTime() <= Date.now() || cert.validFromDate.getTime() > Date.now()) throw new Error('Le certificat ne correspond pas à cette adresse, à cette clé ou à la date courante.');
  const server = createServer({ cert: options.cert, key: options.key, minVersion: 'TLSv1.2', requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1000 }, createDeviceHandler(options));
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  return server;
}
