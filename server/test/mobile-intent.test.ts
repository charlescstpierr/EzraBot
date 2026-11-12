import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadMascots } from '../src/domain.js';
import { MobileSnapshotSchema } from '../src/mobile-protocol.js';
import { requestsBackgroundResult } from '../src/message-intent.js';
import { openStore } from '../src/store.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mino-natural-'));
  const store = openStore({ path: join(dir, 'app.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  return { store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('natural creation starts a durable task once, questions stay in chat and guests retain their thread', () => {
  const f = fixture();
  try {
    const creation = { type: 'message.say', requestId: 'natural-task-1', botId: 'mino', text: 'Peux-tu préparer un plan pour le café Boréal ?', attachments: [] };
    const first = f.store.dispatch(creation);
    assert.equal(first.ok, true);
    assert.equal(f.store.view().tasks.length, 1);
    assert.equal(f.store.dispatch(creation).ok, true);
    assert.equal(f.store.view().tasks.length, 1);
    assert.equal(f.store.dispatch({ ...creation, text: 'Autre demande' }).ok, false);
    f.store.dispatch({ ...creation, requestId: 'natural-chat-1', text: 'Comment faire un plan ?' });
    assert.equal(f.store.view().tasks.length, 1);
    f.store.dispatch({ ...creation, requestId: 'natural-guest-1', text: '@Nova prépare un plan', mentions: [{ botId: 'nova', start: 0, end: 5 }] });
    const guest = f.store.view().works.at(-1);
    assert.equal(guest?.botId, 'nova');
    assert.equal(guest?.threadBotId, 'mino');
    assert.equal(guest?.taskId, null);
    assert.equal(MobileSnapshotSchema.parse({ ...f.store.view(), schemaVersion: 1, engine: { state: 'starting' } }).messages.length, 3);
  } finally { f.close(); }
});
test('a chosen reviewer creates the existing bounded relay and conflicting invitations are refused atomically', () => {
  const f = fixture();
  try {
    const command = { type: 'message.say', requestId: 'natural-review-1', botId: 'mino', text: 'Prépare un rapport', attachments: [], reviewerBotId: 'nova' };
    assert.equal(f.store.dispatch(command).ok, true);
    const task = f.store.view().tasks[0];
    assert.equal(task?.plan, 'relay');
    assert.equal(task?.reviewerBotId, 'nova');
    assert.equal(task?.maxCalls, 3);
    const before = f.store.view().messages.length;
    assert.equal(f.store.dispatch({ ...command, requestId: 'natural-review-2', text: '@Nova rédige un rapport', mentions: [{ botId: 'nova', start: 0, end: 5 }] }).ok, false);
    assert.equal(f.store.view().messages.length, before);
  } finally { f.close(); }
});

test('natural requests recognize accented words and stacked polite prefixes', () => {
  for (const text of ['Rédige un résumé', 'Fais un résumé de la réunion', 'S’il te plaît, peux-tu préparer un plan']) assert.equal(requestsBackgroundResult(text), true);
  assert.equal(requestsBackgroundResult('Comment rédiger un résumé ?'), false);
});
