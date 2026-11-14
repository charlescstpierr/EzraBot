import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { z } from 'zod';
import type { PcView, ToolProposalView } from '../src/tools-protocol.js';
import { SEND_EMAIL, createFakeProvider, type FakeProvider } from './fixtures/fake-composio.js';
import { startFakeHoncho, type FakeHoncho } from './fixtures/fake-honcho.js';
import { BOT, startMemory } from './fixtures/memory-app.js';


type App = Awaited<ReturnType<typeof startMemory>>;

const DecisionSchema = z.object({ result: z.object({ decision: z.string(), staleReason: z.string().nullable() }) });
const RefusalSchema = z.object({ code: z.string().optional() });

async function started(extra: { path?: string } = {}, shared?: { honcho: FakeHoncho; provider: FakeProvider }) {
  const honcho = shared?.honcho ?? await startFakeHoncho();
  const provider = shared?.provider ?? createFakeProvider();
  const app = await startMemory({ honcho, provider, scenario: 'tool-call', ...extra });
  return { app, honcho, provider };
}

async function grant(app: App, botIds: readonly string[] = [BOT]): Promise<void> {
  const link = z.object({ linkId: z.string() }).parse(await (await app.post('/api/tools/link', { serviceId: 'ac_synthetique_gmail', alias: 'Courriel de test' })).json());
  assert.equal((await app.post(`/api/tools/links/${link.linkId}/check`, {})).status, 200);
  const accountId = (await app.view()).tools.accounts.find(account => account.status === 'ACTIVE')?.id;
  assert(accountId);
  for (const botId of botIds) {
    const granted = await app.post('/api/tools/commands', { type: 'tools.grant', requestId: randomUUID(), botId, accountId, toolSlugs: [SEND_EMAIL.slug] });
    assert.equal(granted.status, 200, await granted.clone().text());
  }
}

async function proposed(app: App, text: string, botId = BOT): Promise<{ proposal: ToolProposalView; messageId: string }> {
  const workId = await app.say(text, botId);
  const view = await app.until(v => v.tools.proposals.some(p => p.workId === workId), `a proposal for « ${text} »`);
  const proposal = view.tools.proposals.find(p => p.workId === workId);
  const request = view.messages.find(m => m.role === 'user' && m.text === text);
  assert(proposal && request);
  assert.equal(proposal.state, 'open');
  return { proposal, messageId: request.id };
}

const approve = (app: App, proposal: ToolProposalView) =>
  app.post('/api/tools/commands', { type: 'tools.approve', requestId: randomUUID(), proposalId: proposal.id, fingerprint: proposal.fingerprint });

function approveQuietly(app: App, provider: FakeProvider, proposal: ToolProposalView): void {
  const account = provider.accounts.get(proposal.accountId);
  assert(account);
  const outcome = app.store.tools.apply({ type: 'tools.approve', requestId: randomUUID(), proposalId: proposal.id, fingerprint: proposal.fingerprint }, { account, tools: [SEND_EMAIL] });
  assert.equal(outcome.ok, true);
}

async function drained(app: App): Promise<PcView> {
  assert(app.actions);
  app.actions.kick();
  await app.actions.idle();
  await app.quiet();
  return app.view();
}

const find = (view: PcView, proposal: ToolProposalView): ToolProposalView => {
  const found = view.tools.proposals.find(p => p.id === proposal.id);
  assert(found);
  return found;
};
const subjects = (provider: FakeProvider) => provider.sent.map(sent => sent.args.subject);
const serviceCalls = (app: App) => app.store.admission.usage().find(row => row.budget === 'composio')?.calls ?? 0;

const WITHDRAWALS: Record<string, (app: App, messageId: string) => Promise<void>> = {
  'excluded': (app, messageId) => app.accepted({ type: 'memory.exclude', target: { kind: 'message', messageId } }),
  'forgotten with its whole project': app => app.accepted({ type: 'memory.forget', confirmLabel: 'Projet synthétique' }),
  'composed before a declaration was corrected': async app => {
    const [declared] = app.scopeOf(await app.view()).declarations;
    assert(declared);
    await app.accepted({ type: 'memory.correct', declarationId: declared.declarationId, baseRevision: declared.revision, text: 'Préfère le café serré.' });
  },
};

for (const [what, withdraw] of Object.entries(WITHDRAWALS)) {
  test(`an open action whose request is ${what} closes at once: approving it reaches no provider and sends nothing`, async () => {
    const { app, honcho, provider } = await started();
    try {
      await app.enable();
      await app.accepted({ type: 'memory.declare', text: 'Préfère le thé vert.' });
      await app.synced();
      await grant(app);
      const { proposal, messageId } = await proposed(app, 'CANARI_SOURCE_RETIREE');
      await withdraw(app, messageId);

      const reads = provider.reads;
      const decided = await approve(app, proposal);
      const view = await drained(app);
      assert.deepEqual(subjects(provider), [], 'an action built on a withdrawn source never leaves');
      assert.deepEqual([decided.status, RefusalSchema.parse(await decided.json()).code], [409, 'proposal_closed']);
      const closed = find(view, proposal);
      assert.deepEqual([closed.state, closed.staleReason, closed.execution], ['stale', 'source_changed', null]);
      assert.equal(provider.reads, reads, 'the refused approval read nothing at the provider');
      assert.equal(serviceCalls(app), 0, 'and took no place in the service budget');
    } finally {
      await app.stop();
      await honcho.close();
    }
  });
}

