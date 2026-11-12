import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

const types = new Map([
  ['js', 'text/javascript; charset=utf-8'], ['css', 'text/css; charset=utf-8'],
  ['ico', 'image/x-icon'], ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['avif', 'image/avif'], ['gif', 'image/gif'], ['svg', 'image/svg+xml'],
  ['ttf', 'font/ttf'], ['otf', 'font/otf'], ['woff', 'font/woff'], ['woff2', 'font/woff2'],
]);
const securityHeaders = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

export function createBrowserStatic(directory: string) {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('MINO_BROWSER_CLIENT_DIR doit être un dossier exporté sans lien symbolique.');
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const target = (req.url ?? '/').split('?')[0] ?? '/';
    if (!target.startsWith('/') || !/^\/[A-Za-z0-9_./@-]*$/.test(target) || target.includes('//')) return false;
    const parts = target.slice(1).split('/');
    if (parts.some(part => part === '.' || part === '..' || part.startsWith('.'))) return false;
    const file = target === '/' ? '/index.html' : target;
    const shell = file === '/index.html';
    const webScript = /^\/_expo\/static\/js\/web\/[A-Za-z0-9_-]+\.js$/.test(file);
    const asset = /^\/assets\/(?:[A-Za-z0-9_@-][A-Za-z0-9_@.-]*\/)*[A-Za-z0-9_@-][A-Za-z0-9_@.-]*$/.test(file);
    const extension = file.split('.').at(-1) ?? '';
    const type = shell ? 'text/html; charset=utf-8' : types.get(extension);
    if (!shell && file !== '/favicon.ico' && !webScript && !(asset && extension !== 'js')) return false;
    if (!type) return false;
    let path = root;
    try {
      if (realpathSync(root) !== root) return false;
      for (const part of file.slice(1).split('/')) {
        path = join(path, part);
        if (lstatSync(path).isSymbolicLink()) return false;
      }
      if (!lstatSync(path).isFile()) return false;
      const body = readFileSync(path);
      res.writeHead(200, { ...securityHeaders, 'content-type': type, 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      return false;
    }
  };
}
