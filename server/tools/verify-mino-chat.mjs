import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browser, delay, until } from './lib/browser.mjs';

// Drives the real React Native web client against isolated HTTP routes and SQLite, with controlled model boundaries.
// Usage: node tools/verify-mino-chat.mjs <build-root> <screenshot-dir>
// Set MINO_VERIFY_CLIENT_DIR to an exported web client. This script never invokes a real model.
const build = resolve(process.argv[2] ?? '.');
const shots = resolve(process.argv[3] ?? join(build, 'shots'));
const clientDir = resolve(process.env.MINO_VERIFY_CLIENT_DIR ?? join(build, 'mobile/dist'));
mkdirSync(shots, { recursive: true });
const imp = path => import(join(build, 'dist/src', path));
const [{ openStore }, { openDevices }, { createBrowserAdmission }, { createHttpServer }, { createDeviceServer }, { createWorker }, { loadMascots }, { openMissions }, { createAgentEngine }, { createAgentWorker }, { createAgentRoutes }] = await Promise.all(
  ['store.js', 'devices.js', 'web-admission.js', 'http.js', 'device-http.js', 'worker.js', 'domain.js', 'missions.js', 'agent-engine.js', 'agent-worker.js', 'agent-http.js'].map(imp));

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const evidence = {
  checkedAt: new Date().toISOString(), engine: 'serveur d’exécutant factice (tests)', viewport: '390×844',
  physicalPhoneTested: false,
  server: Object.fromEntries(['agent-engine', 'agent-worker', 'agent-http', 'device-http', 'process-tree'].map(name => [name, hash(join(build, 'dist/src', `${name}.js`))])),
  clientIndexSha256: hash(join(clientDir, 'index.html')),
  pcClient: { bundleSha256: hash(join(build, 'dist/web/app.js')), stylesheetSha256: hash(join(build, 'web/mino.css')) },
  checks: [],
};
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mino-missions-ui-')));
const project = realpathSync(mkdtempSync(join(process.env.MINO_VERIFY_PROJECT_BASE ?? '/tmp', 'mino-ui-project-')));
writeFileSync(join(project, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(project, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
writeFileSync(join(project, 'sum.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.js';\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
execFileSync('git', ['init', '-q'], { cwd: project });
execFileSync('git', ['add', '.'], { cwd: project });
execFileSync('git', ['-c', 'user.email=v@mino.local', '-c', 'user.name=v', 'commit', '-qm', 'init'], { cwd: project });

const host = 'mino-verify.test';
const port = Number(process.env.MINO_VERIFY_TLS_PORT ?? 4485);
const adminPort = Number(process.env.MINO_VERIFY_ADMIN_PORT ?? 4484);
const base = `https://${host}:${port}`;
const admin = `http://127.0.0.1:${adminPort}`;
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });

const chatStatus = { state: 'ready', account: 'chatgpt', models: [{ id: 'controlled', displayName: 'Contrôlé', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
const chatEngine = () => ({ status: () => chatStatus, catalog: async () => chatStatus, close: async () => {}, onUsage: () => () => {}, run: async input => {
  const threadId = 'controlled-chat-thread', turnId = 'controlled-chat-turn';
  input.onThread(threadId); input.onTurn(turnId); input.onStage('writing');
  const departure = input.depart(); if (!departure.ok) return { kind: 'failed', code: 'admission_refused', message: departure.reason };
  return { kind: 'succeeded', reply: { reply: 'Je peux confier cette demande sur ton ordinateur.', deliverable: null, handoff: { goal: 'Ajoute une fonction slugify avec tests, puis documente-la dans le README.', coordinated: true, why: 'Des étapes peuvent être séparées.' } }, used: { model: 'controlled', effort: 'low', speed: 'standard' }, threadId, turnId };
}  });
const fixture = join(build, 'dist/test/fixtures/fake-agent-server.js');
const store = openStore({ path: join(dir, 'mino.sqlite'), mascots: loadMascots(join(build, 'assets/mascots.json')) });
const devices = openDevices({ path: join(dir, 'devices.sqlite'), spaceId: store.view().spaceId, publicUrl: base });
const admission = createBrowserAdmission(devices);
const worker = createWorker({ store, engines: { chat: chatEngine(), doc: chatEngine() } });
const missions = openMissions({ path: join(dir, 'missions.sqlite'), minoRoot: build, dataDir: dir, admission: store.admission });
const coordDir = join(dir, 'coord');
mkdirSync(coordDir);
const decision = fields => ({ kind: 'delegate', why: 'Étape séparable.', childId: null, title: null, goal: null, note: null, question: null, summary: null, limits: null, evidence: [], ...fields });
writeFileSync(join(coordDir, 'decisions.json'), JSON.stringify([
  decision({ title: 'Fonction slugify', goal: 'Ajoute slugify.js et son test.' }),
  decision({ title: 'README', goal: 'Documente slugify dans le README.' }),
  decision({ kind: 'finish', summary: 'Slugify ajoutée.', limits: 'Aucune.', evidence: [{ childId: '$child1', attemptId: '$cite1' }] }),
  decision({ kind: 'finish', why: 'Les deux étapes sont contrôlées.', summary: 'Slugify ajoutée avec son test, puis documentée dans le README.', limits: 'Les accents sont retirés ; les autres alphabets ne sont pas gérés.', evidence: [{ childId: '$child1', attemptId: '$cite1' }, { childId: '$child2', attemptId: '$cite2' }] }),
]));
// `coord@<dir>`: ordinary turns behave like `edit`; a lead turn answers the next scripted decision.
const agentEngine = createAgentEngine({ command: process.execPath, args: [fixture, `coord@${coordDir}`], tmpDir: join(dir, 'agent-tmp'), clientVersion: 'verify' });
const agentWorker = createAgentWorker({ missions, engine: agentEngine });
const agents = createAgentRoutes({ missions, worker: agentWorker, engine: agentEngine, longPollMs: 800,
  coordination: { bot: botId => store.leadCandidate(botId), origin: messageId => store.missionOrigin(messageId) } });
const csrf = randomBytes(32).toString('hex');
const local = createHttpServer({ store, devices, browserAdmission: admission, agents, worker, engine: chatEngine(), root: build, port: adminPort, csrfToken: csrf });
const tls = createDeviceServer({ store, devices, browserAdmission: admission, agents, worker, engine: chatEngine(), publicUrl: base, cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8'), browserClientDir: clientDir, longPollMs: 800 });
const post = async (path, body) => (await fetch(admin + path, { method: 'POST', headers: { origin: admin, 'content-type': 'application/json', 'x-mino-csrf': csrf }, body: JSON.stringify(body) })).json();

const check = text => { evidence.checks.push(text); process.stdout.write(`✓ ${text}\n`); };
async function cleanup() {
  for (const server of [tls, local]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await agentWorker.close(); await agentEngine.close(); await worker.close();
  missions.close(); store.close(); devices.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
let ui;
const text = t => ui.evaluate(`document.body.innerText.includes(${JSON.stringify(t)})`);
const settle = () => ui.evaluate("new Promise(r=>setTimeout(r,450))");
const press = async t => { await settle(); await clickNow(t); };
const clickNow = t => ui.click(`[...document.querySelectorAll('[role="button"],button,[role="radio"]')].find(e=>(e.getAttribute('aria-label')===${JSON.stringify(t)}||e.textContent.trim()===${JSON.stringify(t)})&&e.getClientRects().length)`);
try {
  for (const [server, p] of [[local, adminPort], [tls, port]]) await new Promise((ok, ko) => { server.once('error', ko); server.listen(p, '127.0.0.1', ok); });
  const added = await post('/api/agents/commands', { type: 'project.add', requestId: 'verify-inline-project', path: project, name: 'calcul', checkCommand: 'true' });
  assert.ok(added.ok, added.message);
  ui = await browser(join(dir, 'chrome'), { args: ['--ignore-certificate-errors', `--host-resolver-rules=MAP ${host} 127.0.0.1`] });
  await ui.rpc('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__minoSendGate = { active: false, requests: 0, release: null };
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const gate = window.__minoSendGate;
      if (gate.active && String(args[0]).includes('/m/agents/commands')) {
        gate.requests++;
        await new Promise(resolve => { gate.release = resolve; });
        return new Response(JSON.stringify({ ok: false, message: 'Précision refusée pour ce contrôle.' }), { headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(...args);
    };
  ` });
  await ui.rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await post('/api/devices/browser-window', {});
  await ui.navigate(`${base}/#connect`);
  const pending = await until(() => devices.list().find(d => d.state === 'pending'), Boolean, 'demande de connexion', 20000);
  await post('/api/devices/approve', { pairingId: pending.pairingId, deviceId: pending.id, confirmCode: pending.confirmCode });
  await until(() => ui.evaluate('!!document.querySelector("textarea[aria-label=Message]")'), Boolean, 'chat connecté', 25000);
  const prompt = () => ui.evaluate('document.querySelector("textarea[aria-label=Message]")?.value');
  const noModal = () => ui.evaluate('!document.querySelector("[aria-modal=true],dialog[open]")');
  const inlineButtons = () => ui.evaluate('[...document.querySelectorAll("[role=button]")].map(e=>e.getAttribute("aria-label"))');
  await settle(); await ui.screenshot(join(shots, '01-mino-chat.png'));
  const origin = 'Ajoute une fonction slugify avec tests, puis documente-la dans le README.';
  await ui.fill('[aria-label="Message"]', origin);
  await press('Envoyer');
  await until(() => text('Confier la mission'), Boolean, 'carte de création dans le fil');
  assert.equal(missions.view().missions.length, 0);
  assert.ok(await noModal());
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Ce qu’il faut faire"]')`), false, 'the optional settings start closed');
  await ui.fill('[aria-label="Message"]', 'BROUILLON MINO CONSERVÉ');
  const confirmedGoal = `${origin} Conserve les exports existants.`;
  await press('Ajuster la mission');
  await ui.fill('[aria-label="Ce qu’il faut faire"]', confirmedGoal);
  await press('Masquer les réglages');
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="Proposition de Mino"]')?.textContent.includes(${JSON.stringify(confirmedGoal)})`), 'the collapsed card visibly contains the edited goal');
  const shownGoal = () => ui.evaluate(`document.querySelector('[aria-label="Objectif à confier"]')?.textContent`);
  assert.equal(await shownGoal(), confirmedGoal, 'the collapsed card shows the goal that will be sent');
  await ui.reload();
  await until(() => text('Confier la mission'), Boolean, 'préparation restaurée');
  await until(shownGoal, value => value === confirmedGoal, 'objectif enregistré visible après rechargement');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Ce qu’il faut faire"]')`), false);
  assert.equal(missions.view().missions.length, 0, 'restoring the draft does not start a mission');
  await press('calcul');
  await settle(); await ui.screenshot(join(shots, '02-inline-prepare.png'));
  await press('Confier la mission');
  await until(() => text('Décision requise'), Boolean, 'mission coordonnée dans le fil', 20000);
  const root = missions.view().missions[0];
  assert.equal(root.mode, 'coordinated', 'Mino recommended a lead; the person did not have to pick one');
  assert.equal(root.lead.botId, store.view().bots.find(b => b.id !== 'mino').id);
  assert.equal(missions.detail(root.id).origin.text, origin);
  assert.equal(missions.detail(root.id).goals[0].text, confirmedGoal, 'the confirmed goal matches the visible preview');
  check('objectif modifié affiché intégralement après repli et rechargement, identique à celui enregistré à la confirmation');
  assert.ok(await noModal());
  assert.equal(await prompt(), 'BROUILLON MINO CONSERVÉ');
  assert.equal(await text('Nova · responsable'), false, 'only Mino narrates the main chat');
  assert.equal(await text('Travaux confiés'), false, 'executor sessions stay in details');
  await settle(); await ui.screenshot(join(shots, '03-mino-followup.png'));
  check('création coordonnée dans le chat sans modal, réglages repliés, responsable automatique et brouillon principal conservé');

  await ui.reload();
  await until(() => text('Suivre ici'), Boolean, 'liaison retrouvée après rechargement', 20000);
  assert.equal(await text('Confier la mission'), false, 'a linked proposal cannot create a second mission');
  assert.equal(await prompt(), 'BROUILLON MINO CONSERVÉ');
  assert.equal(missions.view().missions.length, 1);
  await press('Suivre ici');
  await until(() => text('Arrêter tout'), Boolean, 'contrôles retrouvés dans le fil');
  const inputValue = label => ui.evaluate(`document.querySelector('[aria-label="${label}"]')?.value`);
  await ui.fill('[aria-label="Précision à Mino pour la mission"]', 'PRÉCISION A NON ENVOYÉE');
  await press('Modifier l’objectif');
  await ui.fill('[aria-label="Nouvel objectif"]', 'OBJECTIF A EN ÉDITION');
  const attemptsBeforeDrafts = missions.detail(root.id).attempts.length;
  await press('Réduire le suivi');
  await press('Suivre ici');
  await until(() => inputValue('Précision à Mino pour la mission'), v => v !== undefined, 'suivi remonté');
  assert.equal(await inputValue('Précision à Mino pour la mission'), 'PRÉCISION A NON ENVOYÉE');
  assert.equal(await inputValue('Nouvel objectif'), 'OBJECTIF A EN ÉDITION');
  const peer = missions.dispatch({ type: 'mission.create', requestId: 'verify-followup-peer', projectId: added.id, goal: 'MISSION B POUR LES BROUILLONS', model: null, effort: null });
  assert.ok(peer.ok);
  const peerClaim = missions.claimNext(); assert.equal(peerClaim.missionId, peer.id);
  missions.bindThread(peerClaim, 'controlled-draft-peer', 'controlled', 'low'); missions.bindTurn(peerClaim, 'controlled-draft-peer-turn');
  missions.finish(peerClaim, { kind: 'completed', finalText: 'Enregistrement contrôlé pour vérifier les saisies, sans exécutant réel.', threadId: 'controlled-draft-peer', turnId: 'controlled-draft-peer-turn' });
  missions.verified(peerClaim, { end: 'done', observed: missions.detail(root.id).children[0] ? missions.detail(missions.detail(root.id).children[0].id).attempts[0].observed : null, check: { command: ['true'], exitCode: 0, output: 'fixture', error: null, at: new Date().toISOString() } });
  await until(() => text('MISSION B POUR LES BROUILLONS'), Boolean, 'seconde mission dans le chat');
  const followPeer = () => ui.click(`[...document.querySelectorAll('[aria-label="Mission suivie par Mino"]')].find(e=>e.textContent.includes('MISSION B POUR LES BROUILLONS'))?.querySelector('[aria-label="Suivre ici"]')`);
  const followA = () => ui.click(`document.querySelector('[aria-label="Proposition de Mino"] [aria-label="Suivre ici"]')`);
  await followPeer();
  await until(() => inputValue('Précision pour la suite'), v => v !== undefined, 'mission directe B développée');
  await ui.fill('[aria-label="Précision pour la suite"]', 'PRÉCISION B NON ENVOYÉE');
  await press('Modifier l’objectif'); await ui.fill('[aria-label="Nouvel objectif"]', 'OBJECTIF B EN ÉDITION');
  await followA();
  await until(() => inputValue('Précision à Mino pour la mission'), v => v !== undefined, 'retour à A');
  assert.equal(await inputValue('Précision à Mino pour la mission'), 'PRÉCISION A NON ENVOYÉE');
  assert.equal(await inputValue('Nouvel objectif'), 'OBJECTIF A EN ÉDITION');
  await followPeer();
  await until(() => inputValue('Précision pour la suite'), v => v !== undefined, 'retour à B');
  assert.equal(await inputValue('Précision pour la suite'), 'PRÉCISION B NON ENVOYÉE');
  assert.equal(await inputValue('Nouvel objectif'), 'OBJECTIF B EN ÉDITION');
  await press('Réduire le suivi'); await followPeer();
  await until(() => inputValue('Précision pour la suite'), v => v !== undefined, 'B repliée puis rouverte');
  assert.equal(await inputValue('Précision pour la suite'), 'PRÉCISION B NON ENVOYÉE');
  assert.equal(await inputValue('Nouvel objectif'), 'OBJECTIF B EN ÉDITION');
  await followA();
  await until(() => inputValue('Précision à Mino pour la mission'), v => v !== undefined, 'A restaurée avant la suite');
  assert.equal(missions.detail(root.id).attempts.length, attemptsBeforeDrafts);
  assert.equal(missions.detail(root.id).goals.length, 1);
  assert.equal(missions.detail(peer.id).goals.length, 1);
  await settle(); await ui.screenshot(join(shots, '10-followup-drafts.png'));
  await ui.evaluate('window.__minoSendGate.active = true');
  await press('Envoyer la précision à Mino');
  await until(() => ui.evaluate('window.__minoSendGate.requests'), n => n === 1, 'envoi suspendu avant réponse');
  await press('Réduire le suivi'); await press('Suivre ici');
  await until(() => inputValue('Précision à Mino pour la mission'), value => value !== undefined, 'suivi remonté pendant l’envoi');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Envoyer la précision à Mino"]')?.getAttribute('aria-disabled')`), 'true', 'an in-flight command stays disabled after remount');
  await press('Envoyer la précision à Mino');
  assert.equal(await ui.evaluate('window.__minoSendGate.requests'), 1, 'remounting and clicking cannot send a second command');
  await ui.evaluate('window.__minoSendGate.active = false; window.__minoSendGate.release()');
  await until(() => text('Précision refusée pour ce contrôle.'), Boolean, 'refus reçu après remontage');
  assert.equal(await inputValue('Précision à Mino pour la mission'), 'PRÉCISION A NON ENVOYÉE');
  assert.notEqual(await ui.evaluate(`document.querySelector('[aria-label="Envoyer la précision à Mino"]')?.getAttribute('aria-disabled')`), 'true');
  check('envoi unique pendant repli et remontage, puis refus visible et précision conservée');
  await press('Annuler');
  check('précisions et révisions conservées après repli et A→B→A, séparées par mission dans les deux modes, sans envoi automatique');
  await press('Détails de la mission');
  await until(() => text('Travaux confiés'), Boolean, 'détails seulement à la demande');
  await press('Étape 1, Fonction slugify, À examiner');
  await until(() => text('Confiée par'), Boolean, 'étape conservée');
  assert.equal((await inlineButtons()).includes('Valider ce résultat'), false, 'a child has no individual acceptance');
  await press('Fermer');
  assert.equal(await prompt(), 'BROUILLON MINO CONSERVÉ');
  assert.ok(await noModal());
  check('rechargement : origine durable, une seule mission, détails enfants facultatifs et aucune validation individuelle');

  const decisions = missions.detail(root.id).decisions.length;
  await ui.rpc('Network.enable');
  await ui.rpc('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await press('Reprendre avec Mino');
  await until(() => text('Le PC n’a pas répondu.'), Boolean, 'erreur réseau honnête dans le fil');
  assert.equal(missions.detail(root.id).decisions.length, decisions);
  await settle(); await ui.screenshot(join(shots, '04-inline-network-error.png'));
  await ui.rpc('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await press('Modifier l’objectif');
  await ui.fill('[aria-label="Nouvel objectif"]', 'x'.repeat(6001));
  await press('Enregistrer');
  await until(() => text('Cette commande est incomplète ou invalide.'), Boolean, 'refus serveur dans le chat');
  assert.equal(missions.detail(root.id).goals.length, 1);
  await press('Annuler');
  await press('Arrêter tout');
  await until(() => text('Arrêt confirmé.'), Boolean, 'arrêt dans le fil');
  assert.equal(missions.detail(root.id).status, 'stopped');
  assert.equal(await prompt(), 'BROUILLON MINO CONSERVÉ');
  check('échec réseau, refus serveur et arrêt visibles dans le fil, sans relance ni effacement du brouillon');

  await ui.fill('[aria-label="Précision à Mino pour la mission"]', 'Cite les deux étapes.');
  await press('Envoyer la précision à Mino');
  await until(() => text('Valider la synthèse'), Boolean, 'synthèse prête dans le chat', 20000);
  await until(() => text('PC injoignable'), value => !value, 'connexion du chat rétablie', 20000);
  await settle(); await ui.screenshot(join(shots, '05-inline-synthesis.png'));
  await press('Valider la synthèse');
  await until(() => text('Tu as validé la synthèse et les étapes citées.'), Boolean, 'validation dans le chat');
  assert.equal(missions.detail(root.id).status, 'accepted');
  check('précision à Mino, synthèse contrôlée et validation enregistrée sans quitter le chat');

  await ui.fill('[aria-label="Message"]', 'Une correction courte dans ce projet.');
  await press('Envoyer');
  await until(() => text('Confier la mission'), Boolean, 'deuxième proposition');
  await press('calcul');
  await press('Ajuster la mission');
  await press('Un exécutant');
  await ui.fill('[aria-label="Ce qu’il faut faire"]', 'Correction courte pour vérifier les résultats périmés.');
  await ui.fill('[aria-label="Message"]', 'BROUILLON APRÈS MODIFICATION');
  await press('Confier la mission');
  await until(() => text('Valider ce résultat'), Boolean, 'mission directe à examiner', 20000);
  const direct = missions.view().missions.find(m => m.mode === 'direct' && m.id !== peer.id);
  assert.ok(direct);
  await press('Modifier l’objectif');
  await ui.fill('[aria-label="Nouvel objectif"]', 'Nouvel objectif différent, à garder en attente.');
  await press('Enregistrer');
  await until(() => text('pas à la version 2'), Boolean, 'résultat périmé visible');
  assert.equal((await inlineButtons()).includes('Valider ce résultat'), false);
  assert.equal(missions.detail(direct.id).can.accept, null);
  assert.equal(await prompt(), 'BROUILLON APRÈS MODIFICATION');
  await settle(); await ui.screenshot(join(shots, '06-inline-outdated.png'));
  check('mode direct facultatif, modification d’objectif et ancienne preuve impossible à valider');

  await press('Conversations');
  await until(() => text('Nova'), Boolean, 'conversations conservées');
  await press('Ouvrir la conversation Nova');
  await until(() => text('Ce fil est conservé dans les détails.'), Boolean, 'conversation secondaire dans les détails');
  await press('Fermer');
  await press('Fermer');
  await until(noModal, Boolean, 'retour au chat après les détails');
  assert.equal(await prompt(), 'BROUILLON APRÈS MODIFICATION');
  const cached = await ui.evaluate(`(()=>{let count=0;for(const key of Object.keys(localStorage)){try{const value=JSON.parse(localStorage.getItem(key));if(value?.snapshot&&value.drafts){value.selected='nova';value.drafts.nova={text:'ANCIEN BROUILLON NOVA',mentions:[]};localStorage.setItem(key,JSON.stringify(value));count++;}}catch{}}return count})()`);
  assert.equal(cached, 1, 'seed an old cache that selected another bot');
  await ui.reload();
  await until(() => prompt(), v => v === 'BROUILLON APRÈS MODIFICATION', 'brouillon Mino après recharge', 20000);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Profil de Mino. Appui long pour voir les autres bots."]')?.innerText`), 'Mino');
  assert.equal(missions.view().missions.length, 3);
  assert.ok(await ui.evaluate(`Object.values(localStorage).some(raw=>raw.includes('ANCIEN BROUILLON NOVA'))`), 'the other bot draft is kept');
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await agentWorker.idle();
  const unknown = missions.dispatch({ type: 'mission.create', requestId: 'verify-unknown-inline', projectId: added.id, goal: 'MISSION AU RÉSULTAT INCONNU', model: null, effort: null });
  assert.ok(unknown.ok);
  const claim = missions.claimNext();
  assert.equal(claim.missionId, unknown.id);
  missions.finish(claim, { kind: 'interrupted', message: 'Fin du processus non confirmée.' });
  await until(() => text('MISSION AU RÉSULTAT INCONNU'), Boolean, 'mission sans proposition retrouvée dans le fil');
  await ui.click(`[...document.querySelectorAll('[aria-label="Mission suivie par Mino"]')].find(e=>e.textContent.includes('MISSION AU RÉSULTAT INCONNU'))?.querySelector('[aria-label="Suivre ici"]')`);
  await until(() => text('sans confirmation'), Boolean, 'résultat inconnu honnête');
  assert.equal(missions.detail(unknown.id).can.accept, null);
  assert.ok(await text('Reprendre après vérification'));
  assert.equal((await inlineButtons()).includes('Valider ce résultat'), false);
  assert.equal(await prompt(), 'BROUILLON APRÈS MODIFICATION');
  await settle(); await ui.screenshot(join(shots, '07-inline-unknown.png'));
  check('mission sans proposition suivie dans le chat et résultat inconnu conservé, reprise explicite seule');
  await ui.rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await settle(); await ui.screenshot(join(shots, '08-desktop-mino.png'));
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  check('autres conversations conservées en détails, retour à Mino, brouillon durable et aucun débordement mobile/ordinateur');
  const mino = store.view().bots.find(b => b.id === 'mino');
  const missionCountBeforeDeletion = missions.view().missions.length;
  const removed = await post('/api/commands', { type: 'bot.delete', requestId: 'verify-absent-mino', botId: 'mino', confirmName: mino.name, expected: mino.deletion });
  assert.ok(removed.ok, removed.message);
  await until(() => text('Mino n’est plus dans cet espace'), Boolean, 'absence de Mino explicite');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Profil de Mino. Appui long pour voir les autres bots."]')?.innerText`), 'Mino absent');
  assert.equal(store.view().bots.length, 3);
  assert.equal(missions.view().missions.length, missionCountBeforeDeletion, 'deleting Mino does not delete project missions');
  assert.equal(await text('Je suis cette mission'), false);
  await settle(); await ui.screenshot(join(shots, '09-mino-absent.png'));
  check('Mino supprimé : absence expliquée, aucune substitution par un autre bot et missions conservées');

} catch (error) {
  if (ui) {
    await ui.screenshot(join(shots, 'failure.png')).catch(() => {});
    process.stdout.write(String(await ui.evaluate('document.body.innerText').catch(() => '')).slice(-4000) + '\n');
  }
  throw error;
} finally {
  await ui?.close();
  await cleanup();
  writeFileSync(join(shots, 'cleanup.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, scratchRemoved: !existsSync(dir) && !existsSync(project) }) + '\n');
}
writeFileSync(join(shots, 'mino-chat-ui.json'), JSON.stringify(evidence, null, 2) + '\n');
await delay(10);
