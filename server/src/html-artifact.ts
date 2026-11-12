/** HTML is an artifact when it is a document, or the only explicitly labelled HTML block. */
export function htmlDocument(content: string): string | null {
  const trimmed = content.trim();
  if (/^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*<\/html>$/i.test(trimmed)) return trimmed;
  const blocks = [...content.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*html?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/gi)];
  const body = blocks.length === 1 ? blocks[0]?.[2]?.trim() : null;
  return body || null;
}
