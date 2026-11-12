import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterThreads, projectThreads, type ThreadAgents, type ThreadSnapshot } from '../src/threads';

const bot = (id: string, name: string) => ({ id, name, shape: 'sprout', color: '#8de343' });
const message = (id: string, threadBotId: string, botId: string, role: 'user' | 'assistant', text: string, createdAt = '2026-11-07T02:00:00Z'): ThreadSnapshot['messages'][number] => ({ id, threadBotId, botId, role, text, createdAt });
const work = (id: string, threadBotId: string, state: ThreadSnapshot['works'][number]['state'], updatedAt = '2026-11-07T03:00:00Z'): ThreadSnapshot['works'][number] => ({ id, threadBotId, state, updatedAt });
const snapshot = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({ bots: [bot('mino', 'Mino'), bot('nova', 'Nova'), bot('atlas', 'Atlas')], messages: [], works: [], ...over });
const agents = (status: ThreadAgents['missions'][number]['status']): ThreadAgents => ({
  projects: [{ id: 'project-1', name: 'Café Boréal' }],
  missions: [{ id: 'mino', projectId: 'project-1', goalRev: 3, title: 'Préparer la page de préouverture', status, updatedAt: '2026-11-07T04:00:00Z' }],
});

test('conversation shows only its own latest exchange and actual assistant authors, even for guests', () => {
  const source = snapshot({ messages: [
    message('m-2', 'mino', 'nova', 'assistant', 'Le café est prêt.\nOn ouvre demain.'),
    message('m-3', 'nova', 'atlas', 'assistant', 'Texte privé du fil Nova', '2026-11-07T05:00:00Z'),
    message('m-1', 'mino', 'mino', 'user', '@Atlas pourrais-tu relire ?', '2026-11-07T01:00:00Z'),
    message('m-0', 'mino', 'mino', 'assistant', 'Ancienne réponse', '2026-11-06T01:00:00Z'),
  ] });
  const rows = projectThreads(source);
  const mino = rows.find(row => row.key === 'conversation:mino');
  assert.ok(mino);
  assert.equal(mino.preview, 'Le café est prêt. On ouvre demain.');
  assert.deepEqual(mino.participants, [{ id: 'mino', name: 'Mino' }, { id: 'nova', name: 'Nova' }]);
  assert.equal(mino.title, 'Mino');
  assert.equal(mino.updatedAt, '2026-11-07T02:00:00Z');
  assert.equal(filterThreads([mino], 'Texte privé').length, 0);
  assert.deepEqual(source.messages.map(m => m.id), ['m-2', 'm-3', 'm-1', 'm-0']);
});

test('empty conversation has no invented exchange, date or project', () => {
  const mino = projectThreads(snapshot())[0];
  assert.equal(mino?.kind, 'conversation');
  assert.equal(mino?.preview, null);
  assert.equal(mino?.updatedAt, null);
  assert.equal(mino?.status.state, 'idle');
  assert.equal(mino?.project, null);
  assert.deepEqual(mino?.participants, [{ id: 'mino', name: 'Mino' }]);
});

test('conversation state preserves actionable work before concurrent or older completed work', () => {
  const source = snapshot({ works: [work('w1', 'mino', 'done'), work('w2', 'mino', 'running'), work('w3', 'mino', 'review'), work('w4', 'nova', 'failed')] });
  const rows = projectThreads(source);
  assert.deepEqual(rows.find(r => r.key === 'conversation:mino')?.status, { state: 'review', label: 'Votre avis attendu', group: 'attention' });
  assert.equal(rows.find(r => r.key === 'conversation:nova')?.status.state, 'failed');
  const withoutReview = projectThreads({ ...source, works: source.works.filter(w => w.id !== 'w3') });
  assert.equal(withoutReview.find(r => r.key === 'conversation:mino')?.status.state, 'running');
});

test('mission and conversation identities cannot collide and mission does not gain fictional chat metadata', () => {
  const rows = projectThreads(snapshot(), agents('review'));
  const mission = rows.find(row => row.kind === 'mission');
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  assert.equal(mission?.key, 'mission:mino');
  assert.equal(mission?.projectId, 'project-1');
  assert.equal(mission?.goalRev, 3);
  assert.equal(mission?.projectLabel, 'Café Boréal');
  assert.equal(mission?.preview, null);
  assert.equal(mission?.participants, null);
  assert.equal(mission?.title, 'Préparer la page de préouverture');
  assert.equal(rows[0]?.key, 'conversation:mino');
});

