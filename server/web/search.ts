import type { AppView } from '../src/protocol.js';

/** Where a result leads back to: a message of the thread, or the current version of a deliverable. */
export type HitTarget =
  | { kind: 'message'; messageId: string; role: 'user' | 'assistant' }
  | { kind: 'version'; workId: string; versionId: string; n: number };

export type Hit = {
  threadBotId: string;
  botId: string;
  target: HitTarget;
  createdAt: string;
  snippet: { before: string; match: string; after: string };
};

type Searchable = { threadBotId: string; botId: string; target: HitTarget; createdAt: string; text: string; folded: string };

/** Lowercase and accent-free, one output character per input UTF-16 unit so offsets map back to the original. */
export function fold(text: string): string {
  return Array.from(text, ch => {
    const base = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    return base.length === ch.length ? base : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
  }).join('');
}

const cache = new Map<string, string>();

/** Drops every folded copy kept for search, so erased text does not linger in this page. */
export function forgetSearch(): void {
  cache.clear();
}

function folded(key: string, text: string): string {
  let value = cache.get(key);
  if (value === undefined) {
    value = fold(text);
    cache.set(key, value);
  }
  return value;
}

function searchable(view: AppView): Searchable[] {
  const items: Searchable[] = view.messages.map(message => ({
    threadBotId: message.threadBotId,
    botId: message.botId,
    target: { kind: 'message', messageId: message.id, role: message.role },
    createdAt: message.createdAt,
    text: message.text,
    folded: folded(`m:${message.id}`, message.text),
  }));
  for (const work of view.works) {
    const version = work.versions.at(-1);
    if (!version) continue;
    const text = `${version.title}\n${version.body}`;
    items.push({
      threadBotId: work.threadBotId,
      botId: work.botId,
      target: { kind: 'version', workId: work.id, versionId: version.id, n: version.n },
      createdAt: version.createdAt,
      text,
      folded: folded(`v:${version.id}`, text),
    });
  }
  return items;
}

/** Local and synchronous: messages and current deliverable versions already in the view. Every term must appear. */
export function searchThread(view: AppView, query: string, limit = 50): Hit[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const item of searchable(view)) {
    if (!terms.every(term => item.folded.includes(term))) continue;
    const first = terms[0] ?? '';
    const at = item.folded.indexOf(first);
    const start = Math.max(0, at - 40);
    const end = Math.min(item.text.length, at + first.length + 60);
    hits.push({
      threadBotId: item.threadBotId,
      botId: item.botId,
      target: item.target,
      createdAt: item.createdAt,
      snippet: {
        before: (start > 0 ? '…' : '') + item.text.slice(start, at).replace(/\s+/g, ' '),
        match: item.text.slice(at, at + first.length),
        after: item.text.slice(at + first.length, end).replace(/\s+/g, ' ') + (end < item.text.length ? '…' : ''),
      },
    });
  }
  return hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
