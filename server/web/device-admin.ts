import QRCode from 'qrcode';
import { z } from 'zod';
import { PairGrantSchema } from '../src/mobile-protocol.js';

const listSchema = z.object({ url: z.url(), browserEnabled: z.boolean(), browserWindowExpiresAt: z.string().nullable(), devices: z.array(z.object({ id: z.string(), name: z.string(), pairingId: z.string(), confirmCode: z.string(), state: z.string(), expiresAt: z.string() })) });
const error = document.getElementById('error');
const host = document.getElementById('devices');
const create = document.getElementById('create');
const browserWindow = document.getElementById('browser-window');
let browserUrl = '';
let qrExpires = 0;
let devicesJson = '';
const token = document.querySelector<HTMLMetaElement>('meta[name=mino-csrf]')?.content ?? '';
let expires = 0;
function report(value: unknown): void { if (error) error.textContent = value instanceof Error ? value.message : 'La demande a échoué.'; }
async function request(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-mino-csrf': token }, body: JSON.stringify(body) });
  const data: unknown = await res.json();
  if (!res.ok) { const parsed = z.object({ message: z.string() }).safeParse(data); throw new Error(parsed.success ? parsed.data.message : 'Connexion indisponible.'); }
  return data;
}
async function refresh(): Promise<void> {
  const value = listSchema.parse(await request('/api/devices'));
  browserUrl = value.url;
  if (qrExpires && !value.browserWindowExpiresAt) {
    document.getElementById('browser-qr')?.replaceChildren();
    document.getElementById('scan-url')?.removeAttribute('href');
    const label = document.getElementById('scan-expiry');
    if (label) label.textContent = 'QR utilisé. Confirme le téléphone ci-dessous.';
    qrExpires = 0;
  }
  const link = document.getElementById('browser-url');
  if (link instanceof HTMLAnchorElement) { link.href = value.url; link.textContent = value.url; }
  if (browserWindow instanceof HTMLButtonElement) browserWindow.disabled = !value.browserEnabled;
  const browserHint = document.getElementById('browser-hint');
  if (browserHint) browserHint.textContent = !value.browserEnabled ? 'La connexion téléphone n’est pas configurée.' : qrExpires > Date.now() ? 'Scanne avec l’appareil photo de ton téléphone. Garde Tailscale connecté.' : 'Clique pour afficher le QR de connexion.';
  const nextJson = JSON.stringify(value.devices);
  if (nextJson === devicesJson) return;
  devicesJson = nextJson;
  const fragment = document.createDocumentFragment();
  for (const device of value.devices) {
    const card = document.createElement('section'); card.className = 'device';
    const name = document.createElement('strong'); name.textContent = device.name; card.append(name);
    const state = document.createElement('p'); state.textContent = device.state === 'active' ? 'Associé' : device.state === 'pending' ? 'À confirmer sur cet ordinateur' : 'Accès retiré ou expiré'; card.append(state);
    if (device.state === 'pending') {
      const code = document.createElement('p'); code.className = 'code'; code.textContent = device.confirmCode; card.append(code);
      const instruction = document.createElement('p'); instruction.textContent = 'Le même code apparaît sur ton téléphone ?'; card.append(instruction);
      const button = document.createElement('button'); button.textContent = 'Connecter ce téléphone';
      button.onclick = () => { button.disabled = true; void request('/api/devices/approve', { pairingId: device.pairingId, deviceId: device.id, confirmCode: device.confirmCode }).then(refresh).catch(report).finally(() => { button.disabled = false; }); }; card.append(button);
    }
    if (device.state === 'pending' || device.state === 'active') {
      const button = document.createElement('button'); button.textContent = 'Retirer cet appareil'; button.style.marginLeft = '12px';
      button.onclick = () => { button.disabled = true; void request('/api/devices/revoke', { deviceId: device.id }).then(refresh).catch(report).finally(() => { button.disabled = false; }); }; card.append(button);
    }
    fragment.append(card);
  }
  host?.replaceChildren(fragment);
}
if (browserWindow instanceof HTMLButtonElement) browserWindow.onclick = () => {
  browserWindow.disabled = true;
  void request('/api/devices/browser-window', {}).then(async value => {
    const opened = z.object({ expiresAt: z.string() }).parse(value);
    qrExpires = Date.parse(opened.expiresAt);
    const url = new URL(browserUrl); url.searchParams.set('launch', Date.now().toString(36)); url.hash = 'connect';
    const qr = document.getElementById('browser-qr');
    if (qr) qr.innerHTML = await QRCode.toString(url.toString(), { type: 'svg', margin: 4, width: 320 });
    const link = document.getElementById('scan-url');
    if (link instanceof HTMLAnchorElement) { link.href = url.toString(); link.textContent = 'Ouvrir sur le téléphone'; }
    const section = document.getElementById('browser-qr-card'); if (section) section.hidden = false;
    if (error) error.textContent = '';
    await refresh();
  }).catch(report).finally(() => { browserWindow.disabled = false; });
};
if (create instanceof HTMLButtonElement) create.onclick = () => {
  create.disabled = true;
  void request('/api/devices/pairings', {}).then(async value => {
    const grant = PairGrantSchema.parse(value);
    expires = Date.parse(grant.expiresAt);
    const text = JSON.stringify(grant);
    const qr = document.getElementById('qr'); if (qr) qr.innerHTML = await QRCode.toString(text, { type: 'svg', margin: 1, width: 240 });
    const textarea = document.getElementById('grant-json'); if (textarea instanceof HTMLTextAreaElement) textarea.value = text;
    const section = document.getElementById('grant'); if (section) section.hidden = false;
    if (error) error.textContent = '';
  }).catch(report).finally(() => { create.disabled = false; });
};
setInterval(() => {
  if (qrExpires && qrExpires <= Date.now()) {
    document.getElementById('browser-qr')?.replaceChildren();
    const label = document.getElementById('scan-expiry'); if (label) label.textContent = 'QR expiré. Clique sur Afficher le QR pour le renouveler.';
    const link = document.getElementById('scan-url'); if (link instanceof HTMLAnchorElement) link.removeAttribute('href');
    qrExpires = 0;
  } else if (qrExpires) {
    const label = document.getElementById('scan-expiry'); if (label) label.textContent = `Valable encore ${Math.ceil((qrExpires - Date.now()) / 1000)} s`;
  }
  const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  const label = document.getElementById('expired'); if (label && expires) label.textContent = remaining ? `Code privé · expire dans ${remaining} s` : 'Code expiré. Crée une nouvelle association.';
  if (!remaining && expires) { const field = document.getElementById('grant-json'); if (field instanceof HTMLTextAreaElement) field.value = ''; document.getElementById('qr')?.replaceChildren(); }
  if (!document.hidden) void refresh().catch(report);
}, 2000);
void refresh().catch(report);
