import MarkdownIt from "markdown-it";
const parser = new MarkdownIt({ html: false, linkify: true, breaks: true });
export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: parser.render(text) }}
    />
  );
}
