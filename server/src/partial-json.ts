/**
 * Reads what has been received so far of a JSON document, without guessing the rest.
 * Strings keep only the characters already decoded; an escape or a surrogate pair cut by the stream is withheld.
 * Invalid JSON gives null: nothing is repaired.
 */
export type PartialNode =
  | { kind: 'string'; text: string; complete: boolean }
  | { kind: 'object'; fields: Map<string, PartialNode>; complete: boolean }
  | { kind: 'array'; items: PartialNode[]; complete: boolean }
  | { kind: 'scalar'; value: null | boolean | number | undefined; complete: boolean };

export type PartialText = { text: string; complete: boolean };

/** Progress of a `{reply, deliverable}` answer. `deliverable.state` stays `absent` until its value has begun. */
export type ReplyProgress = {
  reply: PartialText | null;
  deliverable:
    | { state: 'absent' }
    | { state: 'null' }
    | { state: 'object'; title: PartialText | null; body: PartialText | null };
};

class Invalid extends Error {}
class End extends Error {}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const LITERALS: Record<string, null | boolean> = { null: null, true: true, false: false };

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function parsePartialJson(input: string): PartialNode | null {
  let i = 0;
  const ws = () => {
    while (i < input.length && (input[i] === ' ' || input[i] === '\n' || input[i] === '\r' || input[i] === '\t')) i += 1;
  };

  function string(): { text: string; complete: boolean } {
    i += 1;
    const parts: string[] = [];
    for (;;) {
      let j = i;
      while (j < input.length) {
        const code = input.charCodeAt(j);
        if (code === 0x22 || code === 0x5c) break;
        if (code < 0x20) throw new Invalid();
        j += 1;
      }
      parts.push(input.slice(i, j));
      i = j;
      if (i >= input.length) return { text: withheld(parts.join('')), complete: false };
      if (input[i] === '"') {
        i += 1;
        return { text: parts.join(''), complete: true };
      }
      const kind = input[i + 1];
      if (kind === undefined) return { text: withheld(parts.join('')), complete: false };
      if (kind === 'u') {
        const hex = input.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Invalid();
        if (hex.length < 4) return { text: withheld(parts.join('')), complete: false };
        parts.push(String.fromCharCode(parseInt(hex, 16)));
        i += 6;
        continue;
      }
      const escaped = ESCAPES[kind];
      if (escaped === undefined) throw new Invalid();
      parts.push(escaped);
      i += 2;
    }
  }

  function withheld(text: string): string {
    i = input.length;
    return text.length && isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text;
  }

  function value(depth = 0): PartialNode {
    if (depth > 32) throw new Invalid();
    ws();
    if (i >= input.length) throw new End();
    const c = input[i];
    if (c === '"') return { kind: 'string', ...string() };
    if (c === '{') return object(depth + 1);
    if (c === '[') return array(depth + 1);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      const match = /^-?(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?\d*)?/.exec(input.slice(i));
      const raw = match?.[0] ?? '';
      i += raw.length;
      if (i >= input.length) return { kind: 'scalar', value: undefined, complete: false };
      const number = Number(raw);
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(number)) throw new Invalid();
      return { kind: 'scalar', value: number, complete: true };
    }
    for (const [word, literal] of Object.entries(LITERALS)) {
      const available = input.slice(i, i + word.length);
      if (!word.startsWith(available)) continue;
      i += available.length;
      return { kind: 'scalar', value: available.length === word.length ? literal : undefined, complete: available.length === word.length };
    }
    throw new Invalid();
  }

  function object(depth: number): PartialNode {
    i += 1;
    const node = { kind: 'object' as const, fields: new Map<string, PartialNode>(), complete: false };
    ws();
    if (i >= input.length) return node;
    if (input[i] === '}') {
      i += 1;
      node.complete = true;
      return node;
    }
    for (;;) {
      ws();
      if (i >= input.length) return node;
      if (input[i] !== '"') throw new Invalid();
      const key = string();
      if (!key.complete) return node;
      ws();
      if (i >= input.length) return node;
      if (input[i] !== ':') throw new Invalid();
      i += 1;
      let child: PartialNode;
      try {
        child = value(depth);
      } catch (error) {
        if (error instanceof End) return node;
        throw error;
      }
      node.fields.set(key.text, child);
      if (!child.complete) return node;
      ws();
      if (i >= input.length) return node;
      if (input[i] === '}') {
        i += 1;
        node.complete = true;
        return node;
      }
      if (input[i] !== ',') throw new Invalid();
      i += 1;
    }
  }

  function array(depth: number): PartialNode {
    i += 1;
    const node: Extract<PartialNode, { kind: 'array' }> = { kind: 'array', items: [], complete: false };
    ws();
    if (i >= input.length) return node;
    if (input[i] === ']') {
      i += 1;
      node.complete = true;
      return node;
    }
    for (;;) {
      let child: PartialNode;
      try {
        child = value(depth);
      } catch (error) {
        if (error instanceof End) return node;
        throw error;
      }
      node.items.push(child);
      if (!child.complete) return node;
      ws();
      if (i >= input.length) return node;
      if (input[i] === ']') {
        i += 1;
        node.complete = true;
        return node;
      }
      if (input[i] !== ',') throw new Invalid();
      i += 1;
    }
  }

  try {
    const root = value();
    ws();
    if (i < input.length) return null;
    return root;
  } catch (error) {
    if (error instanceof End) return { kind: 'scalar', value: undefined, complete: false };
    if (error instanceof Invalid) return null;
    throw error;
  }
}

function text(node: PartialNode | undefined): PartialText | null {
  return node?.kind === 'string' ? { text: node.text, complete: node.complete } : null;
}

/** null when the received text is not the beginning of a JSON object. */
export function decodeReplyProgress(received: string): ReplyProgress | null {
  const root = parsePartialJson(received);
  if (!root) return null;
  if (root.kind === 'scalar' && root.value === undefined && !root.complete && received.trim() === '') {
    return { reply: null, deliverable: { state: 'absent' } };
  }
  if (root.kind !== 'object') return null;
  const deliverable = root.fields.get('deliverable');
  return {
    reply: text(root.fields.get('reply')),
    deliverable: deliverable === undefined ? { state: 'absent' }
      : deliverable.kind === 'object' ? { state: 'object', title: text(deliverable.fields.get('title')), body: text(deliverable.fields.get('body')) }
      : deliverable.kind === 'scalar' && deliverable.complete && deliverable.value === null ? { state: 'null' }
      : { state: 'absent' },
  };
}
