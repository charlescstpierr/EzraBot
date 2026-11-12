import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrafts, type KeyValueStorage } from '../web/drafts.js';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  constructor(private readonly options: { quotaChars?: number; blocked?: boolean } = {}) {}
  get length() {
    this.guard();
    return this.map.size;
  }
  key(index: number) {
    this.guard();
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    this.guard();
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.guard();
    const used = [...this.map].reduce((sum, [k, v]) => sum + (k === key ? 0 : k.length + v.length), 0);
    if (this.options.quotaChars !== undefined && used + key.length + value.length > this.options.quotaChars) {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    }
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.guard();
    this.map.delete(key);
  }
  copy(): MemoryStorage {
    const clone = new MemoryStorage(this.options);
    for (const [k, v] of this.map) clone.map.set(k, v);
    return clone;
  }
  private guard() {
    if (this.options.blocked) throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
  }
}

let clock = 1_000_000;
const now = () => clock;
const tab = (local: KeyValueStorage | null, session: KeyValueStorage | null = new MemoryStorage()) => {
  const book = openDrafts({ local, session, now });
  book.useSpace('test-space');
  return book;
};
const mino = { kind: 'prompt', botId: 'mino' } as const;
const pixel = { kind: 'prompt', botId: 'pixel' } as const;
const prompt = (text: string, files: { name: string; text: string }[] = []) => ({ text, files });

test('a prompt draft with its files comes back exactly after reloading the same tab, per bot, without a duplicate', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const first = tab(local, session);
  first.write(mino, prompt('Bonjour, voici  ', [{ name: 'notes.txt', text: 'contenu' }]));
  first.write(pixel, prompt('Pour Pixel'));
  const reloaded = tab(local, session);
  assert.notEqual(reloaded.writerId, first.writerId);
  assert.deepEqual(reloaded.read(mino), prompt('Bonjour, voici  ', [{ name: 'notes.txt', text: 'contenu' }]));
  assert.deepEqual(reloaded.read(pixel), prompt('Pour Pixel'));
  assert.deepEqual(reloaded.others(mino), []);
});

test('text typed while a message is being sent is kept whole: acknowledging the earlier capture removes nothing', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const book = tab(local, session);
  const sent = book.write(mino, prompt('Bonjour'));
  book.write(mino, prompt('Bonjour et merci  '));
  assert.equal(book.acknowledge(sent), false);
  assert.deepEqual(book.read(mino), prompt('Bonjour et merci  '));
  const reloaded = tab(local, session);
  assert.deepEqual(reloaded.read(mino), prompt('Bonjour et merci  '));

  const unchanged = reloaded.write(mino, prompt('Autre message'));
  assert.equal(reloaded.acknowledge(unchanged), true);
  assert.equal(reloaded.read(mino), null);
  const next = tab(local, session);
  assert.equal(next.read(mino), null);
  assert.deepEqual(next.others(mino), []);
});

test('acknowledging a send captured for one bot never clears the draft of the bot shown afterwards', () => {
  const book = tab(new MemoryStorage());
  const sent = book.write(mino, prompt('Pour Mino'));
  book.write(pixel, prompt('Brouillon de Pixel'));
  assert.equal(book.acknowledge(sent), true);
  assert.deepEqual(book.read(pixel), prompt('Brouillon de Pixel'));
});

test('two open tabs never overwrite or delete each other’s draft for the same bot', () => {
  const local = new MemoryStorage();
  const a = tab(local);
  const b = tab(local);
  assert.notEqual(a.writerId, b.writerId);
  const fromA = a.write(mino, prompt('Texte de A'));
  b.write(mino, prompt('Texte de B'));
  assert.deepEqual(a.read(mino), prompt('Texte de A'));
  assert.deepEqual(b.read(mino), prompt('Texte de B'));
  assert.deepEqual(a.others(mino).map(o => o.content), [prompt('Texte de B')]);
  assert.equal(a.acknowledge(fromA), true);
  a.discard(mino);
  assert.deepEqual(b.read(mino), prompt('Texte de B'));
  assert.deepEqual(a.others(mino).map(o => o.content), [prompt('Texte de B')]);
});

