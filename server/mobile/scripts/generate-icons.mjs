import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
const root = new URL('../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('src/generated/mascots.json', root), 'utf8'));
const mascot = catalog.shapes.find(s => s.id === 'sprout');
if (!mascot) throw new Error('Mino mascot missing');
const body = mascot.xml.replace(/^<svg[^>]*>|<\/svg>$/g, '').replace(/var\(--bot-color,[^)]+\)/g, mascot.defaultColor);
for (const name of ['icon', 'splash-icon', 'android-icon-foreground', 'android-icon-monochrome', 'favicon']) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${name === 'android-icon-foreground' ? '' : '<rect width="1024" height="1024" fill="white"/>'}<g transform="translate(172 200) scale(6.8)">${body}</g></svg>`;
  writeFileSync(new URL(`assets/${name}.png`, root), new Resvg(svg).render().asPng());
}
writeFileSync(new URL('assets/android-icon-background.png', root), new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="white"/></svg>').render().asPng());
