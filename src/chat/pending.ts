import { CommandSchema, type CommandOf } from "../../server/src/protocol";
import type { PromptContent } from "../../server/web/drafts";

const unsaved = new Map<string, string | null>();

/**
 * The two ways the composer sends a message. `message.say` lets the server route a document request to the document mode.
 * `message.send` without `document` keeps the message in the conversation, where a bot may propose a service action.
 * A saved send keeps its exact command: a retry never changes its kind.
 */
export type Sendable = CommandOf<"message.say"> | CommandOf<"message.send">;
export type SavedSend = { command: Sendable; raw: PromptContent };
export const isSendable = (
  command: ReturnType<typeof CommandSchema.parse>,
): command is Sendable =>
  command.type === "message.say" ||
  (command.type === "message.send" && command.document === undefined);
export function storageRead(key: string): string | null {
  try {
    if (unsaved.has(key)) return unsaved.get(key) ?? null;
    return localStorage.getItem(key);
  } catch {
    return unsaved.get(key) ?? null;
  }
}
export function storageWrite(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    unsaved.delete(key);
    return true;
  } catch {
    unsaved.set(key, value);
    return false;
  }
}
export function readPending(key: string, botId: string): SavedSend | null {
  try {
    const value: unknown = JSON.parse(storageRead(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const parsed = CommandSchema.safeParse(
      "command" in value ? value.command : value,
    );
    if (
      !parsed.success ||
      !isSendable(parsed.data) ||
      parsed.data.botId !== botId
    )
      return null;
    const command = parsed.data;
    let raw: PromptContent = {
      text: command.text,
      files: command.attachments,
      mentions: command.mentions ?? [],
    };
    if (
      "raw" in value &&
      value.raw &&
      typeof value.raw === "object" &&
      "text" in value.raw &&
      typeof value.raw.text === "string"
    ) {
      const text = value.raw.text;
      if (text.trim() === command.text) {
        const offset = text.length - text.trimStart().length;
        raw = {
          ...raw,
          text,
          mentions: (command.mentions ?? []).map((span) => ({
            ...span,
            start: span.start + offset,
            end: span.end + offset,
          })),
        };
      }
    }
    return { command, raw };
  } catch {
    return null;
  }
}
