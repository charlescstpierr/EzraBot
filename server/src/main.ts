import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMascots } from './domain.js';
import { createCodexEngine } from './engine.js';
import { createHttpServer } from './http.js';
import { openStore, StoreLockedError, type Store } from './store.js';
import { createWorker } from './worker.js';
import { openDevices, type Devices } from './devices.js';
import { createDeviceServer } from './device-http.js';
import { createBrowserAdmission, type BrowserAdmission } from './web-admission.js';
import { createAgentEngine } from './agent-engine.js';
import { createAgentRoutes } from './agent-http.js';
import { createAgentWorker } from './agent-worker.js';
import { MissionsLockedError, openMissions } from './missions.js';
import { buildMissionChatContext } from './mission-context.js';
import { takeProviderKey } from './child-env.js';
import { createComposioProvider, createComposioSdk } from './composio.js';
import { createActionDesk } from './tool-desk.js';

const VERSION = '0.1.0';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function fail(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(1);
}

/** Read before anything else runs, then gone from this process: no child and no later code can see it. */
const providerKey = takeProviderKey(process.env);
const port = Number(process.env.MINO_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('MINO_PORT doit être un numéro de port entre 1024 et 65535.');
const dataDir = resolve(process.env.MINO_DATA_DIR ?? join(root, 'data'));
const workDir = join(dataDir, 'codex-cwd');
mkdirSync(workDir, { recursive: true });

function open(): Store {
  try {
    return openStore({ path: join(dataDir, 'mino.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')), missionContext: () => buildMissionChatContext(missions), serviceTools: providerKey !== null });
  } catch (error) {
    if (error instanceof StoreLockedError) fail(error.message);
    throw error;
  }
}
const store = open();
if (store.view().erasure === 'incomplete') log({ event: 'erasure', state: 'incomplete' });
const recovered = store.recoverInterrupted();
if (recovered) log({ event: 'recovery', interruptedAttempts: recovered });

const engineOptions = { command: process.env.MINO_CODEX_BIN ?? 'codex', workDir, clientVersion: VERSION };
const missions = (() => {
  try {
    return openMissions({ path: join(dataDir, 'missions.sqlite'), minoRoot: root, dataDir });
  } catch (error) {
    if (error instanceof MissionsLockedError) fail(error.message);
    throw error;
  }
})();
const interruptedMissions = missions.recoverInterrupted();
if (interruptedMissions) log({ event: 'recovery', interruptedMissionAttempts: interruptedMissions });
const agentEngine = createAgentEngine({ command: engineOptions.command, tmpDir: join(dataDir, 'agent-tmp'), clientVersion: VERSION });
const agentWorker = createAgentWorker({ missions, engine: agentEngine, log, onFatal: () => fail('Le registre des missions a échoué. Mino est arrêté; redémarrez-le pour reprendre depuis les données enregistrées.') });
const agents = createAgentRoutes({ missions, worker: agentWorker, engine: agentEngine,
  coordination: { bot: botId => store.leadCandidate(botId), origin: messageId => store.missionOrigin(messageId) } });
// Only the chat engine can register service tools, and only when the provider is configured. Documents and missions never can.
const engine = createCodexEngine({ ...engineOptions, ...(providerKey ? { dynamicTools: true as const } : {}) });
const docEngine = createCodexEngine(engineOptions);
const desk = createActionDesk({
  store, port, log,
  provider: providerKey ? createComposioProvider({ sdk: createComposioSdk(providerKey), ownerId: store.tools.ownerId }) : null,
  wake: () => worker.kick(),
});
const worker = createWorker({ store, engines: { chat: engine, doc: docEngine }, tools: desk, log, onFatal: () => fail('Le stockage du travail a échoué. Mino est arrêté; redémarrez-le pour reprendre depuis les données enregistrées.') });
let devices: Devices | undefined;
let browserAdmission: BrowserAdmission | undefined;
let deviceServer: ReturnType<typeof createDeviceServer> | undefined;
const deviceUrl = process.env.MINO_DEVICE_URL;
if (deviceUrl) {
  const certPath = process.env.MINO_DEVICE_CERT;
  const keyPath = process.env.MINO_DEVICE_KEY;
  if (!certPath || !keyPath) fail('La connexion téléphone exige MINO_DEVICE_CERT et MINO_DEVICE_KEY, avec un certificat approuvé par le téléphone.');
  try {
    const url = new URL(deviceUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('MINO_DEVICE_URL doit contenir uniquement une origine HTTPS.');
    const devicePort = Number(url.port || 443);
    if (!Number.isInteger(devicePort) || devicePort < 1024 || devicePort > 65535 || devicePort === port) fail('Utilisez pour MINO_DEVICE_URL un port distinct entre 1024 et 65535.');
    devices = openDevices({ path: join(dataDir, 'devices.sqlite'), spaceId: store.view().spaceId, publicUrl: url.origin });
    const browserClientDir = process.env.MINO_BROWSER_CLIENT_DIR;
    if (browserClientDir) browserAdmission = createBrowserAdmission(devices);
    deviceServer = createDeviceServer({ store, worker, engine, devices, agents, publicUrl: url.origin, cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8'),
      ...(browserClientDir && browserAdmission ? { browserClientDir: resolve(browserClientDir), browserAdmission } : {}),
      allowedOrigins: (process.env.MINO_DEVICE_WEB_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean) });
    deviceServer.on('error', () => fail('La connexion téléphone n’a pas pu démarrer. Vérifiez le port et l’adresse réseau.'));
    deviceServer.listen(devicePort, process.env.MINO_DEVICE_BIND ?? '127.0.0.1', () => log({ event: 'devices-ready', url: url.origin }));
  } catch { fail('Configuration téléphone invalide. Vérifiez l’origine HTTPS, le certificat, sa clé et les dates de validité.'); }
}
const server = createHttpServer({
  store, worker, engine, port, root, log,
  ...(devices ? { devices } : {}),
  ...(browserAdmission ? { browserAdmission } : {}),
  agents,
  actions: desk,
  csrfToken: randomBytes(32).toString('hex'),
});

server.on('error', error => fail(`Le serveur n’a pas pu démarrer sur 127.0.0.1:${port} (${'code' in error ? String(error.code) : 'erreur'}).`));
server.listen(port, '127.0.0.1', () => {
  log({ event: 'ready', url: `http://127.0.0.1:${port}`, dataDir });
  void engine.catalog().then(status => log({ event: 'engine', state: status.state }));
  worker.kick();
  agentWorker.kick();
  desk.kick();
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close();
  deviceServer?.closeAllConnections();
  deviceServer?.close();
  await Promise.all([worker.close(), agentWorker.close(), desk.close()]);
  await Promise.all([engine.close(), docEngine.close(), agentEngine.close()]);
  const interrupted = store.recoverInterrupted();
  store.close();
  missions.close();
  devices?.close();
  log({ event: 'stopped', interruptedAttempts: interrupted });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