test('a duplicated tab whose original is still open writes under its own identity', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const original = tab(local, session);
  original.write(mino, prompt('Original'));
  const duplicate = tab(local, session.copy());
  assert.notEqual(duplicate.writerId, original.writerId);
  assert.deepEqual(duplicate.read(mino), prompt('Original'));
  duplicate.write(mino, prompt('Copie'));
  assert.deepEqual(original.read(mino), prompt('Original'));

  clock += 90_001;
  const afterSilence = tab(local, session.copy());
  assert.notEqual(afterSilence.writerId, original.writerId);
  assert.notEqual(afterSilence.writerId, duplicate.writerId);
});

test('resuming another draft copies it and hides it; its owner keeps it, and new typing there shows it again', () => {
  const local = new MemoryStorage();
  const owner = tab(local);
  const reader = tab(local);
  owner.write(mino, prompt('Première version'));
  const [other] = reader.others(mino);
  assert(other);
  assert.deepEqual(reader.adopt(mino, other.id), prompt('Première version'));
  assert.deepEqual(reader.read(mino), prompt('Première version'));
  assert.deepEqual(reader.others(mino), []);
  assert.deepEqual(owner.read(mino), prompt('Première version'), 'the owner still has its draft');
  owner.write(mino, prompt('Seconde version'));
  assert.deepEqual(reader.others(mino).map(o => o.content), [prompt('Seconde version')]);
  const [again] = reader.others(mino);
  assert(again);
  reader.dismiss(mino, again.id);
  assert.deepEqual(reader.others(mino), []);
  assert.deepEqual(owner.read(mino), prompt('Seconde version'), 'dismissing deletes nothing');
});

test('a deliverable draft keeps the version it started from, so a conflict is visible after reload', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const scope = { kind: 'version', workId: 'w_1' } as const;
  const book = tab(local, session);
  book.write(scope, { baseVersionId: 'v_1', title: 'Titre', body: 'Corps modifié' });
  assert.deepEqual(tab(local, session).read(scope), { baseVersionId: 'v_1', title: 'Titre', body: 'Corps modifié' });
  assert.equal(tab(local, session).read({ kind: 'version', workId: 'w_2' }), null);
});

test('full or blocked storage is reported, and the page still holds the draft', () => {
  const full = tab(new MemoryStorage({ quotaChars: 300 }));
  full.write(mino, prompt('x'.repeat(400)));
  assert.equal(full.status(), 'full');
  assert.deepEqual(full.read(mino), prompt('x'.repeat(400)));
  full.write(mino, prompt('court'));
  assert.equal(full.status(), 'durable');

  const blocked = tab(new MemoryStorage({ blocked: true }), new MemoryStorage({ blocked: true }));
  blocked.write(mino, prompt('texte'));
  assert.equal(blocked.status(), 'unavailable');
  assert.deepEqual(blocked.read(mino), prompt('texte'));
  assert.deepEqual(blocked.others(mino), []);

  const absent = tab(null, null);
  absent.write(mino, prompt('texte'));
  assert.equal(absent.status(), 'unavailable');
});

test('corrupt entries left in storage are ignored', () => {
  const local = new MemoryStorage();
  local.map.set('mino.draft.v1|someone|prompt:mino', '{not json');
  local.map.set('mino.draft.v1|other|prompt:mino', JSON.stringify({ nonce: 'n', savedAt: 1, content: { text: 3 } }));
  const book = tab(local);
  assert.deepEqual(book.others(mino), []);
  assert.equal(book.read(mino), null);
});

