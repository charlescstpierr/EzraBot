import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browser, until, delay } from './lib/browser.mjs';

// Real PC bundle, HTTP routes and isolated SQLite; controlled chat and fake Codex process only.
// Usage: TMPDIR=~/.cache/mino-verification-tmp node tools/verify-mino-pc-chat.mjs <isolated-build> <evidence-dir>
const build = resolve(process.argv[2]);
const shots = resolve(process.argv[3] ?? join(build, 'pc-chat-evidence'));
mkdirSync(shots, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'mino-pc-chat-'));
const project = mkdtempSync(join(tmpdir(), 'mino-pc-project-'));
writeFileSync(join(project, 'README.md'), '# Projet de vérification\n');
execFileSync('git', ['init', '-q'], { cwd: project });
execFileSync('git', ['add', '.'], { cwd: project });
execFileSync('git', ['-c', 'user.name=Mino verification', '-c', 'user.email=verification@mino.local', 'commit', '-qm', 'initial'], { cwd: project });
const imp = path => import(join(build, 'dist/src', path));
const [{ openStore }, { openDevices }, { createBrowserAdmission }, { createHttpServer }, { createWorker }, { loadMascots }, { openMissions }, { createAgentEngine }, { createAgentWorker }, { createAgentRoutes }] = await Promise.all(
  ['store.js', 'devices.js', 'web-admission.js', 'http.js', 'worker.js', 'domain.js', 'missions.js', 'agent-engine.js', 'agent-worker.js', 'agent-http.js'].map(imp));
