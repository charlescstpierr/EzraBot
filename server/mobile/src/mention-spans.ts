// Copied from Mino web/mentions.ts. Only the contract import path changes.
import type { MentionSpan } from './generated/protocol';
export type { MentionSpan } from './generated/protocol';

/** Code ranges include unfinished fences and inline code while composing. */
export function inCode(text: string, at: number): boolean {
  let fence = '';
  let inline = 0;
  const lines = text.slice(0, at).split('\n');
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !inline) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    for (const match of line.matchAll(/`+/g)) {
      if (match.index > 0 && line[match.index - 1] === '\\') continue;
      const length = match[0].length;
      if (!inline) inline = length;
      else if (inline === length) inline = 0;
    }
  }
  return !!fence || inline > 0 || /^(?: {4}|\t)/.test(lines.at(-1) ?? '');
}
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([^@\n]*)$/.exec(text.slice(0, caret));
  if (!match || inCode(text, caret)) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}
export function insertMention(text: string, at: { start: number; caret: number }, bot: { id: string; name: string }) {
  const tag = `@${bot.name}`;
  return { text: text.slice(0, at.start) + tag + ' ' + text.slice(at.caret), caret: at.start + tag.length + 1,
    span: { botId: bot.id, start: at.start, end: at.start + tag.length } };
}
export function rebase(prev: string, next: string, spans: readonly MentionSpan[]): MentionSpan[] {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let oldEnd = prev.length, newEnd = next.length;
  while (oldEnd > start && newEnd > start && prev[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  return spans.flatMap(span => {
    if (start < span.end && oldEnd > span.start || start > span.start && start < span.end) return [];
    const moved = span.start >= oldEnd ? { ...span, start: span.start + delta, end: span.end + delta } : span;
    return next[moved.start] === '@' && !/[\p{L}\p{N}_]/u.test(next[moved.end] ?? '') && !inCode(next, moved.start) ? [moved] : [];
  });
}
export function trimForSend(text: string, spans: readonly MentionSpan[]) {
  const offset = text.length - text.trimStart().length;
  return { text: text.trim(), spans: spans.map(span => ({ ...span, start: span.start - offset, end: span.end - offset })) };
}
