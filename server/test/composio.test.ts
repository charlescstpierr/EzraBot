import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComposioToolInputRequiredError, ComposioRequestCancelledError } from '@composio/core';
import { ProviderError, createComposioProvider, createComposioSdk, type SdkPort, type SessionPort } from '../src/composio.js';
import { schemaSha256, type Pin } from '../src/tool-ledger.js';
import { SEND_EMAIL } from './fixtures/fake-composio.js';

// A fake of the SDK surface the adapter uses, typed by the SDK's own signatures. Every value is synthetic.

const OWNER = 'owner-synthetique';
const PIN: Pin = { proposalId: 'tp_1', toolkit: 'gmail', accountId: 'ca_synthetique_a', toolSlug: 'GMAIL_SEND_EMAIL', version: '20260101_00', schemaSha256: schemaSha256(SEND_EMAIL.inputSchema) };
const ARGS = { to: 'personne@exemple.invalid', subject: 'Bonjour', body: 'Texte synthétique.' };
const SECRET_TEXT = 'Bearer jeton-synthetique-qui-ne-doit-pas-sortir';

type AuthConfigPage = Awaited<ReturnType<SdkPort['authConfigs']['list']>>;
type AccountPage = Awaited<ReturnType<SdkPort['connectedAccounts']['list']>>;
type RawTools = Awaited<ReturnType<SdkPort['tools']['getRawToolRouterSessionTools']>>;
type ExecuteResult = Awaited<ReturnType<SessionPort['execute']>>;

const authConfig = (id: string, toolkit: string, authScheme: AuthConfigPage['items'][number]['authScheme'], extra: Partial<AuthConfigPage['items'][number]> = {}): AuthConfigPage['items'][number] => ({
  id, name: `Config ${id}`, toolkit: { slug: toolkit, logo: '' }, noOfConnections: 0, status: 'ENABLED', authScheme, credentials: { client_secret: SECRET_TEXT }, ...extra,
});

const account = (id: string, extra: Partial<AccountPage['items'][number]> = {}): AccountPage['items'][number] => ({
  id, authConfig: { id: 'ac_1', isComposioManaged: true, isDisabled: false }, status: 'ACTIVE', statusReason: null, toolkit: { slug: 'gmail' },
  isDisabled: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', alias: 'Compte synthétique A', data: { access_token: SECRET_TEXT }, ...extra,
});

function fakeSdk(script: {
  rawTools?: RawTools;
  execute?: (...args: Parameters<SessionPort['execute']>) => Promise<ExecuteResult>;
  createFails?: boolean;
  authConfigPages?: AuthConfigPage[];
  accountPages?: AccountPage[];
  redirectUrl?: string | null;
} = {}) {
  const calls = {
    create: [] as Parameters<SdkPort['sessions']['create']>[],
    rawTools: [] as string[],
    execute: [] as Parameters<SessionPort['execute']>[],
    authorize: [] as Parameters<SessionPort['authorize']>[],
    accountLists: [] as Parameters<SdkPort['connectedAccounts']['list']>[0][],
    authConfigLists: [] as Parameters<SdkPort['authConfigs']['list']>[0][],
  };
  const sdk: SdkPort = {
    authConfigs: {
      async list(query) {
        calls.authConfigLists.push(query);
        return script.authConfigPages?.[calls.authConfigLists.length - 1] ?? { items: [], nextCursor: null, totalPages: 1 };
      },
    },
    connectedAccounts: {
      async list(query) {
        calls.accountLists.push(query);
        return script.accountPages?.[calls.accountLists.length - 1] ?? { items: [], nextCursor: null, totalPages: 1 };
      },
    },
    sessions: {
      async create(...args) {
        calls.create.push(args);
        if (script.createFails) throw Object.assign(new Error(SECRET_TEXT), { status: 401 });
        const sessionId = `session-synthetique-${calls.create.length}`;
        return {
          sessionId,
          async authorize(...authorizeArgs) {
            calls.authorize.push(authorizeArgs);
            return { id: 'ca_synthetique_nouveau', redirectUrl: script.redirectUrl === undefined ? 'https://connexion-synthetique.invalid/lien' : script.redirectUrl };
          },
          async execute(...executeArgs) {
            calls.execute.push(executeArgs);
            return script.execute ? script.execute(...executeArgs) : { data: { id: 'resultat_synthetique' }, error: null, logId: 'log_synthetique', resultType: 'completed' };
          },
        };
      },
    },
    tools: {
      async getRawToolRouterSessionTools(sessionId) {
        calls.rawTools.push(sessionId);
        return script.rawTools ?? [{ slug: SEND_EMAIL.slug, name: SEND_EMAIL.name, description: SEND_EMAIL.description, version: '20260101_00', toolkit: { slug: 'gmail', name: 'Gmail' }, inputParameters: SEND_EMAIL.inputSchema as NonNullable<RawTools[number]['inputParameters']> }];
      },
    },
  };
  return { sdk, calls, provider: createComposioProvider({ sdk, ownerId: OWNER, readTimeoutMs: 200, executeTimeoutMs: 60 }) };
}

