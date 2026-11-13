import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { engineFailure, loadMascots } from '../src/domain.js';
import { openStore, type Claim, type Store } from '../src/store.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const rid = () => randomUUID();
const preview = (store: Store) => {
  const work = store.view().works[0];
  return work && 'replyPreview' in work ? work.replyPreview : null;
};
function begin(store: Store): Claim {
  assert(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'nova', text: 'Bonjour', attachments: [] }).ok);
  const claim = store.claimNext('chat');
  assert(claim);
  store.bindThread(claim, 'thread');
  store.bindTurn(claim, 'turn');
  return claim;
}
function progress(store: Store, claim: Claim, text = '{"reply":"Bonjour\\nà toi', ids = { threadId: 'thread', turnId: 'turn' }) {
  store.recordProgress(claim, { ...ids, itemId: 'item', text, final: false });
}

test('chat preview contains only decoded reply text, changes revision, and is never stored', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mino-preview-')), 'store.sqlite');
  const store = openStore({ path, mascots });
  const claim = begin(store);
  const rev = store.rev;
  progress(store, claim, '{"reply":"Bonjour\\nà toi","deliverable":{"title":"SECRET","body":"PRIVATE"},"handoff":{"text":"HIDDEN"}}');
  assert.equal(preview(store), 'Bonjour\nà toi');
  assert(store.rev > rev);
  assert.equal(store.view().messages.filter(m => m.role === 'assistant').length, 0);
  progress(store, claim, '{"reply":"WRONG', { threadId: 'other', turnId: 'turn' });
  progress(store, claim, '{"reply":"WRONG', { threadId: 'thread', turnId: 'other' });
  progress(store, { ...claim, workId: 'other' }, '{"reply":"WRONG');
  progress(store, { ...claim, n: claim.n + 1 }, '{"reply":"WRONG');
  progress(store, { ...claim, botId: 'mino' }, '{"reply":"WRONG');
  assert.equal(preview(store), 'Bonjour\nà toi');
  progress(store, claim, 'RAW JSON OR REASONING');
  assert.equal(preview(store), 'Bonjour\nà toi');
  store.close();

  const db = new DatabaseSync(path);
  assert.equal(db.prepare('SELECT count(*) AS n FROM attempt_progress').get()?.n, 0);
  db.close();
  const reopened = openStore({ path, mascots });
  try {
    assert.equal(preview(reopened), null);
    reopened.recoverInterrupted();
    assert.equal(preview(reopened), null);
  } finally {
    reopened.close();
  }
});

test('cancel, retry, failure and deletion discard previews and reject late callbacks', () => {
  const store = openStore({ path: ':memory:', mascots });
  try {
    const claim = begin(store);
    progress(store, claim);
    assert.equal(preview(store), 'Bonjour\nà toi');
    assert(store.dispatch({ type: 'work.cancel', requestId: rid(), workId: claim.workId }).ok);
    progress(store, claim, '{"reply":"LATE');
    assert.equal(preview(store), null);
    assert(store.dispatch({ type: 'work.retry', requestId: rid(), workId: claim.workId }).ok);
    const next = store.claimNext('chat');
    assert(next);
    store.bindThread(next, 'thread');
    store.bindTurn(next, 'turn');
    progress(store, claim, '{"reply":"STALE');
    assert.equal(preview(store), null);
    progress(store, next, '{"reply":"Nouvelle');
    assert.equal(preview(store), 'Nouvelle');
    store.finishJob(next, engineFailure('engine_exited'));
    progress(store, next);
    assert.equal(preview(store), null);

    assert(store.dispatch({ type: 'work.retry', requestId: rid(), workId: claim.workId }).ok);
    const last = store.claimNext('chat');
    assert(last);
    store.bindThread(last, 'thread');
    store.bindTurn(last, 'turn');
    progress(store, last);
    assert(store.dispatch({ type: 'work.cancel', requestId: rid(), workId: last.workId }).ok);
    const bot = store.view().bots.find(b => b.id === 'nova');
    assert(bot);
    assert(store.dispatch({ type: 'bot.delete', requestId: rid(), botId: bot.id, confirmName: bot.name, expected: bot.deletion }).ok);
    assert(store.dispatch({ type: 'storage.purge', requestId: rid() }).ok);
    progress(store, last);
    assert.equal(store.view().works.length, 0);
    assert.equal(store.view().messages.length, 0);
  } finally {
    store.close();
  }
});
