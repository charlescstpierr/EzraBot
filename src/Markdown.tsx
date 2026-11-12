import { renderMarkdownHtml } from "../server/web/markdown";
export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLButtonElement>("button.code-copy");
        const code = button?.parentElement?.querySelector("pre code");
        if (!button || !code) return;
        if (!navigator.clipboard) {
          button.textContent = "Copie impossible";
          return;
        }
        void navigator.clipboard.writeText(code.textContent ?? "").then(
          () => {
            button.textContent = "Copié";
          },
          () => {
            button.textContent = "Copie impossible";
          },
        );
      }}
      dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(text) }}
    />
  );
}