test('a live writer silent for over 90 seconds cannot acknowledge or discard a duplicated tab’s branch', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const a = tab(local, session);
  const capture = a.write(mino, prompt('A'));
  clock += 90_001;
  const b = tab(local, session.copy());
  b.write(mino, prompt('B'));
  assert.notEqual(a.writerId, b.writerId);
  assert.equal(a.acknowledge(capture), true);
  a.discard(mino);
  assert.deepEqual(b.read(mino), prompt('B'));
  assert.deepEqual(tab(local).others(mino).map(other => other.content), [prompt('B')]);
});

test('two starts from the same session snapshot each own a separate branch', async () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const original = tab(local, session);
  original.write(mino, prompt('Source'));
  const leftSession = session.copy();
  const rightSession = session.copy();
  const [left, right] = await Promise.all([
    Promise.resolve().then(() => tab(local, leftSession)),
    Promise.resolve().then(() => tab(local, rightSession)),
  ]);
  assert.notEqual(left.writerId, right.writerId);
  const leftCapture = left.write(mino, prompt('Gauche'));
  right.write(mino, prompt('Droite'));
  left.acknowledge(leftCapture);
  assert.deepEqual(tab(local, rightSession).read(mino), prompt('Droite'));
  assert.deepEqual(original.read(mino), prompt('Source'));
});

test('a suspended document can resume after its replacement loads without sharing ownership', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const suspended = tab(local, session);
  const captured = suspended.write(mino, prompt('Avant pagehide persisted'));
  const replacement = tab(local, session);
  replacement.write(mino, prompt('Nouvelle page'));
  clock += 10 * 90_001;
  suspended.acknowledge(captured);
  suspended.write(mino, prompt('Ancien document repris'));
  suspended.discard(mino);
  assert.deepEqual(tab(local, session).read(mino), prompt('Nouvelle page'));
});

test('repeated reloads preserve adoption and dismissal markers without hiding later source edits', () => {
  const local = new MemoryStorage();
  const owner = tab(local);
  const session = new MemoryStorage();
  const reader = tab(local, session);
  owner.write(mino, prompt('À reprendre'));
  const [source] = reader.others(mino);
  assert(source);
  reader.adopt(mino, source.id);
  const reloaded = tab(local, session);
  assert.deepEqual(reloaded.read(mino), prompt('À reprendre'));
  assert.deepEqual(reloaded.others(mino), []);
  reloaded.discard(mino);
  const again = tab(local, session);
  assert.equal(again.read(mino), null);
  assert.deepEqual(again.others(mino), []);
  owner.write(mino, prompt('Source modifiée'));
  const [changed] = again.others(mino);
  assert(changed);
  assert.deepEqual(changed.content, prompt('Source modifiée'));
  again.dismiss(mino, changed.id);
  assert.deepEqual(tab(local, session).others(mino), []);
});

class FailingDraftStorage extends MemoryStorage {
  rejectedText = '';
  override setItem(key: string, value: string) {
    if (key.startsWith('mino.draft.') && this.rejectedText && value.includes(this.rejectedText)) {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    }
    super.setItem(key, value);
  }
}

test('failed automatic copies stay in memory, report quota across scopes, and keep the source recoverable', () => {
  const local = new FailingDraftStorage();
  const session = new MemoryStorage();
  const original = tab(local, session);
  original.write(mino, prompt('Non copiable'));
  original.write(pixel, prompt('Copiable'));
  local.rejectedText = 'Non copiable';
  const reloaded = tab(local, session);
  assert.deepEqual(reloaded.read(mino), prompt('Non copiable'));
  assert.equal(reloaded.status(), 'full', 'a successful second scope cannot conceal the first failure');
  const again = tab(local, session);
  assert(again.others(mino).some(other => other.content.text === 'Non copiable'));
  assert.deepEqual(original.read(mino), prompt('Non copiable'));
});