const chatStatus = { state: 'ready', account: 'chatgpt', models: [{ id: 'controlled', displayName: 'Contrôlé', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
let chatN = 0;
const chatEngine = {
  status: () => chatStatus, catalog: async () => chatStatus, close: async () => {}, onUsage: () => () => {},
  run: async input => {
    const n = ++chatN; const threadId = `controlled-chat-${n}`, turnId = `controlled-turn-${n}`;
    input.onThread(threadId); input.onTurn(turnId); input.onStage('writing');
    return { kind: 'succeeded', reply: { reply: 'Je peux confier cette demande et la suivre ici.', deliverable: null,
      handoff: { goal: `Travail ${n} : ajoute slugify avec tests, puis documente-la dans le README.`, coordinated: true, why: 'Je peux organiser les étapes dans ce dossier.' } },
      used: { model: 'controlled', effort: 'low', speed: 'standard' }, threadId, turnId };
  },
};
const store = openStore({ path: join(dir, 'chat.sqlite'), mascots: loadMascots(join(build, 'assets/mascots.json')) });
const devices = openDevices({ path: join(dir, 'devices.sqlite'), spaceId: store.view().spaceId, publicUrl: 'https://localhost:4499' });
const admission = createBrowserAdmission(devices);
const worker = createWorker({ store, engines: { chat: chatEngine, doc: chatEngine } });
const missions = openMissions({ path: join(dir, 'missions.sqlite'), minoRoot: build, dataDir: dir });
const fixture = join(build, 'dist/test/fixtures/fake-agent-server.js');
const makeEngine = scenario => createAgentEngine({ command: process.execPath, args: [fixture, scenario], tmpDir: join(dir, 'agent-tmp'), clientVersion: 'verify-pc' });
let underlying = makeEngine('hang');
const engine = Object.fromEntries(['status', 'catalog', 'run', 'exec', 'close'].map(method => [method, (...args) => underlying[method](...args)]));
const agentWorker = createAgentWorker({ missions, engine });
const agents = createAgentRoutes({ missions, worker: agentWorker, engine, longPollMs: 300,
  coordination: { bot: id => store.leadCandidate(id), origin: id => store.missionOrigin(id) } });
const csrf = randomBytes(32).toString('hex');
const port = Number(process.env.MINO_VERIFY_PC_PORT ?? 4396);
const server = createHttpServer({ store, devices, browserAdmission: admission, agents, worker, engine: chatEngine, root: build, port, csrfToken: csrf, longPollMs: 300 });
let ui; let base;
const evidence = { checkedAt: new Date().toISOString(), realModelCalls: 0, viewport: '1280x900', checks: [],
  stylesheetSha256: createHash('sha256').update(readFileSync(join(build, 'web/mino.css'))).digest('hex'),
  bundleSha256: createHash('sha256').update(readFileSync(join(build, 'dist/web/app.js'))).digest('hex') };
const check = text => { evidence.checks.push(text); process.stdout.write(`✓ ${text}\n`); };
const post = async (path, command) => (await fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-mino-csrf': csrf }, body: JSON.stringify({ requestId: randomBytes(12).toString('hex'), ...command }) })).json();
const shown = text => ui.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
const button = text => `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getClientRects().length)`;
const press = async text => { await delay(450); await ui.click(button(text)); };
const waitText = text => until(() => shown(text), Boolean, text, 20000);
const draft = 'BROUILLON PRINCIPAL CONSERVÉ';
let addedProjectId = '';
async function proposal(selectProject = true) {
  const oldCount = store.view().messages.length;
  await ui.fill('#prompt', 'Ajoute slugify avec tests, puis documente-la dans le README.');
  await delay(450);
  await ui.click("document.querySelector('#send')");
  await until(() => store.view().messages.length, count => count > oldCount + 1, 'réponse contrôlée');
  await until(() => ui.evaluate("[...document.querySelectorAll('.chat-mission')].filter(e=>e.getClientRects().length).length"), count => count === chatN, 'carte dans le chat');
  await until(() => ui.evaluate("!![...document.querySelectorAll('.chat-mission button')].find(e=>e.textContent==='Confier la mission')"), Boolean, 'formulaire inline');
  await ui.fill('#prompt', draft);
  if (selectProject) await ui.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label="Dossier de la mission"]')].at(-1);e.value=${JSON.stringify(addedProjectId)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
}
async function organization(value) {
  await ui.evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label="Organisation de la mission"]')].at(-1);e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
}
try {
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${server.address().port}`;
  const added = await post('/api/agents/commands', { type: 'project.add', path: project, name: 'Projet de vérification', checkCommand: 'true' }); assert.ok(added.ok, added.message);
  addedProjectId = added.id;
  const secondFolder = join(project, 'autre-dossier'); mkdirSync(secondFolder);
  const extra = await post('/api/agents/commands', { type: 'project.add', path: secondFolder, name: 'Autre dossier', checkCommand: 'true' }); assert.ok(extra.ok);
  await post('/api/commands', { type: 'bot.select', botId: 'nova' });
  ui = await browser(join(dir, 'chrome'));
  await ui.navigate(base);
  await until(() => ui.evaluate("document.querySelector('#picker-label')?.textContent"), text => text === 'Mino', 'Mino ouvert par défaut');
  check('Mino est ouvert par défaut, même si un autre fil était sélectionné sur le serveur');
  await proposal(false);
  assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Dossier de la mission\"]').value"), '');
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.chat-mission button')].find(e=>e.textContent==='Confier la mission').disabled"), true);
  await ui.evaluate(`(()=>{const e=document.querySelector('[aria-label="Dossier de la mission"]');e.value=${JSON.stringify(added.id)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  check('plusieurs dossiers : choix explicite requis avant confirmation, aucun premier dossier présélectionné');
  assert.equal(missions.view().missions.length, 0);
  assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Organisation de la mission\"]').value"), 'coordinated');
  assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Responsable de la mission\"]').value==='mino'"), false);
  assert.equal(await ui.evaluate("!!document.querySelector('dialog[open]')"), false);
  await ui.screenshot(join(shots, 'pc-proposal-inline.png'));
  check('proposition structurée sans mission automatique, dossier et confirmation inline, organisation recommandée préchargée');
  await organization('direct'); await press('Confier la mission');
  await waitText('Je suis le travail en cours.');
  const first = missions.view().missions[0]; assert.ok(first.originMessageId);
  assert.equal(missions.detail(first.id).origin.text, 'Ajoute slugify avec tests, puis documente-la dans le README.');
  assert.equal(await ui.evaluate("document.querySelector('#prompt').value"), draft);
  await ui.screenshot(join(shots, 'pc-running-inline.png'));
  await press('Arrêter'); await waitText('L’arrêt est confirmé.');
  assert.equal(missions.detail(first.id).status, 'stopped');
  await ui.reload(); await waitText('L’arrêt est confirmé.');
  assert.equal(await ui.evaluate("document.querySelector('#prompt').value"), draft);
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.chat-mission button')].some(e=>e.textContent==='Confier la mission')"), false);
  assert.equal(missions.view().missions.length, 1);
  check('création liée par originMessageId, arrêt confirmé, brouillon principal conservé et même carte retrouvée après rechargement');
  await underlying.close(); underlying = makeEngine('edit');
  await press('Reprendre avec Mino après vérification'); await waitText('Le travail est prêt à examiner.');
  await until(() => shown('Valider ce résultat'), Boolean, 'acceptation admise');
  const staleAttempt = missions.detail(first.id).can.accept;
  const revise = await post('/api/agents/commands', { type: 'mission.revise', missionId: first.id, goal: 'Objectif version 2', start: false }); assert.ok(revise.ok);
  await press('Valider ce résultat');
  await until(() => ui.evaluate("document.querySelector('.chat-mission [role=alert]')?.textContent"), text => text && text.includes('ne peut pas être validé'), 'refus visible');
  assert.equal(missions.detail(first.id).acceptedAttemptId, null);
  assert.equal(missions.detail(first.id).status, 'outdated');
  const stale = await post('/api/agents/commands', { type: 'mission.accept', missionId: first.id, attemptId: staleAttempt }); assert.equal(stale.ok, false);
  await waitText('L’objectif a changé. Le résultat précédent est périmé.');
  await ui.screenshot(join(shots, 'pc-stale-refused.png'));
  await press('Préciser à Mino');
  await ui.fill('[aria-label="Précision pour Mino"]', 'PRÉCISION PC NON ENVOYÉE');
  await ui.evaluate('document.activeElement.blur()');
  const renamedDraft = await post('/api/commands', { type: 'bot.update', botId: 'mino', name: 'Mino brouillon' }); assert.ok(renamedDraft.ok);
  await until(() => ui.evaluate(`document.querySelector('[aria-label="Précision pour Mino"]')?.closest('[data-sig]')?.dataset.sig.includes('Mino brouillon')`), Boolean, 'carte reconstruite avec précision en cours');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Précision pour Mino"]')?.value`), 'PRÉCISION PC NON ENVOYÉE');
  await press('Annuler');
  const namedBack = await post('/api/commands', { type: 'bot.update', botId: 'mino', name: 'Mino' }); assert.ok(namedBack.ok);

  await press('Modifier l’objectif');
  await ui.fill('[aria-label="Nouvel objectif"]', 'Objectif version 2, relu dans le chat.');
  await ui.click("document.querySelector('.chat-mission input[type=checkbox]')");
  await press('Enregistrer l’objectif'); await waitText('Le travail est prêt à examiner.');
  await press('Valider ce résultat'); await waitText('Tu as validé ce travail.');
  assert.equal(missions.detail(first.id).status, 'accepted');
  check('reprise, refus d’une validation périmée, objectif modifié dans le chat et validation du résultat courant');

  const coordDir = join(dir, 'coord'); mkdirSync(coordDir);
  const decision = fields => ({ kind: 'delegate', why: 'Étape séparable.', childId: null, title: null, goal: null, note: null, question: null, summary: null, limits: null, evidence: [], ...fields });
  writeFileSync(join(coordDir, 'decisions.json'), JSON.stringify([
    decision({ title: 'Fonction slugify', goal: 'Ajoute slugify.js et son test.' }),
    decision({ title: 'README', goal: 'Documente slugify dans le README.' }),
    decision({ kind: 'ask', question: 'Souhaites-tu retirer les accents ?', why: 'Une précision est nécessaire.' }),
    decision({ kind: 'finish', summary: 'Slugify ajoutée avec son test, puis documentée dans le README.', limits: 'Les autres alphabets ne sont pas gérés.', evidence: [{ childId: '$child1', attemptId: '$cite1' }, { childId: '$child2', attemptId: '$cite2' }] }),
  ]));
  await underlying.close(); underlying = makeEngine(`coord@${coordDir}`);
  await proposal();
  await press('Confier la mission'); await waitText('J’attends ta décision.');
  const coordinated = missions.view().missions.find(m => m.mode === 'coordinated' && !m.parentId); assert.ok(coordinated);
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.chat-mission-details')].some(e=>e.open)"), false);
  await press('Préciser à Mino');
  await ui.fill('[aria-label="Précision pour Mino"]', 'Oui, retire les accents.'); await press('Envoyer la précision');
  await waitText('Valider la synthèse');
  assert.equal(await ui.evaluate("document.querySelector('#prompt').value"), draft);
  assert.equal(await ui.evaluate("!!document.querySelector('dialog[open]')"), false);
  const child = missions.detail(coordinated.id).children[0];
  const childAcceptance = await post('/api/agents/commands', { type: 'mission.accept', missionId: child.id, attemptId: missions.detail(child.id).attempts.at(-1).id });
  assert.equal(childAcceptance.ok, false);
  await ui.screenshot(join(shots, 'pc-synthesis-inline.png'));
  await press('Valider la synthèse');
  await until(() => missions.detail(coordinated.id).status, status => status === 'accepted', 'synthèse acceptée');
  assert.equal(missions.detail(child.id).status, 'accepted');
  check('précision à Mino et synthèse coordonnée dans la conversation ; étape individuelle non validable, synthèse et preuves acceptées ensemble');
  const cardsBeforeChild = await ui.evaluate("document.querySelectorAll('.chat-mission').length");
  await ui.evaluate("(()=>{const e=[...document.querySelectorAll('.chat-mission-details')].at(-1);e.open=true})()");
  await ui.evaluate(`(()=>{
    const original=window.fetch;window.__verificationChildOffline=true;
    window.fetch=async(...args)=>args[0]==='/api/agents/missions/${child.id}'&&window.__verificationChildOffline
      ? new Response('{}',{status:503}):original(...args);
  })()`);
  await press('Consulter l’étape : Fonction slugify');
  await until(() => ui.evaluate("document.querySelector('.chat-mission-step [role=alert]')?.textContent"), value => value?.includes('actualiser'), 'échec de lecture étape');
  assert.equal(await ui.evaluate("!!document.querySelector('.chat-mission-step form')"), false);
  await ui.evaluate('window.__verificationChildOffline=false');
  await until(() => ui.evaluate("document.querySelector('.chat-mission-step')?.dataset.status"), status => status === 'accepted', 'étape dans les détails');
  assert.equal(await ui.evaluate("document.querySelectorAll('.chat-mission').length"), cardsBeforeChild);
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.chat-mission-step button')].some(e=>e.textContent==='Valider ce résultat')"), false);
  check('les étapes restent consultables dans Détails, avec leurs droits serveur et sans déplacer la conversation');
  await underlying.close(); underlying = makeEngine('exit-mid');
  await proposal(); await organization('direct');
  await ui.evaluate(`(()=>{
    const original=window.fetch; let lose=true;
    window.fetch=async(...args)=>{
      const response=await original(...args);
      if(lose && args[0]==='/api/agents/commands' && JSON.parse(args[1].body).type==='mission.create') {
        lose=false; throw Error('controlled lost acknowledgement');
      }
      return response;
    };
  })()`);
  await press('Confier la mission');
  await waitText('Le résultat est inconnu. Vérifie le dossier avant de reprendre.');
  const unknown = missions.view().missions.find(m => m.status === 'interrupted'); assert.ok(unknown);
  assert.equal(missions.view().missions.filter(m => !m.parentId).length, 3);
  const unknownCard = '.chat-mission[data-mission-id="' + unknown.id + '"]';
  assert.equal(await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(unknownCard + ' button')})].some(e=>e.textContent==='Valider ce résultat')`), false);
  assert.equal(await ui.evaluate(`!![...document.querySelectorAll(${JSON.stringify(unknownCard + ' button')})].find(e=>e.textContent==='Reprendre avec Mino après vérification')`), true);
  await ui.screenshot(join(shots, 'pc-result-unknown.png'));
  await ui.evaluate(`(()=>{
    const original=window.fetch; let refuse=true; window.__verificationBudgetRequests=[];
    window.fetch=async(...args)=>{
      if(args[0]==='/api/agents/commands' && JSON.parse(args[1].body).type==='mission.budget') {
        window.__verificationBudgetRequests.push(args[1].body);
        if(refuse) {refuse=false; return new Response('{}',{status:403});}
      }
      return original(...args);
    };
  })()`);
  await press('Accorder 2 essais');
  await until(() => missions.detail(unknown.id).maxAttempts, max => max === 5, 'budget confirmé');
  assert.deepEqual(await ui.evaluate('window.__verificationBudgetRequests.length'), 2);
  assert.equal(await ui.evaluate('window.__verificationBudgetRequests[0]===window.__verificationBudgetRequests[1]'), true);
  assert.equal(missions.detail(unknown.id).status, 'interrupted');
  assert.equal(missions.detail(unknown.id).attempts.length, 1);
  check('budget accordé suivant can, session 403 renouvelée et même requestId rejoué ; aucune reprise implicite');
  await ui.click(`[...document.querySelectorAll(${JSON.stringify(unknownCard + ' button')})].find(e=>e.textContent==='Modifier l’objectif')`);
  await ui.fill(unknownCard + ' [aria-label="Nouvel objectif"]', 'BROUILLON PC AVANT RECONSTRUCTION');
  await ui.evaluate(`(()=>{const original=window.fetch;let lose=true;window.__lostBudgetRequests=[];window.fetch=async(...args)=>{if(args[0]==='/api/agents/commands'&&JSON.parse(args[1].body).type==='mission.budget'){window.__lostBudgetRequests.push(args[1].body);const response=await original(...args);if(lose){lose=false;throw new TypeError('lost budget acknowledgement')}return response;}return original(...args)}})()`);
  await press('Accorder 2 essais');
  await until(() => missions.detail(unknown.id).maxAttempts, max => max === 7, 'budget appliqué mais accusé perdu');
  await waitText('Réessayer la confirmation');
  const renamed = await post('/api/commands', { type: 'bot.update', botId: 'mino', name: 'Mino vérification' }); assert.ok(renamed.ok);
  await until(() => ui.evaluate(`document.querySelector(${JSON.stringify(unknownCard)})?.closest('[data-sig]')?.dataset.sig.includes('Mino vérification')`), Boolean, 'message reconstruit après changement de profil');
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(unknownCard + ' [aria-label="Nouvel objectif"]')})?.value`), 'BROUILLON PC AVANT RECONSTRUCTION');
  assert.equal(await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(unknownCard + ' button')})].some(e=>e.textContent==='Réessayer la confirmation')`), true);
  await press('Réessayer la confirmation');
  await until(() => ui.evaluate('window.__lostBudgetRequests.length'), n => n === 2, 'même confirmation rejouée après reconstruction');
  assert.equal(await ui.evaluate('window.__lostBudgetRequests[0]===window.__lostBudgetRequests[1]'), true);
  assert.equal(missions.detail(unknown.id).maxAttempts, 7, 'la reconstruction ne réaccorde pas le budget');
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(unknownCard + ' [aria-label="Nouvel objectif"]')})?.value`), 'BROUILLON PC AVANT RECONSTRUCTION');
  await ui.screenshot(join(shots, 'pc-reconstructed-pending.png'));
  await ui.click(`[...document.querySelectorAll(${JSON.stringify(unknownCard + ' button')})].find(e=>e.textContent==='Annuler')`);
  const restoredName = await post('/api/commands', { type: 'bot.update', botId: 'mino', name: 'Mino' }); assert.ok(restoredName.ok);
  check('reconstruction de carte : brouillon et commande inconnue conservés, même reçu rejoué, aucun budget doublé');

  check('confirmation réseau perdue retrouvée par origine sans doublon ; résultat inconnu affiché sans validation ni relance automatique');
  await ui.reload(); await waitText('Tu as validé ce travail.');
  assert.equal(missions.view().missions.filter(m => !m.parentId).length, 3);
  assert.equal(await ui.evaluate("document.querySelector('#prompt').value"), draft);
  await ui.evaluate(`(()=>{
    const original=window.fetch;window.__missionReads=0;window.__missionConcurrent=0;window.__missionMaxConcurrent=0;
    window.fetch=async(...args)=>{
      const tracked=typeof args[0]==='string' && (args[0]==='/api/agents/view'||args[0].startsWith('/api/agents/missions/'));
      if(tracked){window.__missionReads++;window.__missionConcurrent++;window.__missionMaxConcurrent=Math.max(window.__missionMaxConcurrent,window.__missionConcurrent);}
      try{return await original(...args);}finally{if(tracked)window.__missionConcurrent--;}
    };
  })()`);
  await ui.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  await delay(200); const hiddenReads=await ui.evaluate('window.__missionReads'); await delay(2000);
  assert.equal(await ui.evaluate('window.__missionReads'), hiddenReads);
  await ui.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await until(() => ui.evaluate('window.__missionReads'), count => count > hiddenReads, 'page restaurée actualisée');
  await ui.click("document.querySelector('#bot-trigger')"); await delay(450);
  await ui.click("document.querySelector('#fan-actions [data-bot-id=\"nova\"]')");
  await until(() => ui.evaluate("document.querySelector('#picker-label').textContent"), value => value !== 'Mino', 'autre fil conservé');
  await delay(450); const pausedReads=await ui.evaluate('window.__missionReads'); await delay(2200);
  assert.equal(await ui.evaluate('window.__missionReads'), pausedReads);
  await ui.click("document.querySelector('#bot-trigger')"); await delay(450);
  await ui.click("document.querySelector('#fan-actions [data-bot-id=\"mino\"]')");
  await until(() => ui.evaluate('window.__missionReads'), count => count > pausedReads, 'actualisation Mino reprise');
  assert.equal(await ui.evaluate('window.__missionMaxConcurrent'), 1);
  assert.equal(await ui.evaluate("document.querySelector('#prompt').value"), draft);
  check('les autres fils restent accessibles, une seule lecture de missions à la fois et aucune actualisation quand le fil Mino est masqué ; reprise après restauration de page');
  await ui.click("document.querySelector('#projects-nav')"); await waitText('Confier un dossier');
  await ui.screenshot(join(shots, 'pc-projects-preserved.png'));
  await ui.click("document.querySelector('dialog[open] button[aria-label=\"Fermer\"]')");
  await ui.click("document.querySelector('#phone-nav')"); await waitText('Connecte ton téléphone.');
  await until(() => ui.evaluate("!!document.querySelector('#browser-window')"), Boolean, 'connexion téléphone');
  await press('Afficher le QR'); await until(() => ui.evaluate("!!document.querySelector('#browser-qr svg')"), Boolean, 'QR de connexion');
  await ui.screenshot(join(shots, 'pc-phone-preserved.png'));
  check('navigation Projets et Téléphone conservée ; rechargement sans duplication et brouillon conservé');
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
} catch (error) {
  if (ui) {
    await ui.screenshot(join(shots, 'failure.png')).catch(() => {});
    process.stderr.write(String(await ui.evaluate('document.body.innerText').catch(() => '')).slice(-6500) + '\n');
  }
  throw error;
} finally {
  await ui?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await agentWorker.close(); await underlying.close(); await worker.close(); missions.close(); devices.close(); store.close();
  rmSync(dir, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
  evidence.scratchRemoved = !existsSync(dir) && !existsSync(project);
  writeFileSync(join(shots, 'pc-chat.json'), JSON.stringify(evidence, null, 2) + '\n');
}
await delay(10);
