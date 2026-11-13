import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { resolveChoice } from './domain.js';
import type { Engine } from './engine.js';
import { CommandSchema, LIMITS, type DispatchOutcome, type RefusalCode } from './protocol.js';
import type { DownloadFile, Store } from './store.js';
import type { Worker } from './worker.js';
import { DeviceError, type Devices } from './devices.js';
import { z } from 'zod';
import type { BrowserAdmission } from './web-admission.js';
import type { AgentRoutes } from './agent-http.js';
import type { ActionDesk } from './tool-desk.js';
import type { PcView } from './tools-protocol.js';

export type HttpOptions = {
  store: Store;
  worker: Worker;
  engine: Engine;
  port: number;
  root: string;
  csrfToken: string;
  devices?: Devices;
  browserAdmission?: BrowserAdmission;
  agents?: AgentRoutes;
  /** Connected services. Without it the PC view says the provider key is missing and the tools routes are closed. */
  actions?: ActionDesk;
  longPollMs?: number;
  log?: (entry: { event: 'command'; type: string; ok: boolean; code?: RefusalCode }) => void;
};

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/react-app.js': { file: 'dist/web/react-app.js', type: 'text/javascript; charset=utf-8' },
  '/react-app.css': { file: 'dist/web/react-app.css', type: 'text/css; charset=utf-8' },
  '/assets/prototype.css': { file: 'assets/prototype.css', type: 'text/css; charset=utf-8' },
  '/assets/symbols.svg': { file: 'assets/symbols.svg', type: 'image/svg+xml; charset=utf-8' },
  '/assets/mascots.json': { file: 'assets/mascots.json', type: 'application/json; charset=utf-8' },
  '/mino.css': { file: 'web/mino.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'dist/web/app.js', type: 'text/javascript; charset=utf-8' },
  '/device-admin.js': { file: 'dist/web/device-admin.js', type: 'text/javascript; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; frame-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const REFUSAL_STATUS: Partial<Record<RefusalCode, number>> = {
  invalid_command: 422,
  unknown_shape: 422,
  choice_unavailable: 422,
  not_found: 404,
  busy: 409,
};

class HttpRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function sendDownload(res: ServerResponse, file: DownloadFile | null): void {
  if (!file) {
    sendJson(res, 404, { ok: false, message: 'Ce fichier n’existe pas.' });
    return;
  }
  const ascii = file.filename.replace(/[^A-Za-z0-9 ._-]/g, '_');
  send(res, 200, `${file.mediaType}; charset=utf-8`, file.content, {
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  });
}

async function readJson(req: IncomingMessage, limit: number = LIMITS.requestBodyBytes): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) throw new HttpRefusal(413, 'Ce message est trop volumineux.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpRefusal(400, 'Le contenu envoyé n’est pas du JSON valide.');
  }
}

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHttpServer(options: HttpOptions): Server {
  const { store, worker, engine, port, root, csrfToken } = options;
  const imageSession = randomBytes(32).toString('hex');
  const longPoll = options.longPollMs ?? 25_000;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const indexHtml = readFileSync(join(root, 'web/react.html'), 'utf8').replace('__MINO_CSRF__', csrfToken);
  /** The PC view only. Paired devices get their own projection, which has no tools field. */
  const appView = (): PcView => ({ ...store.view(), engine: engine.status(), tools: options.actions?.view() ?? store.tools.view({ state: 'missing_key' }) });

  function waitForChange(after: number, req: IncomingMessage): Promise<void> {
    if (store.rev !== after) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        req.off('close', done);
        resolve();
      };
      const unsubscribe = store.onChange(done);
      const timer = setTimeout(done, longPoll);
      req.on('close', done);
    });
  }

  function requireLocalPost(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) throw new HttpRefusal(403, 'Origine refusée.');
    const token = req.headers['x-mino-csrf'];
    if (!sameSecret(typeof token === 'string' ? token : undefined, csrfToken)) {
      throw new HttpRefusal(403, 'Session expirée. Rechargez la page.');
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpRefusal(415, 'Format refusé.');
  }

  async function command(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requireLocalPost(req);
    const input = await readJson(req, LIMITS.commandBodyBytes);
    if (input !== null && typeof input === 'object' && 'type' in input && input.type === 'bot.configure') {
      const refusal = await configureRefusal(input);
      if (refusal) {
        sendJson(res, REFUSAL_STATUS[refusal.code] ?? 409, { ...refusal, view: appView() });
        return;
      }
    }
    const outcome = store.dispatch(input, { activeWorkIds: worker.activeWorkIds });
    const parsed = CommandSchema.safeParse(input);
    options.log?.({ event: 'command', type: parsed.success ? parsed.data.type : 'unknown', ok: outcome.ok, ...(outcome.ok ? {} : { code: outcome.code }) });
    if (outcome.ok) {
      worker.sync();
      sendJson(res, 200, { ...outcome, view: appView() });
      return;
    }
    sendJson(res, REFUSAL_STATUS[outcome.code] ?? 409, { ...outcome, view: appView() });
  }

  async function configureRefusal(input: object): Promise<Extract<DispatchOutcome, { ok: false }> | null> {
    const model = 'model' in input ? input.model : undefined;
    const effort = 'effort' in input ? input.effort : undefined;
    const speed = 'speed' in input ? input.speed : undefined;
    if ((model !== null && typeof model !== 'string') || (effort !== null && typeof effort !== 'string') || typeof speed !== 'string') {
      return { ok: false, code: 'invalid_command', message: 'Cette commande est incomplète ou invalide.' };
    }
    const status = await engine.catalog();
    if (status.state !== 'ready') {
      return { ok: false, code: 'choice_unavailable', message: 'Le catalogue de Codex est indisponible. Le réglage n’a pas été changé.' };
    }
    const resolution = resolveChoice(status.models, { model, effort, speed });
    return resolution.ok ? null : { ok: false, code: 'choice_unavailable', message: resolution.message };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? '')) throw new HttpRefusal(421, 'Hôte refusé.');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (path === '/devices' && req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(root, 'web/devices.html'), 'utf8').replace('__MINO_CSRF__', csrfToken));
    if (path.startsWith('/api/devices')) {
      if (!options.devices) return sendJson(res, 503, { ok: false, message: 'La connexion téléphone n’est pas configurée. Consultez le guide de démarrage mobile.' });
      if (req.method === 'GET' && path === '/api/devices') return sendJson(res, 200, { url: options.devices.publicUrl, devices: options.devices.list(), browserEnabled: Boolean(options.browserAdmission), browserWindowExpiresAt: options.browserAdmission?.expiresAt() ?? null });
      if (req.method !== 'POST' || !origins.has(req.headers.origin ?? '') || !sameSecret(typeof req.headers['x-mino-csrf'] === 'string' ? req.headers['x-mino-csrf'] : undefined, csrfToken)) throw new HttpRefusal(403, 'Confirmation locale refusée.');
      const input = await readJson(req);
      if (path === '/api/devices/browser-window') {
        if (!options.browserAdmission) throw new HttpRefusal(503, 'La connexion Safari n’est pas configurée.');
        return sendJson(res, 200, options.browserAdmission.open());
      }
      if (path === '/api/devices/pairings') return sendJson(res, 200, options.devices.createGrant());
      if (path === '/api/devices/approve') {
        const c = z.strictObject({ pairingId: z.string().uuid(), deviceId: z.string().uuid(), confirmCode: z.string().regex(/^\d{6}$/) }).safeParse(input);
        if (!c.success) throw new HttpRefusal(422, 'Confirmation incomplète.');
        options.devices.approve(c.data.pairingId, c.data.deviceId, c.data.confirmCode);
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/api/devices/revoke') {
        const c = z.strictObject({ deviceId: z.string().uuid() }).safeParse(input);
        if (!c.success) throw new HttpRefusal(422, 'Appareil invalide.');
        options.devices.revoke(c.data.deviceId); return sendJson(res, 200, { ok: true });
      }
      throw new HttpRefusal(404, 'Introuvable.');
    }
    if (path.startsWith('/api/agents/')) {
      if (!options.agents) throw new HttpRefusal(503, 'Les missions ne sont pas disponibles.');
      if (req.method === 'POST') requireLocalPost(req);
      else if (req.method !== 'GET') throw new HttpRefusal(405, 'Méthode refusée.');
      if (await options.agents.handle(req, res, url, 'pc')) return;
    }
    if (path.startsWith('/api/tools/')) {
      if (req.method === 'POST') requireLocalPost(req);
      else if (req.method !== 'GET') throw new HttpRefusal(405, 'Méthode refusée.');
      // These reads call the provider. Another site can send a plain GET here but cannot add this header.
      else if (path !== '/api/tools/callback' && !sameSecret(typeof req.headers['x-mino-csrf'] === 'string' ? req.headers['x-mino-csrf'] : undefined, csrfToken)) {
        throw new HttpRefusal(403, 'Session expirée. Rechargez la page.');
      }
      const reply = await options.actions?.route({ method: req.method, route: path.slice('/api/tools/'.length), query: url.searchParams, body: req.method === 'POST' ? await readJson(req) : null });
      if (!reply) throw new HttpRefusal(404, 'Introuvable.');
      if ('page' in reply) return send(res, reply.status, 'text/html; charset=utf-8', reply.page, { 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      if ('outcome' in reply) return sendJson(res, reply.status, { ...reply.outcome, view: appView() });
      return sendJson(res, reply.status, reply.body);
    }
    if (req.method === 'POST' && path === '/api/commands') return command(req, res);
    if (req.method !== 'GET') throw new HttpRefusal(405, 'Méthode refusée.');
    if (path === '/advanced') return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(root, 'web/index.html'), 'utf8').replace('__MINO_CSRF__', csrfToken));
    if (path === '/') return send(res, 200, 'text/html; charset=utf-8', indexHtml, {'set-cookie': `mino-images=${imageSession}; HttpOnly; SameSite=Strict; Path=/api/attachments`});
    const asset = STATIC_FILES[path];
    if (asset) return send(res, 200, asset.type, readFileSync(join(root, asset.file)));
    if (req.method === 'GET' && /^\/api\/attachments\/[0-9]+$/.test(path)) {
      if (req.headers.origin && !origins.has(req.headers.origin)) throw new HttpRefusal(403, 'Origine refusée.');
      if (!(req.headers.cookie ?? '').split(';').some(cookie => sameSecret(cookie.trim().startsWith('mino-images=') ? cookie.trim().slice(12) : undefined, imageSession))) throw new HttpRefusal(403, 'Session expirée. Rechargez la page.');
      const image = store.image(path.split('/').at(-1)!);
      if (!image) return send(res, 404, 'text/plain', 'Image introuvable');
      res.writeHead(200, {'content-type': image.mimeType, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store'}); res.end(image.bytes); return;
    }
    if (path === '/api/view') {
      const afterValue = url.searchParams.get('after');
      const after = Number(afterValue);
      if (afterValue !== null && Number.isInteger(after)) await waitForChange(after, req);
      return sendJson(res, 200, appView());
    }
    if (path === '/api/diagnostics') {
      const afterValue = url.searchParams.get('after');
      const after = Number(afterValue);
      if (afterValue !== null && Number.isInteger(after)) await waitForChange(after, req);
      return sendJson(res, 200, { ...store.diagnostics(), engineState: engine.status().state,
        activeWorkIds: [...worker.activeWorkIds] });
    }
    if (path === '/api/catalog') {
      await engine.catalog();
      return sendJson(res, 200, engine.status());
    }
    if (path === '/api/export') return sendDownload(res, store.exportThread(url.searchParams.get('threadBotId') ?? undefined));
    const artifact = /^\/api\/(versions|publications|messages)\/([A-Za-z0-9_-]{1,80})\/(download|preview)$/.exec(path);
    if (artifact?.[2]) {
      const file = artifact[1] === 'versions' ? store.versionFile(artifact[2])
        : artifact[1] === 'publications' ? store.publicationFile(artifact[2]) : store.messageFile(artifact[2]);
      if (artifact[3] === 'download') return sendDownload(res, file);
      if (!file || file.mediaType !== 'text/html') throw new HttpRefusal(404, 'Cet aperçu HTML n’existe pas.');
      if (req.headers['sec-fetch-dest'] !== 'iframe') throw new HttpRefusal(403, 'Ouvrez cet aperçu depuis Mino.');
      return send(res, 200, 'text/html; charset=utf-8', file.content, {
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
        'x-frame-options': 'SAMEORIGIN',
        'x-dns-prefetch-control': 'off',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
      });
    }
    throw new HttpRefusal(404, 'Introuvable.');
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpRefusal) sendJson(res, error.status, { ok: false, message: error.message });
      else if (error instanceof DeviceError) sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
      else sendJson(res, 500, { ok: false, message: 'Erreur interne de Mino. Rechargez la page pour voir l’état enregistré.' });
    });
  });
}
