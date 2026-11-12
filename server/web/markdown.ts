import MarkdownIt from 'markdown-it';

const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
md.validateLink = url => SAFE_LINK.test(url);

md.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index]?.content.trim();
  return md.utils.escapeHtml(alt ? `[image : ${alt}]` : '[image]');
};

md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  if (token) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer nofollow');
    token.attrSet('referrerpolicy', 'no-referrer');
  }
  return self.renderToken(tokens, index, options);
};

const codeBlock = (content: string, language: string) => {
  const label = language ? `<span class="code-lang">${md.utils.escapeHtml(language)}</span>` : '';
  return `<div class="code-block">${label}<button type="button" class="code-copy">Copier</button><pre><code>${md.utils.escapeHtml(content)}</code></pre></div>\n`;
};
md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  return token ? codeBlock(token.content, token.info.trim().split(/\s+/)[0] ?? '') : '';
};
md.renderer.rules.code_block = (tokens, index) => {
  const token = tokens[index];
  return token ? codeBlock(token.content, '') : '';
};

md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

export function renderMarkdownHtml(text: string): string {
  return md.render(text);
}