test('unknown mission project never borrows another project by name or position', () => {
  const source = agents('queued');
  source.projects = [{ id: 'other-project', name: 'Café Boréal' }];
  const mission = projectThreads(snapshot(), source).find(row => row.kind === 'mission');
  assert.equal(mission?.project, null);
  assert.equal(mission?.projectId, 'project-1');
  assert.equal(mission?.projectLabel, 'Projet indisponible');
});

test('mission stop requested, stopped, unknown and accepted remain distinct user-visible facts', () => {
  for (const [state, label, group] of [
    ['stopping', 'Arrêt demandé', 'working'],
    ['stopped', 'Arrêtée', 'quiet'],
    ['interrupted', 'Résultat inconnu', 'attention'],
    ['accepted', 'Validée', 'done'],
  ] satisfies [ThreadAgents['missions'][number]['status'], string, string][]) {
    const mission = projectThreads(snapshot(), agents(state)).find(row => row.kind === 'mission');
    assert.deepEqual(mission?.status, { state, label, group });
  }
});

test('search ignores accents and case and intersects the selected state filter', () => {
  const source = snapshot({ works: [work('w1', 'mino', 'done')], messages: [message('m1', 'mino', 'mino', 'user', 'Préparer le séjour à Québec')] });
  const rows = projectThreads(source, agents('running'));
  assert.deepEqual(filterThreads(rows, 'quebec', 'done').map(r => r.key), ['conversation:mino']);
  assert.deepEqual(filterThreads(rows, 'CAFE BOREAL', 'working').map(r => r.key), ['mission:mino']);
  assert.deepEqual(filterThreads(rows, 'cafe boreal', 'attention'), []);
  assert.deepEqual(filterThreads(rows, ' MÍNO ').map(r => r.key), ['conversation:mino']);
});

test('main thread stays first and remaining rows sort by recorded dates with stable ties', () => {
  const source = snapshot({ messages: [message('m1', 'nova', 'nova', 'user', 'Plus récent', '2026-11-07T05:00:00Z')] });
  const expected = ['conversation:mino', 'conversation:nova', 'mission:mino', 'conversation:atlas'];
  assert.deepEqual(projectThreads(source, agents('queued')).map(r => r.key), expected);
  assert.deepEqual(projectThreads({ ...source, bots: [...source.bots].reverse() }, agents('queued')).map(r => r.key), expected);
  const empty = projectThreads(snapshot({ bots: [bot('z', 'Z'), bot('a', 'A')] }));
  assert.deepEqual(empty.map(r => r.key), ['conversation:a', 'conversation:z']);
});

test('deleted bot gets no conversation and its preserved guest attribution stays anonymous', () => {
  const source = snapshot({ bots: [bot('mino', 'Mino')], messages: [message('m1', 'mino', 'nova', 'assistant', 'Réponse conservée')] });
  const rows = projectThreads(source);
  assert.deepEqual(rows.map(r => r.key), ['conversation:mino']);
  assert.deepEqual(rows[0]?.participants, [{ id: 'mino', name: 'Mino' }, { id: 'nova', name: 'Bot supprimé' }]);
  assert.equal(filterThreads(rows, 'Nova').length, 0);
});

test('messages sharing a recorded timestamp keep the server order for the last exchange', () => {
  const rows = projectThreads(snapshot({ messages: [
    message('z', 'mino', 'mino', 'user', 'Premier'),
    message('a', 'mino', 'mino', 'assistant', 'Dernier'),
  ] }));
  assert.equal(rows[0]?.preview, 'Dernier');
});


test('a successful later work replaces the old terminal error badge without hiding active work', () => {
  const source = snapshot({ works: [work('old', 'mino', 'failed', '2026-11-06T01:00:00Z'), work('new', 'mino', 'done', '2026-11-07T01:00:00Z')] });
  assert.equal(projectThreads(source)[0]?.status.state, 'done');
  source.works.push(work('active', 'mino', 'pending', '2026-11-07T02:00:00Z'));
  assert.equal(projectThreads(source)[0]?.status.state, 'pending');
});