const rawSend = (extra: Partial<RawTools[number]>): RawTools => [{
  slug: SEND_EMAIL.slug, name: SEND_EMAIL.name, version: '20260101_00', toolkit: { slug: 'gmail', name: 'Gmail' },
  inputParameters: SEND_EMAIL.inputSchema as NonNullable<RawTools[number]['inputParameters']>, ...extra,
}];

test('a send opens a fresh direct session pinned to one account and one action, checks that session, then executes once', async () => {
  const { provider, calls } = fakeSdk();
  assert.deepEqual(await provider.send(PIN, ARGS), { kind: 'completed', data: { id: 'resultat_synthetique' }, error: null, logId: 'log_synthetique' });
  assert.deepEqual(calls.create.map(args => args.slice(0, 2)), [[OWNER, {
    sessionPreset: 'direct_tools',
    toolkits: { enable: ['gmail'] },
    tools: { gmail: { enable: ['GMAIL_SEND_EMAIL'] } },
    connectedAccounts: { gmail: 'ca_synthetique_a' },
    manageConnections: false,
    sandbox: { enable: false },
    proxyExecute: false,
  }]]);
  assert.deepEqual(calls.rawTools, ['session-synthetique-1'], 'the catalogue read is the one of the session that executes');
  assert.deepEqual(calls.execute.map(args => args.slice(0, 3)), [['GMAIL_SEND_EMAIL', ARGS, { account: 'ca_synthetique_a' }]]);
});

test('a session whose catalogue differs from the approved pin sends nothing', async () => {
  const cases: [RawTools, string][] = [
    [rawSend({ version: '20260303_00' }), 'schema_changed'],
    [rawSend({ inputParameters: { type: 'object', properties: { to: { type: 'string' } } } }), 'schema_changed'],
    [rawSend({ version: undefined }), 'version_missing'],
    [rawSend({ slug: 'GMAIL_OTHER' }), 'tool_absent'],
    [rawSend({ toolkit: { slug: 'slack', name: 'Slack' } }), 'tool_absent'],
    [[], 'tool_absent'],
  ];
  for (const [rawTools, reason] of cases) {
    const { provider, calls } = fakeSdk({ rawTools });
    assert.deepEqual(await provider.send(PIN, ARGS), { kind: 'not_sent', reason });
    assert.equal(calls.execute.length, 0, reason);
  }
  const refused = fakeSdk({ createFails: true });
  assert.deepEqual(await refused.provider.send(PIN, ARGS), { kind: 'not_sent', reason: 'session' });
  assert.equal(refused.calls.execute.length, 0);
});

test('the result type decides the outcome: a failure with a null error stays a failure, and a block stays a block', async () => {
  const failed = fakeSdk({ execute: async () => ({ data: {}, error: null, logId: 'log_f', resultType: 'failed' }) });
  assert.deepEqual(await failed.provider.send(PIN, ARGS), { kind: 'failed', data: {}, error: null, logId: 'log_f' });
  const blocked = fakeSdk({ execute: async () => ({ data: {}, error: 'Règle du service', logId: 'log_b', resultType: 'blocked' }) });
  assert.equal((await blocked.provider.send(PIN, ARGS)).kind, 'blocked');
});

test('an input request is never answered, and any other execute failure is unknown after exactly one call', async () => {
  const input = fakeSdk({ execute: async () => { throw new ComposioToolInputRequiredError('GMAIL_SEND_EMAIL', { inputRequests: {} }); } });
  assert.deepEqual(await input.provider.send(PIN, ARGS), { kind: 'input_required' });
  assert.equal(input.calls.execute.length, 1);
  assert.equal(input.calls.execute[0]?.[2]?.inputResponses, undefined);

  const dropped = fakeSdk({ execute: async () => { throw new Error(`socket hang up ${SECRET_TEXT}`); } });
  assert.deepEqual(await dropped.provider.send(PIN, ARGS), { kind: 'unknown', category: 'transport' });
  assert.equal(dropped.calls.execute.length, 1, 'no retry');
  assert.equal(dropped.calls.create.length, 1, 'no second session');

  const garbled = fakeSdk({ execute: async () => { throw Object.assign(new Error('bad shape'), { name: 'ZodError' }); } });
  assert.deepEqual(await garbled.provider.send(PIN, ARGS), { kind: 'unknown', category: 'response' });

  const silent = fakeSdk({ execute: () => new Promise<ExecuteResult>(() => {}) });
  assert.deepEqual(await silent.provider.send(PIN, ARGS), { kind: 'unknown', category: 'timeout' });
  assert.equal(silent.calls.execute.length, 1);
});

