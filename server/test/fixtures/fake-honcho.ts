import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Test-only stand-in for a Honcho server, on a loopback port. It follows the routes of the pinned upstream source:
// get-or-create answers 201 only for a new workspace, and an ingestion creates a missing session, as upstream does.

export type FakeMessage = { id: string; workspace_id: string; session_id: string; peer_id: string; content: string; created_at: string };
export type FakeRequest = { method: string; path: string; body: unknown; authorization: string | undefined };
type Reply = { status: number; body: unknown };
type FakeSession = { peers: Record<string, unknown>; messages: FakeMessage[]; deleted: boolean };
type FakeWorkspace = { sessions: Map<string, FakeSession>; deleted: boolean };

export type FakeHoncho = {
  readonly url: string;
  readonly key: string;
  readonly requests: FakeRequest[];
  readonly workspaces: Map<string, FakeWorkspace>;
  /** Every message of one workspace, oldest first. */
  messages(workspaceId: string): FakeMessage[];
  /**
   * Runs before the normal answer. Return a reply to replace it, `hang` to drop the request without an answer,
   * `lose` to apply it and never answer, or nothing to go on. It may wait on a promise, so a test can act while a request is in flight.
   */
  intercept: ((request: FakeRequest) => Reply | 'hang' | 'lose' | void | Promise<Reply | 'hang' | 'lose' | void>) | null;
  /** Rewrites a normal answer after the request was applied, to play a hostile or broken provider. */
  rewrite: ((request: FakeRequest, reply: Reply) => Reply) | null;
  close(): Promise<void>;
};

const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 4));

export async function startFakeHoncho(key = 'cle-synthetique-honcho'): Promise<FakeHoncho> {
  const requests: FakeRequest[] = [];
  const workspaces = new Map<string, FakeWorkspace>();
  let serial = 0;
  const messages = (workspaceId: string) => [...(workspaces.get(workspaceId)?.sessions.values() ?? [])].flatMap(session => session.messages);
  const sessionOf = (workspaceId: string, sessionId: string, peers: Record<string, unknown> = {}): { session: FakeSession; created: boolean } => {
    const workspace = workspaces.get(workspaceId) ?? { sessions: new Map<string, FakeSession>(), deleted: false };
    workspaces.set(workspaceId, workspace);
    const existing = workspace.sessions.get(sessionId);
    const session = existing ?? { peers, messages: [], deleted: false };
    workspace.sessions.set(sessionId, session);
    return { session, created: !existing };
  };

  function answer(request: FakeRequest): Reply {
    if (request.authorization !== `Bearer ${key}`) return { status: 401, body: { detail: 'unauthorized' } };
    const parts = request.path.split('/').filter(Boolean).map(decodeURIComponent);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (request.method === 'POST' && request.path === '/v3/workspaces') {
      const id = String(body.id);
      const created = !workspaces.has(id);
      if (created) workspaces.set(id, { sessions: new Map(), deleted: false });
      return { status: created ? 201 : 200, body: { id } };
    }
    const [, , workspaceId = '', resource, sessionId = '', sub, messageId] = parts;
    if (request.method === 'DELETE') {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) return { status: 404, body: { detail: 'not found' } };
      if (resource === 'sessions') {
        const session = workspace.sessions.get(sessionId);
        if (session) session.deleted = true;
      } else workspace.deleted = true;
      return { status: 202, body: { message: 'Deletion accepted' } };
    }
    if (resource === 'sessions' && parts.length === 4 && request.method === 'POST') {
      const created = sessionOf(workspaceId, String(body.id), (body.peers ?? {}) as Record<string, unknown>).created;
      return { status: created ? 201 : 200, body: { id: String(body.id), workspace_id: workspaceId } };
    }
    if (resource === 'sessions' && sub === 'messages' && request.method === 'POST') {
      const { session } = sessionOf(workspaceId, sessionId);
      const added = ((body.messages ?? []) as { peer_id: string; content: string }[]).map((message): FakeMessage => ({
        id: `msg-${serial += 1}`, workspace_id: workspaceId, session_id: sessionId, peer_id: message.peer_id, content: message.content,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, serial)).toISOString(),
      }));
      session.messages.push(...added);
      return { status: 201, body: added };
    }
    if (resource === 'sessions' && sub === 'messages' && request.method === 'GET') {
      const found = workspaces.get(workspaceId)?.sessions.get(sessionId)?.messages.find(message => message.id === messageId);
      return found ? { status: 200, body: found } : { status: 404, body: { detail: 'not found' } };
    }
    if (resource === 'search' && request.method === 'POST') {
      const wanted = words(String(body.query));
      const filter = (body.filters as { session_id?: string } | undefined)?.session_id;
      const scored = messages(workspaceId)
        .filter(message => filter === undefined || message.session_id === filter)
        .map(message => ({ message, score: [...words(message.content)].filter(word => wanted.has(word)).length }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      return { status: 200, body: scored.slice(0, Number(body.limit)).map(entry => entry.message) };
    }
    return { status: 404, body: { detail: 'not found' } };
  }

  const fake: Omit<FakeHoncho, 'url' | 'close'> = { key, requests, workspaces, messages, intercept: null, rewrite: null };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request: FakeRequest = {
      method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
    };
    requests.push(request);
    const intercepted = await fake.intercept?.(request);
    if (intercepted === 'hang') return;
    if (intercepted === 'lose') return void answer(request);
    const normal = intercepted ?? answer(request);
    const reply = intercepted || !fake.rewrite ? normal : fake.rewrite(request, normal);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  }

  const server = createServer((req, res) => void handle(req, res).catch(() => res.destroy()));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no loopback port');
  return Object.assign(fake, {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  });
}
