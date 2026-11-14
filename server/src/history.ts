import type { Exchange } from './context.js';
import type { ContextPlan } from './protocol.js';

type Coverage = Extract<ContextPlan, { policyVersion: 12 }>['history'];
type Component = { by: string; text: string };
type Entry = { index: number; components: Component[]; attachments: string[]; suffix: string[]; quota: number; kind: 'recent' | 'older' };
const points = (text: string) => Array.from(text).length;
const segmenter = new Intl.Segmenter('fr', { granularity: 'grapheme' });

function excerpt(text: string, quota: number): { text: string; omittedChars: number } {
  const length = points(text);
  if (length <= quota) return { text, omittedChars: 0 };
  let head = '';
  let tail = '';
  let used = 0;
  const segments = Array.from(segmenter.segment(text), part => part.segment);
  let start = 0;
  while (start < segments.length) {
    const part = segments[start];
    if (part === undefined || used + points(part) > Math.ceil(quota / 2)) break;
    head += part;
    used += points(part);
    start += 1;
  }
  let end = segments.length - 1;
  while (end >= start) {
    const part = segments[end];
    if (part === undefined || used + points(part) > quota) break;
    tail = part + tail;
    used += points(part);
    end -= 1;
  }
  const omittedChars = length - used;
  return { text: `${head}\n[… ${omittedChars} caractères omis …]\n${tail}`, omittedChars };
}

function render(entry: Entry) {
  const components = entry.components.map(component => {
    const cut = excerpt(component.text, entry.quota);
    return { by: component.by, sourceChars: points(component.text), ...cut };
  });
  const lines = components.map(c => `${c.by} : ${c.text}`);
  return { text: [lines[0] ?? '', ...entry.attachments, ...lines.slice(1), ...entry.suffix].join('\n'), components };
}

export function composeHistory(input: { exchanges: readonly Exchange[]; budgetChars: number; olderChars: number; deliverableIndex: number }) {
  const { exchanges, budgetChars, olderChars, deliverableIndex } = input;
  const entries: Entry[] = exchanges.map((exchange, index) => ({
    index, kind: index >= exchanges.length - 2 ? 'recent' : 'older', quota: Infinity,
    components: [{ by: exchange.request.trigger ? { routine: 'Routine', event: 'Événement', voice: 'Voix', checkin: 'Bilan' }[exchange.request.trigger] : 'Personne', text: exchange.request.text }, ...exchange.replies],
    attachments: exchange.request.attachments.map(file => `(fichier joint : ${file.name}, ${file.chars} caractères, non renvoyé)`),
    suffix: [
      ...(exchange.deliverable ? [index === deliverableIndex
        ? `[Livrable « ${exchange.deliverable.title} », version ${exchange.deliverable.n} : voir « Dernier livrable » plus bas]`
        : `[Livrable « ${exchange.deliverable.title} », version ${exchange.deliverable.n}, ${points(exchange.deliverable.body)} caractères, non inclus]`] : []),
    ],
  }));
  const textOf = (selected: Entry[]) => {
    if (!exchanges.length) return '';
    const omitted = exchanges.length - selected.length;
    return ['Échanges précédents du fil, du plus ancien au plus récent :',
      ...(omitted ? [`[${omitted} échange${omitted > 1 ? 's' : ''} non inclus]`] : []),
      ...selected.flatMap(entry => [render(entry).text, '']), ''].join('\n');
  };
  const fits = (selected: Entry[]) => points(textOf(selected)) <= budgetChars;
  let selected = entries.slice(-2);
  if (!fits(selected)) {
    selected = selected.map(entry => ({ ...entry, quota: 0 }));
    while (selected.length && !fits(selected)) selected.shift();
    let quota = 0;
    let upper = budgetChars;
    while (quota < upper) {
      const candidate = Math.ceil((quota + upper) / 2);
      const trial = selected.map(entry => ({ ...entry, quota: candidate }));
      if (fits(trial)) quota = candidate;
      else upper = candidate - 1;
    }
    selected = selected.map(entry => ({ ...entry, quota }));
  }
  for (let index = exchanges.length - 3; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) break;
    const trial = [{ ...entry, quota: olderChars }, ...selected];
    if (!fits(trial)) break;
    selected = trial;
  }
  const text = textOf(selected);
  const rendered = selected.map(entry => ({ entry, rendered: render(entry) }));
  const plan: Coverage = { budgetChars, usedChars: points(text), entries: rendered.map(({ entry, rendered }) => ({
    requestMessageId: exchanges[entry.index]?.request.messageId ?? null,
    kind: entry.kind,
    components: rendered.components.map(({ by, sourceChars, omittedChars }) => ({ by, sourceChars, omittedChars })),
  })) };
  const used: { historyMessageIds: string[]; replyAttemptIds: string[] } = { historyMessageIds: [], replyAttemptIds: [] };
  for (const entry of selected) {
    const exchange = exchanges[entry.index];
    if (!exchange) continue;
    if (exchange.request.messageId) used.historyMessageIds.push(exchange.request.messageId);
    for (const reply of exchange.replies) if (reply.attemptId) used.replyAttemptIds.push(reply.attemptId);
  }
  const full = plan.entries.filter(entry => entry.kind === 'recent' && entry.components.every(c => c.omittedChars === 0)).length;
  return { text, plan, used, counts: { full, brief: selected.length - full, omitted: exchanges.length - selected.length },
    clippedChars: plan.entries.reduce((sum, entry) => sum + entry.components.reduce((n, c) => n + c.omittedChars, 0), 0) };
}