test('an account is read through the owner filter only, across pages, as a projection without credentials', async () => {
  const { provider, calls } = fakeSdk({ accountPages: [
    { items: [account('ca_autre')], nextCursor: 'page-2', totalPages: 2 },
    { items: [account('ca_synthetique_a'), account('ca_desactive', { isDisabled: true })], nextCursor: null, totalPages: 2 },
  ] });
  assert.deepEqual(await provider.account('ca_synthetique_a', 'gmail'), { id: 'ca_synthetique_a', toolkit: 'gmail', alias: 'Compte synthétique A', status: 'ACTIVE' });
  assert.deepEqual(calls.accountLists, [
    { userIds: [OWNER], toolkitSlugs: ['gmail'], limit: 50 },
    { userIds: [OWNER], toolkitSlugs: ['gmail'], limit: 50, cursor: 'page-2' },
  ]);
  const absent = fakeSdk({ accountPages: [{ items: [account('ca_autre')], nextCursor: null, totalPages: 1 }] });
  assert.equal(await absent.provider.account('ca_synthetique_a', 'gmail'), null, 'an account the owner does not have does not exist');
  const disabled = fakeSdk({ accountPages: [{ items: [account('ca_desactive', { isDisabled: true, alias: null, wordId: 'mot-synthetique' })], nextCursor: null, totalPages: 1 }] });
  assert.deepEqual(await disabled.provider.account('ca_desactive', 'gmail'), { id: 'ca_desactive', toolkit: 'gmail', alias: 'mot-synthetique', status: 'INACTIVE' });
});

test('the catalogue is the project’s own: OAuth 2 is connectable, other methods are listed as unavailable with a reason', async () => {
  const { provider, calls } = fakeSdk({ authConfigPages: [
    { items: [authConfig('ac_gmail', 'gmail', 'OAUTH2'), authConfig('ac_notion', 'notion', 'API_KEY')], nextCursor: 'suite', totalPages: 2 },
    { items: [authConfig('ac_slack', 'slack', 'OAUTH2', { isEnabledForToolRouter: false }), authConfig('ac_off', 'github', 'OAUTH2', { status: 'DISABLED' })], nextCursor: null, totalPages: 2 },
  ] });
  const services = await provider.catalog();
  assert.deepEqual(services.map(s => [s.id, s.toolkit, s.connectable]), [['ac_gmail', 'gmail', true], ['ac_notion', 'notion', false], ['ac_slack', 'slack', false]]);
  assert.match(services[1]?.reason ?? '', /API_KEY.*OAuth 2/);
  assert.equal(calls.authConfigLists.length, 2);
  assert.doesNotMatch(JSON.stringify(services), /jeton-synthetique|client_secret/, 'auth config credentials never leave the adapter');
});

test('a connection starts from a catalogue entry, with the owner, the alias and the callback, and returns the address once', async () => {
  const pages = [{ items: [authConfig('ac_gmail', 'gmail', 'OAUTH2'), authConfig('ac_notion', 'notion', 'API_KEY')], nextCursor: null, totalPages: 1 }];
  const { provider, calls } = fakeSdk({ authConfigPages: pages });
  assert.deepEqual(await provider.startLink('ac_gmail', 'Courriel perso', 'http://127.0.0.1:4317/api/tools/callback?link=tl_1'),
    { accountId: 'ca_synthetique_nouveau', toolkit: 'gmail', redirectUrl: 'https://connexion-synthetique.invalid/lien' });
  assert.deepEqual(calls.create.map(args => args.slice(0, 2)), [[OWNER, {
    sessionPreset: 'direct_tools', toolkits: { enable: ['gmail'] }, authConfigs: { gmail: 'ac_gmail' }, manageConnections: false, sandbox: { enable: false }, proxyExecute: false,
  }]]);
  assert.deepEqual(calls.authorize.map(args => args.slice(0, 2)), [['gmail', { callbackUrl: 'http://127.0.0.1:4317/api/tools/callback?link=tl_1', alias: 'Courriel perso' }]]);

  await assert.rejects(fakeSdk({ authConfigPages: pages }).provider.startLink('ac_notion', 'Notes', 'http://127.0.0.1:4317/x'), (error: unknown) => error instanceof ProviderError && error.category === 'not_found');
  await assert.rejects(fakeSdk({ authConfigPages: pages }).provider.startLink('ac_inconnu', 'X', 'http://127.0.0.1:4317/x'), ProviderError);
  for (const redirectUrl of [null, 'javascript:alert(1)', 'http://connexion.invalid/lien']) {
    await assert.rejects(fakeSdk({ authConfigPages: pages, redirectUrl }).provider.startLink('ac_gmail', 'A', 'http://127.0.0.1:4317/x'), ProviderError);
  }
});

