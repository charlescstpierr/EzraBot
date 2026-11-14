import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Controller,
  RemoteError,
  safeBase,
  type Storage,
  type Transport,
} from "../src/controller";
import { MobileSnapshotSchema } from "../src/generated/mobile-protocol";
import { editDraft, insertMention } from "../src/mentions";
const deviceId = "b52c7d8e-9641-4fc0-9b49-c90301c7c653";
const session = {
  url: "https://example.com",
  spaceId: "space",
  deviceId,
  token: "a".repeat(64),
};
function fixture() {
  const data = new Map<string, string>();
  let secret: string | null = JSON.stringify({ session, claim: null });
  const storage: Storage = {
    readSecret: async () => secret,
    writeSecret: async (v) => {
      secret = v;
    },
    read: async (k) => data.get(k) ?? null,
    write: async (k, v) => {
      data.set(k, v);
    },
    remove: async (k) => {
      data.delete(k);
    },
  };
  const snapshot = MobileSnapshotSchema.parse({
    schemaVersion: 1,
    rev: 1,
    spaceId: "space",
    erasure: "complete",
    purged: { botIds: [], workIds: [] },
    bots: [],
    messages: [],
    works: [],
    tasks: [],
    carnet: [],
    engine: { state: "starting" },
  });
  return { storage, data, snapshot, getSecret: () => secret };
}
const command = {
  type: "message.say",
  requestId: "request-1234",
  botId: "bot",
  text: "Bonjour",
  attachments: [],
} as const;
test("lost response survives restart and retries identical bytes and request ID", async () => {
  const f = fixture();
  const received: string[] = [];
  let lost = true;
  const transport: Transport = async (_s, path, body) => {
    if (!body) return f.snapshot;
    received.push(body);
    assert.ok(f.data.values().next().value?.includes("request-1234"));
    if (lost) {
      lost = false;
      throw Error("lost");
    }
    return {
      ok: true,
      replayed: true,
      result: { kind: "message", messageId: "m", workId: "w" },
      view: f.snapshot,
    };
  };
  const first = new Controller(f.storage, transport);
  await first.boot();
  await first.enqueue({ ...command, attachments: [] });
  await first.refresh();
  assert.equal(first.local.queue[0]?.state, "unknown");
  const second = new Controller(f.storage, transport);
  await second.boot();
  await second.refresh();
  assert.equal(received.length, 2);
  assert.equal(received[0], received[1]);
  assert.equal(second.local.queue.length, 0);
});
test("draft edited during a pending network response survives acknowledgement", async () => {
  const f = fixture();
  let release: (value: unknown) => void = () => {};
  let started: () => void = () => {};
  const networkStarted = new Promise<void>((r) => {
    started = r;
  });
  const transport: Transport = async (_s, _p, body) => {
    if (!body) return f.snapshot;
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const c = new Controller(f.storage, transport);
  await c.boot();
  const draft = { text: "Bonjour", mentions: [] };
  await c.setDraft("bot", draft);
  await c.enqueue({ ...command, attachments: [] }, draft);
  const refresh = c.refresh();
  await networkStarted;
  const saved = c.setDraft("bot", { text: "Une autre idée", mentions: [] });
  release({
    ok: true,
    replayed: false,
    result: { kind: "message", messageId: "m", workId: "w" },
    view: f.snapshot,
  });
  await refresh;
  await saved;
  assert.equal(c.local.drafts.bot?.text, "Une autre idée");
});
test("401 erases credentials, cached snapshots, drafts and queue", async () => {
  const f = fixture();
  const c = new Controller(f.storage, async () => {
    throw new RemoteError(401, "revoked", "revoked");
  });
  await c.boot();
  await c.setDraft("bot", { text: "private", mentions: [] });
  await c.enqueue({ ...command, attachments: [] });
  await c.refresh();
  assert.equal(f.getSecret(), null);
  assert.equal(f.data.size, 0);
  assert.equal(c.local.queue.length, 0);
  assert.deepEqual(c.local.drafts, {});
  assert.equal(c.connection.kind, "revoked");
});
test("space mismatch prevents all replay and clears the old scope", async () => {
  const f = fixture();
  let posts = 0;
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (body) posts++;
    return { ...f.snapshot, spaceId: "another-space" };
  });
  await c.boot();
  await c.enqueue({ ...command, attachments: [] });
  await c.refresh();
  assert.equal(posts, 0);
  assert.equal(c.connection.kind, "revoked");
  assert.equal(f.data.size, 0);
});
test("purged bot commands and drafts are removed before replay", async () => {
  const f = fixture();
  let posts = 0;
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (body) posts++;
    return { ...f.snapshot, purged: { botIds: ["bot"], workIds: [] } };
  });
  await c.boot();
  await c.setDraft("bot", { text: "gone", mentions: [] });
  await c.enqueue({ ...command, attachments: [] });
  await c.refresh();
  assert.equal(posts, 0);
  assert.equal(c.local.queue.length, 0);
  assert.equal(c.local.drafts.bot, undefined);
});
test("approval with unknown response is surfaced and never automatically retried", async () => {
  const f = fixture();
  const proposal = {
    id: "proposal",
    versionId: "v",
    versionN: 1,
    action: "publish",
    destination: "carnet",
    payloadSha256: "a".repeat(64),
    state: "open",
    title: "A",
    body: "B",
  };
  const snapshot = MobileSnapshotSchema.parse({
    ...f.snapshot,
    works: [
      {
        id: "w",
        next: { kind: "none", reason: "Terminé" }, lastFact: { kind: "none" },
        threadBotId: "bot",
        botId: "bot",
        taskId: null,
        requestMessageId: "m",
        state: "done",
        title: "A",
        createdAt: "",
        updatedAt: "",
        attempt: null,
        versions: [],
        proposals: [proposal],
      },
    ],
  });
  let posts = 0;
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (!body) return snapshot;
    posts++;
    throw Error("lost");
  });
  await c.boot();
  await c.refresh();
  await c.enqueue({
    type: "publication.approve",
    requestId: "approve-1234",
    proposalId: "proposal",
    action: "publish",
    destination: "carnet",
    versionId: "v",
    payloadSha256: "a".repeat(64),
  });
  await c.refresh();
  await c.refresh();
  assert.equal(posts, 1);
  assert.equal(c.local.queue[0]?.state, "unknown");
  await c.retry("approve-1234");
  await c.refresh();
  assert.equal(posts, 2);
});
test("pairing secret is durably stored before exact claim retry after lost response", async () => {
  const f = fixture();
  await f.storage.writeSecret(null);
  const bodies: string[] = [];
  const c = new Controller(f.storage, async (_s, path, body) => {
    if (path === "/m/pair/claim") {
      assert.ok(f.getSecret()?.includes("deviceToken"));
      bodies.push(body ?? "");
      throw Error("lost");
    }
    throw Error("unexpected");
  });
  await c.pair(
    {
      version: 1,
      url: session.url,
      spaceId: "space",
      pairingId: deviceId,
      secret: "b".repeat(64),
      expiresAt: new Date(Date.now() + 100000).toISOString(),
    },
    { deviceId, deviceToken: session.token, deviceName: "Phone" },
  );
  await c.refresh();
  const d = new Controller(f.storage, async (_s, _path, body) => {
    bodies.push(body ?? "");
    throw Error("lost");
  });
  await d.boot();
  await d.refresh();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});