test('failed manual adoption cannot durably hide the only saved source', () => {
  const local = new FailingDraftStorage();
  const owner = tab(local);
  owner.write(mino, prompt('À conserver'));
  const session = new MemoryStorage();
  const reader = tab(local, session);
  const [source] = reader.others(mino);
  assert(source);
  local.rejectedText = 'À conserver';
  reader.adopt(mino, source.id);
  assert.equal(reader.status(), 'full');
  assert.deepEqual(reader.read(mino), prompt('À conserver'));
  assert(tab(local, session).others(mino).some(other => other.id === source.id));
});

test('typing rewrites one owned draft instead of appending a journal per keystroke', () => {
  const local = new MemoryStorage();
  const book = tab(local);
  for (let i = 0; i < 100; i++) book.write(mino, prompt(`Texte ${i}`));
  assert.equal(local.length, 1);
  assert.deepEqual(book.read(mino), prompt('Texte 99'));
});

test('identified mentions survive reload and adoption, and an in-flight capture cannot clear an edited mention draft', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const first = tab(local, session);
  const content = { text: '😀 @Même Nom', files: [], mentions: [{ botId: 'stable-id', start: 3, end: 12 }] };
  first.write(mino, content);
  const restored = tab(local, session);
  assert.deepEqual(restored.read(mino), content);
  const other = tab(local);
  const offered = other.others(mino).find(d => d.content.mentions?.length);
  assert(offered);
  assert.deepEqual(other.adopt(mino, offered.id), content);
  const capture = restored.write(mino, content);
  const changed = { ...content, text: 'X ' + content.text, mentions: [{ botId: 'stable-id', start: 5, end: 14 }] };
  restored.write(mino, changed);
  assert.equal(restored.acknowledge(capture), false);
  assert.deepEqual(restored.read(mino), changed);
});

test('purging a deleted bot removes exactly its drafts from every writer, and a stale tab cannot write them back', () => {
  const local = new MemoryStorage();
  const first = tab(local);
  const second = tab(local);
  const nova = { kind: 'prompt', botId: 'nova' } as const;
  const erasedWork = { kind: 'version', workId: 'w-erased' } as const;
  const otherWork = { kind: 'version', workId: 'w-elsewhere' } as const;
  first.useSpace('space-a');
  second.useSpace('space-a');
  first.write(nova, prompt('PRIVATE_FIRST'));
  first.write(mino, prompt('Pour Mino'));
  first.write(erasedWork, { baseVersionId: 'v1', title: 'T', body: 'PRIVATE_VERSION' });
  second.write(nova, prompt('PRIVATE_SECOND'));
  second.write(otherWork, { baseVersionId: 'v9', title: 'T', body: 'Autre base' });
  first.dismiss(nova, second.others(nova)[0]?.id ?? '');

  first.purge('space-a', [nova, erasedWork]);
  assert.deepEqual([...local.map.keys()].filter(key => /\|(prompt:nova|version:w-erased)$/.test(key) && !key.startsWith('mino.gone.v1|')), [], 'drafts and seen markers of both writers are gone');
  assert.doesNotMatch([...local.map.values()].join(''), /PRIVATE/);
  assert.deepEqual(first.read(mino), prompt('Pour Mino'));
  assert.deepEqual(second.read(otherWork), { baseVersionId: 'v9', title: 'T', body: 'Autre base' }, 'a work merely absent from the view is not touched');
  assert.equal(second.read(nova), null, 'the stale tab no longer reads its page copy');
  second.write(nova, prompt('PRIVATE_AGAIN'));
  assert.equal(second.read(nova), null);
  assert.doesNotMatch([...local.map.values()].join(''), /PRIVATE/, 'a stale tab cannot recreate the draft');
  assert.deepEqual(tab(local).others(nova), []);
  const otherSpace = tab(local);
  otherSpace.useSpace('space-b');
  otherSpace.write(nova, prompt('Autre base de données'));
  assert.deepEqual(otherSpace.read(nova), prompt('Autre base de données'), 'markers of one database never block another on the same origin');
});