test('an approved action is voided when its source is withdrawn before the send, even while the provider account is being read again', async () => {
  const { app, honcho, provider } = await started();
  try {
    await app.enable();
    await grant(app);

    const waiting = await proposed(app, 'Approuvée puis source exclue');
    approveQuietly(app, provider, waiting.proposal);
    await app.accepted({ type: 'memory.exclude', target: { kind: 'message', messageId: waiting.messageId } });
    const first = find(await drained(app), waiting.proposal).execution;
    assert.deepEqual(subjects(provider), [], 'nothing left for the excluded request');
    assert.deepEqual([first?.state, first?.category, first?.report], ['voided', 'memory_changed', 'none']);

    const racing = await proposed(app, 'Exclue pendant la relecture du compte');
    approveQuietly(app, provider, racing.proposal);
    const read = provider.account.bind(provider);
    let entered = (): void => {};
    let release = (): void => {};
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    provider.account = async (accountId, toolkit) => {
      const facts = await read(accountId, toolkit);
      entered();
      await held;
      return facts;
    };
    assert(app.actions);
    app.actions.kick();
    await reading;
    await app.accepted({ type: 'memory.exclude', target: { kind: 'message', messageId: racing.messageId } });
    release();
    const view = await drained(app);
    assert.deepEqual(subjects(provider), [], 'the send that was about to leave never left');
    const second = find(view, racing.proposal).execution;
    assert.deepEqual([second?.state, second?.category, second?.report], ['voided', 'memory_changed', 'none']);
    assert.equal(serviceCalls(app), 0, 'a voided action took no place in the service budget');
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('the approval and the last check before the send read the memory again: a project moved outside EzraBot closes the open action and voids the approved one', async () => {
  const { app: first, honcho, provider } = await started();
  await first.enable();
  await grant(first);
  const open = await proposed(first, 'Mémoire déplacée avant l’approbation');
  const approved = await proposed(first, 'Mémoire déplacée sous l’approbation');
  approveQuietly(first, provider, approved.proposal);
  await first.stop();

  const db = new DatabaseSync(first.path);
  db.exec('UPDATE memory_scopes SET generation = generation + 1');
  db.close();

  const { app: second } = await started({ path: first.path }, { honcho, provider });
  try {
    const decided = await approve(second, open.proposal);
    const view = await drained(second);
    assert.deepEqual(subjects(provider), [], 'neither action left');
    assert.equal(decided.status, 200);
    assert.deepEqual(DecisionSchema.parse(await decided.json()).result, { decision: 'stale', staleReason: 'source_changed' });
    assert.equal(find(view, open.proposal).execution, null);
    const execution = find(view, approved.proposal).execution;
    assert.deepEqual([execution?.state, execution?.category], ['voided', 'memory_changed']);
    assert.equal(serviceCalls(second), 0);
  } finally {
    await second.stop();
    await honcho.close();
  }
});

test('a withdrawal closes the action built on a reply that used the source, and leaves a send already made and the action of another project as they were', async () => {
  const { app, honcho, provider } = await started();
  const NEIGHBOUR = 'atlas';
  try {
    await app.enable();
    await app.enable(NEIGHBOUR, 'Projet voisin');
    await grant(app, [BOT, NEIGHBOUR]);

    const sent = await proposed(app, 'Bilan déjà envoyé');
    assert.equal((await approve(app, sent.proposal)).status, 200);
    await app.until(v => v.tools.proposals.find(p => p.id === sent.proposal.id)?.execution?.report === 'done', 'the first send is reported');
    const built = await proposed(app, 'Suite du même bilan');
    assert.match(app.turn().input, /Bilan déjà envoyé/, 'the second turn received the first exchange');
    const neighbour = await proposed(app, 'Note du projet voisin', NEIGHBOUR);

    await app.accepted({ type: 'memory.exclude', target: { kind: 'message', messageId: sent.messageId } });
    const refused = await approve(app, built.proposal);
    assert.equal((await approve(app, neighbour.proposal)).status, 200);
    await app.until(v => v.tools.proposals.find(p => p.id === neighbour.proposal.id)?.execution?.report === 'done', 'the action of the other project is sent and reported');
    const view = await drained(app);

    assert.deepEqual(subjects(provider), ['Bilan déjà envoyé', 'Note du projet voisin'], 'the earlier send is not repeated, the dependent action never leaves, the other project sends once');
    assert.deepEqual([refused.status, RefusalSchema.parse(await refused.json()).code], [409, 'proposal_closed']);
    assert.deepEqual([find(view, built.proposal).state, find(view, built.proposal).staleReason], ['stale', 'source_changed']);
    const receipt = find(view, sent.proposal);
    assert.deepEqual([receipt.state, receipt.execution?.state, receipt.execution?.report, receipt.execution?.logId], ['approved', 'completed', 'done', 'log_synthetique_1'],
      'the receipt of the send made before the withdrawal is kept as it was');
    assert.equal(find(view, neighbour.proposal).execution?.state, 'completed');
  } finally {
    await app.stop();
    await honcho.close();
  }
});
