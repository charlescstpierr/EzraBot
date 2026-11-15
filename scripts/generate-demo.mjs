import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
execFileSync('npm', ['run', 'build'], { cwd: root, env, stdio: 'inherit', timeout: 120_000 });
const { openStore } = await import('../server/dist/src/store.js');
const { loadMascots } = await import('../server/dist/src/domain.js');
const { createHttpServer } = await import('../server/dist/src/http.js');
const { openMissions } = await import('../server/dist/src/missions.js');
const { createAgentRoutes } = await import('../server/dist/src/agent-http.js');
const directory = await mkdtemp(join(tmpdir(), 'ezra-demo-'));
const width = 600, height = 375;
const frames = [];
let store, missions, server, browser;

// Frequent clear codes keep the LZW dictionary below the 10-bit threshold.
function encodeGif(images) {
  const word = (n) => Buffer.from([n & 255, n >> 8]);
  const palette = Buffer.from(Array.from({ length: 768 }, (_, i) => {
    const color = Math.floor(i / 3);
    return [Math.round((color >> 5) * 255 / 7), Math.round(((color >> 2) & 7) * 255 / 7), (color & 3) * 85][i % 3];
  }));
  const parts = [Buffer.from('GIF89a'), word(width), word(height), Buffer.from([247, 0, 0]), palette,
    Buffer.from([33, 255, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0])];
  for (const pixels of images) {
    parts.push(Buffer.from([33, 249, 4, 4, 180, 0, 0, 0, 44]), word(0), word(0), word(width), word(height), Buffer.from([0, 8]));
    const bytes = [];
    let bits = 0, count = 0;
    const code = (value) => {
      bits |= value << count;
      count += 9;
      while (count >= 8) {
        bytes.push(bits & 255);
        bits >>>= 8;
        count -= 8;
      }
    };
    for (let i = 0; i < pixels.length; i++) {
      if (i % 200 === 0) code(256);
      code(pixels[i]);
    }
    code(257);
    if (count) bytes.push(bits & 255);
    for (let i = 0; i < bytes.length; i += 255) {
      const block = bytes.slice(i, i + 255);
      parts.push(Buffer.from([block.length]), Buffer.from(block));
    }
    parts.push(Buffer.from([0]));
  }
  return Buffer.concat([...parts, Buffer.from([59])]);
}

try {
  const now = () => '2026-01-01T12:00:00.000Z';
  store = openStore({ path: join(directory, 'demo.sqlite'), now,
    mascots: loadMascots(resolve(root, 'server/assets/mascots.json')) });
  missions = openMissions({ path: join(directory, 'missions.sqlite'), now });
  const engine = { status: () => ({ state: 'unavailable', message: 'Démo hors ligne. Aucun appel IA.' }) };
  const worker = { kick() {}, sync() {} };
  const agents = createAgentRoutes({ missions, worker, engine });
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const handler = createHttpServer({ store, worker, engine, agents, root: resolve(root, 'server'), port, csrfToken: 'demo-offline' });
  server.on('request', (request, response) => handler.emit('request', request, response));
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ args: ['--disable-gpu'], env: { ...env, TMPDIR: directory } });
  const context = await browser.newContext({ viewport: { width: 1200, height: 750 },
    reducedMotion: 'reduce', locale: 'fr-CA', timezoneId: 'UTC', serviceWorkers: 'block' });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const scenes = [
    { heading: 'Salut, moi c’est Mino.', act: () => page.goto(origin) },
    { heading: 'Salut, moi c’est Mino.', act: () => page.getByRole('button', { name: 'Mettre mes idées au clair' }).click() },
    { heading: 'Tout commence par un dossier.', act: () => page.getByRole('button', { name: 'Projets', exact: true }).click() },
    { heading: 'Tout commence par un dossier.', act: () => page.getByRole('button', { name: 'Ajouter un dossier' }).first().click(), dialog: true },
    { heading: 'Un compagnon à votre image.', act: async () => {
      await page.getByRole('button', { name: 'Fermer', exact: true }).click();
      await page.getByRole('button', { name: 'Personnages', exact: true }).click();
    } },
  ];
  for (const scene of scenes) {
    await scene.act();
    await expect(page.getByRole('heading', { name: scene.heading, exact: true })).toBeVisible();
    if (scene.dialog) await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ animations: 'disabled' });
    const pixels = await page.evaluate(async ({ png, width, height }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      return Array.from({ length: width * height }, (_, i) =>
        (rgba[i * 4] & 224) | ((rgba[i * 4 + 1] & 224) >> 3) | (rgba[i * 4 + 2] >> 6));
    }, { png: png.toString('base64'), width, height });
    frames.push(pixels);
    console.log(`Capture : ${scene.heading}${scene.dialog ? ' (dialogue)' : ''}`);
  }
  expect(errors).toEqual([]);
  const gif = encodeGif(frames);
  if (gif.length >= 2_000_000) throw Error('Le GIF dépasse 2 Mo.');
  await writeFile(resolve(root, 'docs/demo.gif'), gif);
  console.log(`docs/demo.gif : ${frames.length} images, ${width}×${height}, ${gif.length} octets.`);
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  store?.close();
  missions?.close();
  await rm(directory, { recursive: true, force: true });
}