test('a reload after a purge does not copy the erased drafts back', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const before = tab(local, session);
  const nova = { kind: 'prompt', botId: 'nova' } as const;
  before.useSpace('space-a');
  before.write(nova, prompt('PRIVATE'));
  tab(local).purge('space-a', [nova]);
  const reloaded = tab(local, session);
  reloaded.useSpace('space-a');
  assert.equal(reloaded.read(nova), null);
  assert.doesNotMatch([...local.map.values()].join(''), /PRIVATE/);
});


test('purging shared seed bot IDs preserves all drafts and markers of another database on the same origin', () => {
  const local = new MemoryStorage();
  const sessionA = new MemoryStorage();
  const sessionB = new MemoryStorage();
  const nova = { kind: 'prompt', botId: 'nova' } as const;
  const a = tab(local, sessionA);
  const b = tab(local, sessionB);
  a.useSpace('database-a');
  b.useSpace('database-b');
  a.write(nova, prompt('DELETE_ONLY_THIS_DATABASE'));
  b.write(nova, prompt('KEEP_OTHER_DATABASE'));
  assert.deepEqual(a.others(nova), []);
  assert.deepEqual(b.others(nova), []);
  const otherKeys = [...local.map].filter(([key]) => key.includes('|database-b|'));
  a.purge('database-a', [nova]);
  assert.deepEqual([...local.map].filter(([key]) => key.includes('|database-b|')), otherKeys);
  assert.deepEqual(b.read(nova), prompt('KEEP_OTHER_DATABASE'));
  const reloaded = tab(local, sessionB);
  reloaded.useSpace('database-b');
  assert.deepEqual(reloaded.read(nova), prompt('KEEP_OTHER_DATABASE'));
  assert.doesNotMatch([...local.map.values()].join(''), /DELETE_ONLY_THIS_DATABASE/);
});

test('a session changing database loads only that database’s writer branch', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const a = tab(local, session);
  a.useSpace('database-a');
  a.write(mino, prompt('A_PRIVATE'));
  const b = tab(local, session);
  b.useSpace('database-b');
  assert.equal(b.read(mino), null);
  b.write(mino, prompt('B_PRIVATE'));
  const back = tab(local, session);
  back.useSpace('database-a');
  assert.deepEqual(back.read(mino), prompt('A_PRIVATE'));
  assert.deepEqual(back.others(mino), []);
});

test('legacy origin-wide drafts migrate once and remain recoverable in the first updated database', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const oldWriter = 'legacy-writer-123';
  session.setItem('mino.writer', oldWriter);
  local.setItem(`mino.draft.v1|${oldWriter}|prompt:mino`, JSON.stringify({nonce:'old',savedAt:1,content:prompt('ANCIEN BROUILLON')}));
  const current = openDrafts({local, session, now});
  current.useSpace('database-a');
  assert.deepEqual(current.read(mino), prompt('ANCIEN BROUILLON'));
  assert(![...local.map.keys()].some(key=>key.startsWith('mino.draft.v1|')));
  const elsewhere = openDrafts({local, session, now});
  elsewhere.useSpace('database-b');
  assert.equal(elsewhere.read(mino), null);
  assert.deepEqual(elsewhere.others(mino), []);
});


test('an old page rewriting a legacy draft after deletion is cleaned on the next updated load, never imported', () => {
  const local = new MemoryStorage();
  const oldWriter = 'legacy-writer-123';
  local.setItem('mino.legacy-space.v1', 'database-a');
  const book = openDrafts({local, session:new MemoryStorage(), now});
  book.useSpace('database-a');
  book.purge('database-a', [mino]);
  local.setItem(`mino.draft.v1|${oldWriter}|prompt:mino`, JSON.stringify({nonce:'old',savedAt:1,content:prompt('STALE_REWRITE')}));
  const updated = openDrafts({local, session:new MemoryStorage(), now});
  updated.useSpace('database-a');
  assert.equal(updated.read(mino), null);
  assert.deepEqual(updated.others(mino), []);
  assert.doesNotMatch([...local.map.values()].join(''), /STALE_REWRITE/);
});
