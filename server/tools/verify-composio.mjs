// Real provider check, for the owner only. It needs a real Composio key and it contacts the real Composio API.
// It only reads: catalogue, the accounts this space already linked, and their tool lists. It never starts a connection and never executes a tool.
//
//   1. Stop EzraBot (the database is opened read-only, and a running server holds it).
//   2. npm run build
//   3. COMPOSIO_API_KEY=... node server/tools/verify-composio.mjs --owner-run [--data-dir <dossier>]
//
// The report holds counts and booleans. It prints no key, no address, no account identifier and no tool argument.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { takeProviderKey } from '../dist/src/child-env.js';
import { ProviderError, createComposioProvider, createComposioSdk } from '../dist/src/composio.js';
import { assessTool } from '../dist/src/tool-ledger.js';
import { isMetaTool } from '../dist/src/tools-protocol.js';

const args = process.argv.slice(2);
if (!args.includes('--owner-run')) {
  console.error('Ce contrôle appelle le vrai service Composio. Le propriétaire le lance lui-même avec --owner-run.');
  process.exit(2);
}
const key = takeProviderKey(process.env);
if (!key) {
  console.error('COMPOSIO_API_KEY est absente. Rien n’a été appelé.');
  process.exit(2);
}
const dataFlag = args.indexOf('--data-dir');
const dataDir = resolve(dataFlag >= 0 && args[dataFlag + 1] ? args[dataFlag + 1] : process.env.MINO_DATA_DIR ?? join(fileURLToPath(new URL('..', import.meta.url)), 'data'));
const path = join(dataDir, 'mino.sqlite');
if (!existsSync(path)) {
  console.error('Base EzraBot introuvable dans ce dossier de données. Rien n’a été appelé.');
  process.exit(2);
}

const db = new DatabaseSync(path, { readOnly: true });
let ownerId;
let accounts;
try {
  ownerId = db.prepare(`SELECT value FROM meta WHERE key = 'composio_owner'`).get()?.value;
  accounts = db.prepare('SELECT id, toolkit FROM tool_accounts ORDER BY toolkit, id').all();
} catch {
  console.error('Cette base n’a pas encore les tables des services. Démarrez EzraBot une fois avec cette version, puis arrêtez-le.');
  process.exit(2);
} finally {
  db.close();
}
if (typeof ownerId !== 'string') {
  console.error('Identité du propriétaire absente de la base. Rien n’a été appelé.');
  process.exit(2);
}

const provider = createComposioProvider({ sdk: createComposioSdk(key), ownerId });
const category = error => (error instanceof ProviderError ? error.category : 'unavailable');
const report = { checkedAt: new Date().toISOString(), sdk: '@composio/core 0.29.0', catalog: null, accounts: [] };

try {
  const services = await provider.catalog();
  report.catalog = { ok: true, services: services.length, connectable: services.filter(service => service.connectable).length };
} catch (error) {
  report.catalog = { ok: false, category: category(error) };
}

for (const [index, row] of accounts.entries()) {
  const entry = { account: index + 1, toolkit: String(row.toolkit) };
  try {
    const account = await provider.account(String(row.id), String(row.toolkit));
    entry.ownedByThisSpace = account !== null;
    entry.status = account?.status ?? null;
    if (account?.status === 'ACTIVE') {
      const tools = await provider.toolsFor(account.toolkit, account.id);
      const assessed = tools.filter(tool => !isMetaTool(tool.slug)).map(tool => assessTool(tool, account.toolkit));
      entry.tools = {
        listed: tools.length,
        metaToolsReturned: tools.filter(tool => isMetaTool(tool.slug)).length,
        withVersion: tools.filter(tool => tool.version).length,
        grantable: assessed.filter(assessment => assessment.ok).length,
      };
    }
  } catch (error) {
    entry.error = category(error);
  }
  report.accounts.push(entry);
}

console.log(JSON.stringify(report, null, 2));
console.log('Aucune connexion n’a été lancée et aucun outil n’a été exécuté. La proposition, l’approbation et l’envoi se vérifient dans EzraBot, voir docs/composio.md.');
