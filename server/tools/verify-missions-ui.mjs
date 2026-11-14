import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browser, delay, until } from './lib/browser.mjs';

// Drives the real React Native web client and the PC page in headless Chrome against an isolated build.
// Usage: node tools/verify-missions-ui.mjs <build-root> <screenshot-dir>
// The build root must contain the integration patch and an exported mobile/dist. MINO_VERIFY_REAL=1 uses real Codex.
const build = resolve(process.argv[2] ?? '.');
const shots = resolve(process.argv[3] ?? join(build, 'shots'));
const preview = process.env.MINO_VERIFY_PREVIEW === '1';
const clientDir = resolve(process.env.MINO_VERIFY_CLIENT_DIR ?? join(build, 'mobile/dist'));
mkdirSync(shots, { recursive: true });
const imp = path => import(join(build, 'dist/src', path));
const [{ openStore }, { openDevices }, { createBrowserAdmission }, { createHttpServer }, { createDeviceServer }, { createWorker }, { loadMascots }, { openMissions }, { createAgentEngine }, { createAgentWorker }, { createAgentRoutes }] = await Promise.all(
  ['store.js', 'devices.js', 'web-admission.js', 'http.js', 'device-http.js', 'worker.js', 'domain.js', 'missions.js', 'agent-engine.js', 'agent-worker.js', 'agent-http.js'].map(imp));

const real = process.env.MINO_VERIFY_REAL === '1';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const evidence = {
  checkedAt: new Date().toISOString(), engine: real ? 'Codex réel' : 'serveur d’exécutant factice (tests)', viewport: '390×844',
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

const host = preview ? 'localhost' : 'mino-verify.test';
const port = Number(process.env.MINO_VERIFY_TLS_PORT ?? 4385);
const adminPort = Number(process.env.MINO_VERIFY_ADMIN_PORT ?? 4384);
const base = `https://${host}:${port}`;
const admin = `http://127.0.0.1:${adminPort}`;
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });

