import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentCommandSchema, type AgentsView, type MissionResponse } from './agent-protocol.js';
import type { AgentEngine } from './agent-engine.js';
import type { AgentWorker } from './agent-worker.js';
import type { CoordinationDeps, Missions } from './missions.js';

/** Where a request comes from once its caller has authenticated it: the PC page, or a paired device. */
export type AgentScope = 'pc' | 'device';

const PREFIX: Record<AgentScope, string> = { pc: '/api/agents/', device: '/m/agents/' };
const PC_ONLY = new Set(['project.add', 'project.update', 'project.archive']);
const BODY_LIMIT = 64 * 1024;
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

export type AgentRoutes = ReturnType<typeof createAgentRoutes>;

/** `coordination` reads the chat store for Mino's proposals and the app's bots; without it, coordinated missions and chat origins are refused. */
export function createAgentRoutes(options: { missions: Missions; worker: AgentWorker; engine: AgentEngine; longPollMs?: number; coordination?: CoordinationDeps }) {
  const { missions, worker, engine } = options;
  const longPoll = options.longPollMs ?? 25_000;

  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, HEADERS);
    res.end(JSON.stringify(value));
  };

  const view = (scope: AgentScope): AgentsView => {
    const current = missions.view();
    const projects = scope === 'pc' ? current.projects : current.projects.filter(p => !p.archived);
    return { ...current, projects, engine: engine.status() };
  };

  function waitForChange(after: string | null, res: ServerResponse): Promise<void> {
    if (after === null || !/^\d+$/.test(after) || Number(after) !== missions.rev) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); unsubscribe(); res.off('close', done); resolve(); };
      const unsubscribe = missions.onChange(done);
      const timer = setTimeout(done, longPoll);
      res.on('close', done);
    });
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return undefined;
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
      size += buffer.length;
      if (size > BODY_LIMIT) return undefined;
      parts.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return undefined; }
  }

  /**
   * Returns false when the path is not an agent route, so the caller keeps its own 404.
   * `recheck` runs again after a long-poll wait, so a device revoked meanwhile gets the caller's refusal instead of data.
   */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, scope: AgentScope, recheck: () => void = () => {}): Promise<boolean> {
    const prefix = PREFIX[scope];
    if (!url.pathname.startsWith(prefix)) return false;
    const route = url.pathname.slice(prefix.length);
    if (req.method === 'GET' && route === 'view') {
      await waitForChange(url.searchParams.get('after'), res);
      if (res.destroyed) return true;
      recheck();
      send(res, 200, view(scope));
      return true;
    }
    const detail = /^missions\/([A-Za-z0-9_-]{1,80})$/.exec(route);
    if (req.method === 'GET' && detail?.[1]) {
      await waitForChange(url.searchParams.get('after'), res);
      if (res.destroyed) return true;
      recheck();
      const found = missions.detail(detail[1]);
      if (!found) send(res, 404, { ok: false, code: 'not_found', message: 'Cette mission n’existe pas.' });
      else send(res, 200, { rev: missions.rev, mission: found, project: missions.view().projects.find(p => p.id === found.projectId) ?? null } satisfies MissionResponse);
      return true;
    }
    if (req.method === 'GET' && route === 'catalog') {
      const catalog = await engine.catalog();
      recheck();
      send(res, catalog.ok ? 200 : 503, catalog.ok ? { ok: true, models: catalog.models.map(m => ({ id: m.id, displayName: m.displayName, isDefault: m.isDefault, efforts: m.efforts, defaultEffort: m.defaultEffort })) } : { ok: false, code: 'unavailable', message: catalog.message });
      return true;
    }
    if (req.method === 'POST' && route === 'commands') {
      const input = await readJson(req);
      const parsed = AgentCommandSchema.safeParse(input);
      if (!parsed.success) {
        send(res, 422, { ok: false, code: 'invalid_command', message: 'Cette commande est incomplète ou invalide.' });
        return true;
      }
      if (scope === 'device' && PC_ONLY.has(parsed.data.type)) {
        send(res, 403, { ok: false, code: 'pc_only', message: 'Un dossier se confie à Mino depuis l’ordinateur.' });
        return true;
      }
      recheck();
      const outcome = missions.dispatch(parsed.data, options.coordination ?? null);
      if (outcome.ok) worker.sync();
      send(res, outcome.ok ? 200 : outcome.code === 'not_found' ? 404 : 409, { ...outcome, view: view(scope) });
      return true;
    }
    send(res, 404, { ok: false, code: 'not_found', message: 'Introuvable.' });
    return true;
  }

  return { handle };
}
