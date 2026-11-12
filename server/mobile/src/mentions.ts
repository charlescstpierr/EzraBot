import type { Draft } from "./controller";
import { rebase, inCode } from "./mention-spans";
export function editDraft(draft: Draft, text: string): Draft {
  return { text, mentions: rebase(draft.text, text, draft.mentions) };
}
export function insertMention(
  draft: Draft,
  bot: { id: string; name: string },
  cursor: number,
): Draft {
  if (inCode(draft.text, cursor)) return draft;
  const label = `@${bot.name}`;
  const before = draft.text.slice(0, cursor);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const insert = `${prefix}${label} `;
  const updated = editDraft(draft, before + insert + draft.text.slice(cursor));
  return {
    text: updated.text,
    mentions: [
      ...updated.mentions,
      {
        botId: bot.id,
        start: cursor + prefix.length,
        end: cursor + prefix.length + label.length,
      },
    ].sort((a, b) => a.start - b.start),
  };
}