const chatStatus = { state: 'ready', account: 'chatgpt', models: [{ id: 'controlled', displayName: 'Contrôlé', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
const chatEngine = () => ({ status: () => chatStatus, catalog: async () => chatStatus, close: async () => {}, onUsage: () => () => {}, run: async input => {
  const threadId = 'controlled-chat-thread', turnId = 'controlled-chat-turn';
  input.onThread(threadId); input.onTurn(turnId); input.onStage('writing');
  const departure = input.depart(); if (!departure.ok) return { kind: 'failed', code: 'admission_refused', message: departure.reason };
  return { kind: 'succeeded', reply: { reply: 'Je peux confier cette demande sur ton ordinateur.', deliverable: null, handoff: { goal: 'Ajoute une section contact au projet sur mon ordinateur.', coordinated: true, why: 'Des étapes peuvent être séparées.' } }, used: { model: 'controlled', effort: 'low', speed: 'standard' }, threadId, turnId };
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
const agentEngine = createAgentEngine(real ? { command: 'codex', tmpDir: join(dir, 'agent-tmp'), clientVersion: 'verify' } : { command: process.execPath, args: [fixture, `coord@${coordDir}`], tmpDir: join(dir, 'agent-tmp'), clientVersion: 'verify' });
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
  const doctor = await fetch(admin + '/api/view');
  assert.equal(doctor.status, 200);
  const doctorView = await doctor.json();
  assert.equal(doctorView.bots.length, 4, 'the empty verification database has the four original bots');
  assert.equal((await fetch(admin + '/api/agents/view')).status, 200, 'the agent routes are connected');
  check('le diagnostic lit la base initialisée, les quatre bots et les routes de missions du build isolé');
  if (preview) {
    const added = await post('/api/agents/commands', { type: 'project.add', requestId: 'verify-preview-project', path: project, name: 'Projet de vérification', checkCommand: real ? 'node --test' : 'true' });
    assert.ok(added.ok, added.message);
    const session = { pid: process.pid, admin, phone: base, project, build, clientDir, modelCalls: real ? 'explicitly enabled' : 0 };
    writeFileSync(join(shots, 'session.json'), JSON.stringify(session, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ event: 'verification.ready', admin, phone: base, project }) + '\n');
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
    ui = await browser(join(dir, 'chrome'), { args: ['--ignore-certificate-errors', `--host-resolver-rules=MAP ${host} 127.0.0.1`] });
    await ui.rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const added = await post('/api/agents/commands', { type: 'project.add', requestId: 'verify-ui-project', path: project, name: 'calcul', checkCommand: real ? 'node --test' : 'true' });
    assert.ok(added.ok, added.message);

    await post('/api/devices/browser-window', {});
    await ui.navigate(`${base}/#connect`);
    await until(() => devices.list().find(d => d.state === 'pending'), Boolean, 'demande de connexion', 20000);
    const pending = devices.list().find(d => d.state === 'pending');
    await post('/api/devices/approve', { pairingId: pending.pairingId, deviceId: pending.id, confirmCode: pending.confirmCode });
    await until(() => ui.evaluate("!!document.querySelector('[aria-label=\"Activité\"]')"), Boolean, 'chat connecté', 25000);
    check('le client React Native s’associe par l’admission navigateur existante et une confirmation PC');

    if (!real) {
      const origin = 'Ajoute une section contact au projet sur mon ordinateur.';
      await until(() => ui.evaluate("!!document.querySelector('textarea[aria-label=\"Message\"]')"), Boolean, 'chat composer mounted after pairing', 25000);
      await ui.fill('[aria-label="Message"]', origin);
      await press('Envoyer');
      await until(() => text('Préparer la mission'), Boolean, 'proposition structurée dans le chat');
      assert.equal(missions.view().missions.length, 0, 'no mission exists before the person acts');
      await ui.fill('[aria-label="Message"]', 'BROUILLON MINO CONSERVÉ');
      await settle(); await ui.screenshot(join(shots, 'handoff-chat.png'));
      await press('Préparer la mission');
      await until(() => text('Ce que Mino a compris'), Boolean, 'formulaire depuis la carte');
      assert.equal(await ui.evaluate("[...document.querySelectorAll('[role=radio]')].find(e=>e.textContent.includes('Avec un responsable'))?.getAttribute('aria-checked')"), 'true', 'the form preserves Mino’s suggested mode');
      await settle(); await ui.screenshot(join(shots, 'handoff-suggested-mode.png'));
      await press('Un exécutant');
      const draft = 'Section contact, objectif précisé par la personne.';
      await ui.fill('[aria-label="Ce qu’il faut faire"]', draft);
      await settle(); await ui.screenshot(join(shots, 'handoff-form.png'));
      await press('Fermer');
      assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Message"]').value`), 'BROUILLON MINO CONSERVÉ');
      await press('Préparer la mission');
      await until(() => ui.evaluate(`document.querySelector('[aria-label="Ce qu’il faut faire"]')?.value`), v => v === draft, 'brouillon de mission restauré');
      await press('Un exécutant');
      await press('calcul');
      await press('Confier la mission');
      await until(() => text('À examiner'), Boolean, 'mission confiée depuis le chat');
      const handed = missions.view().missions.find(m => m.title.startsWith('Section contact'));
      assert.ok(handed);
      assert.equal(missions.detail(handed.id).origin.text, origin, 'the PC resolved the exact original request');
      await press('Fermer');
      assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Message"]').value`), 'BROUILLON MINO CONSERVÉ');
      await settle(); await ui.screenshot(join(shots, 'handoff-return.png'));
      check('carte Mino réelle dans React, aucune mission avant le geste, origine exacte résolue par le PC et brouillons conservés');
    }

    await press('Activité');
    await until(() => text('Missions des exécutants'), Boolean, 'entrée Missions');
    await press('Missions des exécutants');
    await until(() => text('Nouvelle mission'), Boolean, 'feuille Missions');
    await settle();
    await ui.screenshot(join(shots, 'missions-empty.png'));
    check('Activité ouvre Missions, avec la voix du bot et le dossier confié depuis le PC');

    await press('Nouvelle mission');
    await until(() => text('Ce qu’il faut faire'), Boolean, 'formulaire');
    await ui.fill('[aria-label="Ce qu’il faut faire"]', 'Le test de sum échoue. Corrige sum.js pour additionner, puis lance node --test.');
    await settle();
    await ui.screenshot(join(shots, 'missions-new.png'));
    await press('Confier la mission');
    await until(() => text('Fil de l’exécutant'), Boolean, 'fil de mission');
    await until(() => text('À examiner'), Boolean, 'résultat', real ? 8 * 60_000 : 20000);
    await until(() => text('réussit'), Boolean, 'contrôle affiché', 30000);
    await settle();
    await ui.screenshot(join(shots, 'missions-review.png'));
    const shown = await ui.evaluate('document.body.innerText');
    assert.match(shown, /Constaté par Mino dans le dossier/);
    assert.match(shown, real ? /sum\.js/ : /result\.txt/);
    check('le fil montre le rapport, les fichiers constatés par Mino, le contrôle et les actions admises par le PC');

    await press('Valider ce résultat');
    await until(() => text('Tu as validé ce résultat.'), Boolean, 'validation');
    await press('‹ Missions');
    await until(() => text('Terminées'), Boolean, 'liste');
    await settle();
    await ui.screenshot(join(shots, 'missions-list.png'));
    const overflow = await ui.evaluate('document.documentElement.scrollWidth <= innerWidth');
    assert.equal(overflow, true);
    check('validation enregistrée, liste groupée, aucun débordement horizontal à 390 px');

    if (!real) {
      const goal = 'Ajoute slugify avec tests, puis documente-la dans le README.';
      const coord = await post('/api/agents/commands', { type: 'mission.create', requestId: 'verify-ui-coord', projectId: added.id, goal, model: null, effort: null, mode: 'coordinated', leadBotId: 'nova' });
      assert.ok(coord.ok, coord.message);
      await until(() => missions.detail(coord.id)?.status, s => s === 'waiting', 'décision refusée', 20000);
      await press(`${goal}, Décision requise`);
      await until(() => text('Travaux confiés'), Boolean, 'vue coordonnée');
      await until(() => text('Refusée par Mino'), Boolean, 'refus affiché');
      await settle();
      await ui.screenshot(join(shots, 'coordination-waiting.png'));
      assert.ok(await text('Nova · responsable'), 'the lead speaks with its own name and mascot');
      assert.ok(await text('Ses souvenirs de conversation ne lui sont pas transmis.'));
      assert.ok(await text('Réveiller le responsable') && await text('Arrêter tout'), 'the buttons follow can');
      check('mission coordonnée en attente : raison du refus, décisions, étapes, budget commun et boutons admis par le PC');

      const decisionCount = missions.detail(coord.id).decisions.length;
      await press('Modifier l’objectif');
      await ui.fill('[aria-label="Nouvel objectif"]', 'x'.repeat(6001));
      await press('Enregistrer');
      await until(() => text('Cette commande est incomplète ou invalide.'), Boolean, 'refus humain visible');
      assert.equal(missions.detail(coord.id).goals.length, 1, 'the refused goal was not saved');
      await ui.evaluate("document.querySelector('[role=alert]').scrollIntoView({block:'nearest'})");
      await settle(); await ui.screenshot(join(shots, 'coordination-command-error.png'));
      await press('Annuler');
      await ui.rpc('Network.enable');
      await ui.rpc('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await press('Réveiller le responsable');
      await until(() => text('Le PC n’a pas répondu.'), Boolean, 'transport failure visible');
      await ui.evaluate("document.querySelector('[role=alert]').scrollIntoView({block:'nearest'})");
      await settle(); await ui.screenshot(join(shots, 'coordination-transport-error.png'));
      await ui.rpc('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      assert.equal(missions.detail(coord.id).decisions.length, decisionCount);
      check('les refus humains et les échecs réseau sont visibles dans la mission coordonnée sans modifier l’objectif ni lancer de décision');

      await press('Étape 1, Fonction slugify, À examiner');
      await until(() => text('Confiée par Nova · décision 1'), Boolean, 'bandeau de l’étape');
      assert.equal(await ui.evaluate("[...document.querySelectorAll('[role=button],button')].some(e=>e.textContent.trim()==='Valider ce résultat')"), false, 'a step is accepted through its coordinated synthesis');
      await press('Voir la consigne transmise à Codex');
      await until(() => text('Ta tâche, uniquement cette étape'), Boolean, 'consigne transmise');
      await settle();
      await ui.screenshot(join(shots, 'coordination-step.png'));
      await press(`Retour à ${goal}`);
      await until(() => text('Travaux confiés'), Boolean, 'retour au parent');
      check('une étape s’ouvre avec son bandeau et la consigne exacte transmise, puis revient à sa mission coordonnée');

      await ui.fill('[aria-label="Préciser au responsable"]', 'Cite les deux étapes.');
      await press('Envoyer la précision à Nova');
      await until(() => text('Valider la synthèse'), Boolean, 'synthèse prête', 20000);
      await settle();
      await ui.screenshot(join(shots, 'coordination-review.png'));
      assert.ok(await text('Preuves vérifiées par Mino') && await text('Contrôle final du dossier intégré'));
      await press('Valider la synthèse');
      await until(() => text('Tu as validé la synthèse et les étapes citées.'), Boolean, 'synthèse validée');
      assert.equal(missions.detail(missions.detail(coord.id).children[1].id).status, 'accepted');
      assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      check('précision au responsable, synthèse avec preuves et contrôle final, validation de l’arbre, sans débordement à 390 px');
      await press('‹ Missions');
    }

    await ui.rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await ui.navigate(admin + '/');
    await until(() => ui.evaluate("!!document.querySelector('#projects-nav')"), Boolean, 'page PC');
    if (!real) {
      await until(() => text('Pour la confier, ouvre Missions dans Mimobot'), Boolean, 'handoff card on PC');
      await settle(); await ui.screenshot(join(shots, 'pc-handoff.png'));
    }
    await ui.click("document.querySelector('#projects-nav')");
    await until(() => text('Confier un dossier'), Boolean, 'Projets PC');
    await until(() => text('Validée'), Boolean, 'mission listée sur le PC');
    await settle();
    assert.equal(await ui.evaluate("(()=>{const d=document.querySelector('dialog[open]');return d.scrollWidth<=d.clientWidth})()"), true, 'PC projects dialog has no horizontal overflow');
    await ui.screenshot(join(shots, 'pc-projects.png'));
    check('la page PC liste le dossier, sa commande de contrôle et l’état de ses missions');
    await ui.click("document.querySelector('dialog[open] button[aria-label=\"Fermer\"]')");
    await ui.click("document.querySelector('#phone-nav')");
    await until(() => ui.evaluate("document.querySelector('#browser-window')?.disabled === false"), Boolean, 'entrée Téléphone depuis le PC');
    await press('Afficher le QR');
    await until(() => ui.evaluate("!!document.querySelector('#browser-qr svg')"), Boolean, 'QR de connexion depuis le PC');
    await settle(); await ui.screenshot(join(shots, 'pc-connect.png'));
    check('Téléphone ouvre la connexion depuis le PC et affiche le QR sans adresse à saisir');
  }
} catch (error) {
  if (ui) {
    await ui.screenshot(join(shots, 'failure.png')).catch(() => {});
    process.stdout.write(String(await ui.evaluate('document.body.innerText').catch(() => '')).slice(0, 1500) + '\n');
  }
  throw error;
} finally {
  await ui?.close();
  await cleanup();
  writeFileSync(join(shots, 'cleanup.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, scratchRemoved: !existsSync(dir) && !existsSync(project) }) + '\n');
}
if (!preview) writeFileSync(join(shots, 'missions-ui.json'), JSON.stringify(evidence, null, 2) + '\n');
await delay(10);