test('an SDK failure leaves the adapter as a category, without its message, status text or cause', async () => {
  const { provider } = fakeSdk({ createFails: true });
  await assert.rejects(provider.toolsFor('gmail', 'ca_synthetique_a'), (error: unknown) => {
    assert(error instanceof ProviderError);
    assert.equal(error.category, 'unauthorized');
    assert.doesNotMatch(`${error.message} ${String(error.stack)} ${JSON.stringify(error)}`, /jeton-synthetique/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('the raw catalogue keeps the version and the schema, and an action without them stays without them', async () => {
  const { provider, calls } = fakeSdk({ rawTools: [...rawSend({}), { slug: 'GMAIL_LIST_LABELS', name: 'Libellés' }] });
  assert.deepEqual(await provider.toolsFor('gmail', 'ca_synthetique_a', ['GMAIL_SEND_EMAIL', 'GMAIL_LIST_LABELS']), [
    { slug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', name: SEND_EMAIL.name, description: '', version: '20260101_00', inputSchema: SEND_EMAIL.inputSchema },
    { slug: 'GMAIL_LIST_LABELS', toolkit: '', name: 'Libellés', description: '', version: null, inputSchema: null },
  ]);
  assert.deepEqual(calls.create[0]?.[1]?.tools, { gmail: { enable: ['GMAIL_SEND_EMAIL', 'GMAIL_LIST_LABELS'] } });
});

test('the real SDK client sends only the explicit key to the fixed provider address, whatever the environment says', async () => {
  const saved = { fetch: globalThis.fetch, key: process.env.COMPOSIO_API_KEY, base: process.env.COMPOSIO_BASE_URL };
  const requests: { url: URL; headers: Headers }[] = [];
  // Nothing leaves this process: the stub answers every request itself with a synthetic empty page.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: new URL(request.url), headers: request.headers });
    return new Response(JSON.stringify({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.COMPOSIO_API_KEY = 'cle-environnement-synthetique';
  process.env.COMPOSIO_BASE_URL = 'https://detournement.invalid';
  try {
    const sdk = createComposioSdk('cle-explicite-synthetique');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(requests.length, 0, 'building the client contacts nobody: no telemetry, no version check');
    await sdk.authConfigs.list({ limit: 1 }).catch(() => {});
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url.origin, 'https://backend.composio.dev');
    assert.equal(requests[0]?.headers.get('x-api-key'), 'cle-explicite-synthetique');
    assert.doesNotMatch(JSON.stringify([...(requests[0]?.headers ?? [])]), /cle-environnement/);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.COMPOSIO_BASE_URL; else process.env.COMPOSIO_BASE_URL = saved.base;
  }
});


test('a timed out SDK request is cancelled, and a cancelled execution remains unknown without retry', async () => {
  let executeSignal: AbortSignal | undefined;
  const execution = fakeSdk({ execute: async (...args) => {
    executeSignal = args[3]?.signal;
    return new Promise<ExecuteResult>((_resolve, reject) => executeSignal?.addEventListener('abort', () => reject(new ComposioRequestCancelledError()), { once: true }));
  } });
  assert.deepEqual(await execution.provider.send(PIN, ARGS), { kind: 'unknown', category: 'timeout' });
  assert.equal(executeSignal?.aborted, true);
  assert.equal(execution.calls.execute.length, 1);

  const read = fakeSdk();
  let readSignal: AbortSignal | undefined;
  read.sdk.authConfigs.list = async (_query, options) => {
    readSignal = options?.signal;
    return new Promise<AuthConfigPage>((_resolve, reject) => readSignal?.addEventListener('abort', () => reject(new ComposioRequestCancelledError()), { once: true }));
  };
  await assert.rejects(read.provider.catalog(), (error: unknown) => error instanceof ProviderError && error.category === 'timeout');
  assert.equal(readSignal?.aborted, true);
});

test('a session returned by the installed SDK forwards the execution signal to fetch and never retries an abort', async () => {
  const previousFetch = globalThis.fetch;
  let sends = 0;
  let aborted = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/execute')) {
      sends += 1;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Synthetic cancellation', 'AbortError'));
        }, { once: true });
      });
    }
    return new Response(JSON.stringify({ session_id: 'session_synthetic', config: {}, config_version: 1, mcp: { type: 'http', url: 'https://backend.composio.dev/synthetic-mcp' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const sdk = createComposioSdk('cle-synthetique');
    const session: SessionPort = await sdk.sessions.create(OWNER, { sessionPreset: 'direct_tools' });
    const controller = new AbortController();
    const execution = session.execute(PIN.toolSlug, ARGS, { account: PIN.accountId }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await assert.rejects(execution, ComposioRequestCancelledError);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(sends, 1);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
