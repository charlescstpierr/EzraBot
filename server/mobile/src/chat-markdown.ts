import MarkdownIt from 'markdown-it';

type Token = ReturnType<typeof markdown.parse>[number];
type TokenNode = { token: Token; children: TokenNode[] };

export type ChatInline =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'break' }
  | { kind: 'strong' | 'emphasis' | 'strike'; children: ChatInline[] }
  | { kind: 'link'; url: string; children: ChatInline[] }
  | { kind: 'image'; label: string; source: string };

export type ChatCell = {
  header: boolean;
  align: 'left' | 'center' | 'right';
  children: ChatInline[];
};

export type ChatBlock =
  | { kind: 'paragraph'; children: ChatInline[] }
  | { kind: 'heading'; level: number; children: ChatInline[] }
  | { kind: 'quote'; children: ChatBlock[] }
  | { kind: 'list'; start: number | null; items: ChatBlock[][] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'table'; rows: ChatCell[][] }
  | { kind: 'rule' };

const maxNesting = 20;
const markdown = new MarkdownIt({ html: false, linkify: false, maxNesting });

export function safeChatLink(value: string): string | null {
  if (/[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname ? value : null;
    }
    return url.protocol === 'mailto:' && url.pathname ? value : null;
  } catch {
    return null;
  }
}

function nestTokens(tokens: Token[]): TokenNode[] {
  let position = 0;
  function read(): TokenNode[] {
    const nodes: TokenNode[] = [];
    while (position < tokens.length) {
      const token = tokens[position++];
      if (token.nesting === -1) break;
      nodes.push({ token, children: token.nesting === 1 ? read() : [] });
    }
    return nodes;
  }
  return read();
}

function inlineNodes(nodes: TokenNode[]): ChatInline[] {
  return nodes.flatMap((node): ChatInline[] => {
    const { token, children } = node;
    switch (token.type) {
      case 'strong_open': return [{ kind: 'strong', children: inlineNodes(children) }];
      case 'em_open': return [{ kind: 'emphasis', children: inlineNodes(children) }];
      case 's_open': return [{ kind: 'strike', children: inlineNodes(children) }];
      case 'code_inline': return [{ kind: 'code', text: token.content }];
      case 'softbreak':
      case 'hardbreak': return [{ kind: 'break' }];
      case 'link_open': {
        const content = inlineNodes(children);
        const destination = String(token.attrGet('href') ?? '');
        const url = safeChatLink(destination);
        return url ? [{ kind: 'link', url, children: content }]
          : [...content, { kind: 'text', text: destination ? ` (${destination})` : '' }];
      }
      case 'image': return [{
        kind: 'image', label: token.content, source: String(token.attrGet('src') ?? ''),
      }];
      default: return token.content ? [{ kind: 'text', text: token.content }] : inlineNodes(children);
    }
  });
}

function contentOf(nodes: TokenNode[]): ChatInline[] {
  return nodes.flatMap(({ token, children }) => token.type === 'inline'
    ? inlineNodes(nestTokens(token.children ?? []))
    : contentOf(children));
}

function tableRows(nodes: TokenNode[]): ChatCell[][] {
  return nodes.flatMap(({ token, children }): ChatCell[][] => {
    if (token.type !== 'tr_open') return tableRows(children);
    return [children.map((cell): ChatCell => {
      const style = cell.token.attrGet('style');
      return {
        header: cell.token.type === 'th_open',
        align: style === 'text-align:center' ? 'center' : style === 'text-align:right' ? 'right' : 'left',
        children: contentOf(cell.children),
      };
    })];
  });
}

function blockNodes(nodes: TokenNode[]): ChatBlock[] {
  return nodes.flatMap(({ token, children }): ChatBlock[] => {
    switch (token.type) {
      case 'paragraph_open': return [{ kind: 'paragraph', children: contentOf(children) }];
      case 'heading_open': return [{ kind: 'heading', level: Number(token.tag.slice(1)), children: contentOf(children) }];
      case 'blockquote_open': return [{ kind: 'quote', children: blockNodes(children) }];
      case 'bullet_list_open':
      case 'ordered_list_open': return [{
        kind: 'list',
        start: token.type === 'ordered_list_open' ? Number(token.attrGet('start') ?? '1') : null,
        items: children.map((item) => blockNodes(item.children)),
      }];
      case 'fence':
      case 'code_block': return [{ kind: 'code', language: token.info.trim(), text: token.content }];
      case 'table_open': return [{ kind: 'table', rows: tableRows(children) }];
      case 'hr': return [{ kind: 'rule' }];
      case 'inline': return [{ kind: 'paragraph', children: inlineNodes(nestTokens(token.children ?? [])) }];
      default: return children.length ? blockNodes(children)
        : token.content ? [{ kind: 'paragraph', children: [{ kind: 'text', text: token.content }] }] : [];
    }
  });
}

export function parseChatMarkdown(text: string): ChatBlock[] {
  const tokens = markdown.parse(text, {});
  if (tokens.some((token) => token.nesting === 1 && token.level >= maxNesting - 1)) {
    return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }];
  }
  return blockNodes(nestTokens(tokens));
}