test("mention spans move with edits, and editing inside a label removes the invite", () => {
  const draft = insertMention(
    { text: "Hi ", mentions: [] },
    { id: "bot", name: "Radis" },
    3,
  );
  assert.equal(
    draft.text.slice(draft.mentions[0].start, draft.mentions[0].end),
    "@Radis",
  );
  const moved = editDraft(draft, "👋 " + draft.text);
  assert.equal(moved.mentions[0].start, 6);
  const removed = editDraft(draft, draft.text.replace("Radis", "Ravi"));
  assert.equal(removed.mentions.length, 0);
});
test("native URLs reject HTTP, credentials and query secrets", () => {
  assert.throws(() => safeBase("http://localhost:4317"));
  assert.throws(() => safeBase("https://a:b@example.com"));
  assert.throws(() => safeBase("https://example.com?secret=x"));
  assert.equal(
    safeBase("http://127.0.0.1:9999", true),
    "http://127.0.0.1:9999",
  );
  assert.throws(() => safeBase("http://example.com", true));
});
test("concurrent refreshes serialize command delivery without duplicate posts", async () => {
  const f = fixture();
  let active = 0;
  let peak = 0;
  const received: string[] = [];
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (!body) return f.snapshot;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    received.push(JSON.parse(body).requestId);
    active--;
    return {
      ok: true,
      replayed: false,
      result: { kind: "message", messageId: "m", workId: "w" },
      view: f.snapshot,
    };
  });
  await c.boot();
  await Promise.all([
    c.enqueue({ ...command, attachments: [] }),
    c.enqueue({ ...command, requestId: "request-5678", attachments: [] }),
  ]);
  await Promise.all([c.refresh(), c.refresh()]);
  assert.equal(peak, 1);
  assert.deepEqual(received, ["request-1234", "request-5678"]);
});
test("refused command remains visible and blocks later replay until resolved", async () => {
  const f = fixture();
  let posts = 0;
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (!body) return f.snapshot;
    posts++;
    return {
      ok: false,
      code: "stale_base",
      message: "La version a changé.",
      view: f.snapshot,
    };
  });
  await c.boot();
  await c.enqueue({ ...command, attachments: [] });
  await c.enqueue({ ...command, requestId: "request-5678", attachments: [] });
  await c.refresh();
  await c.refresh();
  assert.equal(posts, 1);
  assert.equal(c.local.queue[0]?.message, "La version a changé.");
  assert.equal(c.local.queue.length, 2);
});
test("approval is blocked while a chat draft exists", async () => {
  const f = fixture();
  const c = new Controller(f.storage, async () => f.snapshot);
  await c.boot();
  await c.refresh();
  await c.setDraft("bot", { text: "Un changement", mentions: [] });
  await assert.rejects(
    c.enqueue({
      type: "publication.approve",
      requestId: "approve-1234",
      proposalId: "proposal",
      action: "publish",
      destination: "carnet",
      versionId: "v",
      payloadSha256: "a".repeat(64),
    }),
  );
  assert.equal(c.local.queue.length, 0);
});
test("failed durable enqueue preserves the composer and sends nothing", async () => {
  const f = fixture();
  let fail = false;
  let posts = 0;
  const original = f.storage.write;
  f.storage.write = async (k, v) => {
    if (fail) throw Error("disk full");
    await original(k, v);
  };
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (body) posts++;
    return f.snapshot;
  });
  await c.boot();
  const draft = { text: "Bonjour", mentions: [] };
  await c.setDraft("bot", draft);
  fail = true;
  await assert.rejects(c.enqueue({ ...command, attachments: [] }, draft));
  assert.equal(c.local.drafts.bot?.text, "Bonjour");
  assert.equal(c.local.queue.length, 0);
  assert.equal(posts, 0);
});
test("mention label extension and code fences remove guest authorization", () => {
  const draft = insertMention(
    { text: "", mentions: [] },
    { id: "bot", name: "Radis" },
    0,
  );
  assert.equal(editDraft(draft, "@Radisx ").mentions.length, 0);
  assert.equal(editDraft(draft, "```\n" + draft.text).mentions.length, 0);
  assert.equal(
    insertMention(
      { text: "```\n", mentions: [] },
      { id: "bot", name: "Radis" },
      4,
    ).mentions.length,
    0,
  );
});
test("backgrounding marks cached observations old until a successful foreground refresh", async () => {
  const f = fixture();
  const c = new Controller(f.storage, async () => f.snapshot);
  await c.boot();
  await c.refresh();
  assert.equal(String(c.connection.kind), "online");
  c.pause();
  assert.equal(String(c.connection.kind), "offline");
  assert.ok(c.local.snapshot);
  await c.refresh();
  assert.equal(String(c.connection.kind), "online");
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw Error("Deferred promise not initialized");
  };
  let reject: (reason: unknown) => void = () => {
    throw Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("draft is durable while the snapshot long poll is still held", { timeout: 1000 }, async () => {
  const f = fixture();
  const started = deferred<void>();
  const held = deferred<unknown>();
  const c = new Controller(f.storage, async () => {
    started.resolve();
    return held.promise;
  });
  await c.boot();
  const refreshing = c.refresh();
  await started.promise;
  await c.setDraft("bot", { text: "Conservé immédiatement", mentions: [] });
  const cached = JSON.parse(f.data.get(`mino:space:${deviceId}`) ?? "null");
  assert.equal(cached.drafts.bot.text, "Conservé immédiatement");
  await c.forget();
  await refreshing;
  held.resolve(f.snapshot);
});

test("durable enqueue preempts a held poll and delivers once without waiting for its response", { timeout: 1000 }, async () => {
  const f = fixture();
  const started = deferred<void>();
  const heldPoll = deferred<unknown>();
  const posted = deferred<void>();
  const reply = deferred<unknown>();
  const paths: string[] = [];
  const bodies: string[] = [];
  let pollSignal: AbortSignal | undefined;
  const c = new Controller(f.storage, async (_s, path, body, signal) => {
    paths.push(path);
    if (path.includes("after=")) {
      pollSignal = signal;
      started.resolve();
      return heldPoll.promise;
    }
    if (path === "/m/view") return { ...f.snapshot, rev: 2 };
    bodies.push(body ?? "");
    posted.resolve();
    return reply.promise;
  });
  await c.boot();
  const draft = { text: "Bonjour", mentions: [] };
  await c.setDraft("bot", draft);
  const first = c.refresh();
  await started.promise;
  await c.enqueue({ ...command, attachments: [] }, draft);
  const second = c.refresh();
  await posted.promise;
  assert.equal(pollSignal?.aborted, true);
  assert.deepEqual(paths, ["/m/view?after=0", "/m/view", "/m/commands"]);
  assert.deepEqual(bodies, [JSON.stringify({ ...command, attachments: [] })]);
  const cached = JSON.parse(f.data.get(`mino:space:${deviceId}`) ?? "null");
  assert.equal(cached.queue[0].bytes, bodies[0]);
  assert.equal(cached.queue[0].state, "unknown");
  assert.equal(cached.drafts.bot.text, "");
  await c.setDraft("bot", { text: "La suite", mentions: [] });
  assert.ok(f.data.get(`mino:space:${deviceId}`)?.includes("La suite"));
  reply.resolve({
    ok: true,
    replayed: false,
    result: { kind: "message", messageId: "m", workId: "w" },
    view: { ...f.snapshot, rev: 3 },
  });
  await Promise.all([first, second]);
  heldPoll.resolve({ ...f.snapshot, rev: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(c.local.snapshot?.rev, 3);
  assert.equal(c.local.queue.length, 0);
  assert.equal(c.local.drafts.bot.text, "La suite");
  assert.equal(bodies.length, 1);
});

test("older view and command replies cannot replace a newer snapshot or purge its drafts", async () => {
  const f = fixture();
  let gets = 0;
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (!body) {
      gets++;
      return gets === 1
        ? { ...f.snapshot, rev: 10 }
        : { ...f.snapshot, rev: 9, purged: { botIds: ["bot"], workIds: [] } };
    }
    return {
      ok: true,
      replayed: false,
      result: { kind: "message", messageId: "m", workId: "w" },
      view: { ...f.snapshot, rev: 8 },
    };
  });
  await c.boot();
  await c.refresh();
  await c.setDraft("bot", { text: "Révision récente", mentions: [] });
  await c.enqueue({ ...command, attachments: [] });
  await c.refresh();
  assert.equal(c.local.snapshot?.rev, 10);
  assert.equal(c.local.drafts.bot.text, "Révision récente");
  assert.equal(c.local.queue.length, 0);
  assert.equal(JSON.parse(f.data.get(`mino:space:${deviceId}`) ?? "null").snapshot.rev, 10);
});

test("preempted poll still fetches purges before replay", { timeout: 1000 }, async () => {
  const f = fixture();
  const started = deferred<void>();
  const held = deferred<unknown>();
  let posts = 0;
  const c = new Controller(f.storage, async (_s, path, body) => {
    if (body) {
      posts++;
      throw Error("Purged commands must never be sent");
    }
    if (path.includes("after=")) {
      started.resolve();
      return held.promise;
    }
    return { ...f.snapshot, rev: 2, purged: { botIds: ["bot"], workIds: [] } };
  });
  await c.boot();
  await c.setDraft("bot", { text: "À supprimer", mentions: [] });
  const refreshing = c.refresh();
  await started.promise;
  await c.enqueue({ ...command, attachments: [] });
  await refreshing;
  held.resolve(f.snapshot);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(posts, 0);
  assert.equal(c.local.snapshot?.rev, 2);
  assert.equal(c.local.queue.length, 0);
  assert.equal(c.local.drafts.bot, undefined);
});

test("revocation after poll preemption prevents a late snapshot from restoring private data", { timeout: 1000 }, async () => {
  const f = fixture();
  const started = deferred<void>();
  const held = deferred<unknown>();
  let posts = 0;
  const c = new Controller(f.storage, async (_s, path, body) => {
    if (body) posts++;
    if (path.includes("after=")) {
      started.resolve();
      return held.promise;
    }
    throw new RemoteError(401, "revoked", "revoked");
  });
  await c.boot();
  const refreshing = c.refresh();
  await started.promise;
  await c.enqueue({ ...command, attachments: [] });
  await refreshing;
  held.resolve({ ...f.snapshot, rev: 100 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(posts, 0);
  assert.equal(f.getSecret(), null);
  assert.equal(f.data.size, 0);
  assert.equal(c.connection.kind, "revoked");
  assert.equal(c.local.snapshot, null);
  assert.equal(c.local.queue.length, 0);
});

test("forget completes during a held POST and its late reply cannot affect a new pairing", { timeout: 1000 }, async () => {
  const f = fixture();
  const started = deferred<void>();
  const held = deferred<unknown>();
  const c = new Controller(f.storage, async (_s, _p, body) => {
    if (!body) return f.snapshot;
    started.resolve();
    return held.promise;
  });
  await c.boot();
  await c.enqueue({ ...command, attachments: [] });
  const refreshing = c.refresh();
  await started.promise;
  await c.forget();
  await c.pair(
    {
      version: 1,
      url: session.url,
      spaceId: "another-space",
      pairingId: deviceId,
      secret: "b".repeat(64),
      expiresAt: new Date(Date.now() + 100000).toISOString(),
    },
    { deviceId, deviceToken: "c".repeat(64), deviceName: "New phone" },
  );
  const newSecret = f.getSecret();
  held.resolve({
    ok: true,
    replayed: false,
    result: { kind: "message", messageId: "m", workId: "w" },
    view: { ...f.snapshot, rev: 100 },
  });
  await refreshing;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.getSecret(), newSecret);
  assert.equal(c.connection.kind, "pairing");
  assert.equal(c.local.snapshot, null);
  assert.equal(c.local.queue.length, 0);
  assert.equal(f.data.size, 0);
});

test("an aborted old refresh cannot revoke a newer successful refresh", { timeout: 1000 }, async () => {
  const f = fixture();
  const started = deferred<void>();
  const held = deferred<unknown>();
  let gets = 0;
  const c = new Controller(f.storage, async () => {
    gets++;
    if (gets === 1) {
      started.resolve();
      return held.promise;
    }
    return { ...f.snapshot, rev: 2 };
  });
  await c.boot();
  const abort = new AbortController();
  const first = c.refresh(abort.signal);
  await started.promise;
  abort.abort();
  await first;
  await c.refresh();
  held.reject(new RemoteError(401, "revoked", "late old response"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(c.connection.kind, "online");
  assert.equal(c.local.snapshot?.rev, 2);
  assert.ok(f.getSecret());
});


test("pairing bases accept origins and reject arbitrary paths", () => {
  assert.throws(() => safeBase("https://example.com/private"));
  assert.throws(() => safeBase("http://127.0.0.1:4317/proxy", true));
  assert.equal(safeBase("https://example.com/"), "https://example.com");
});

test('actual HTTP refusal reaches the outbox and is not retried as a network failure', async () => {
  const { createTransport } = await import('../src/network');
  const f = fixture(); let posts = 0;
  const network = createTransport(false, async (_url, init) => {
    if (init?.method === 'POST') { posts++; return new Response(JSON.stringify({ok:false,code:'stale_base',message:'La version a changé.',view:f.snapshot}),{status:409}); }
    return new Response(JSON.stringify(f.snapshot),{status:200});
  });
  const c = new Controller(f.storage,network); await c.boot(); await c.enqueue({...command,attachments:[]}); await c.refresh();
  assert.equal(c.local.queue[0]?.state,'refused'); assert.equal(c.local.queue[0]?.message,'La version a changé.'); assert.equal(c.connection.kind,'online');
  await c.refresh(); assert.equal(posts,1);
  const unauthorized=createTransport(false,async()=>new Response(JSON.stringify({ok:false,code:'device_unauthorized',message:'Retiré'}),{status:401}));
  await assert.rejects(()=>unauthorized(session,'/m/commands','{}'),e=>e instanceof RemoteError&&e.status===401);
});

test('expired pairing is explained and the claim is cleared instead of retrying forever', async () => {
 const f=fixture();let calls=0;const c=new Controller(f.storage,async()=>{calls++;throw new RemoteError(403,'pairing_expired','Ce code a expiré.');});
 await c.boot();await c.pair({version:1,url:session.url,spaceId:'space',pairingId:deviceId,secret:'b'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()},{deviceId,deviceName:'iPhone',deviceToken:session.token});await c.refresh();
 assert.equal(c.connection.kind,'revoked');assert.equal(f.getSecret(),null);await c.refresh();assert.equal(calls,1);
});

test('browser cookie resumes pending approval and survives reload without a JavaScript token', async () => {
  const f = fixture();
  const cookie = { kind: 'cookie', url: session.url, spaceId: session.spaceId, deviceId };
  await f.storage.writeSecret(JSON.stringify({ session: cookie, claim: null }));
  let approved = false;
  let reads = 0;
  const transport: Transport = async (_s, path) => {
    if (path === '/m/pair/status') return { state: approved ? 'active' : 'pending', deviceId, spaceId: 'space', confirmCode: '271828' };
    reads++;
    return f.snapshot;
  };
  const first = new Controller(f.storage, transport);
  await first.boot(); await first.refresh();
  assert.deepEqual(first.connection, { kind: 'pairing', confirmCode: '271828' });
  assert.equal(reads, 0);
  approved = true;
  await first.refresh();
  assert.equal(first.connection.kind, 'online');
  await first.setDraft('bot', { text: 'Mon brouillon', mentions: [] });
  const second = new Controller(f.storage, transport);
  await second.boot(); await second.refresh();
  assert.equal(second.connection.kind, 'online');
  assert.equal(second.local.drafts.bot?.text, 'Mon brouillon');
  assert.equal(JSON.parse(f.getSecret() ?? '{}').session.token, undefined);
});

test('cookie transport stays on the current origin and never sends a bearer', async () => {
  const { createTransport } = await import('../src/network');
  const cookie = { kind: 'cookie' as const, url: session.url, spaceId: session.spaceId, deviceId };
  const network = createTransport(false, async (url, init) => {
    assert.equal(url, '/m/commands');
    assert.equal(init?.credentials, 'same-origin');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), null);
    assert.equal(headers.get('X-Mino-Web'), '1');
    return new Response(JSON.stringify({ ok: false, code: 'stale_base', message: 'Version modifiée.' }), { status: 409 });
  });
  const reply = await network(cookie, '/m/commands', '{}');
  assert.deepEqual(reply, { ok: false, code: 'stale_base', message: 'Version modifiée.' });
});
