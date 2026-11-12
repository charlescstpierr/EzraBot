import { ProviderError, type Provider, type ProviderErrorCategory } from '../../src/composio.js';
import { schemaSha256, type AccountFacts, type Pin, type RawToolFacts, type SendResult } from '../../src/tool-ledger.js';
import type { ServiceOption } from '../../src/tools-protocol.js';

// Test-only stand-in for the provider. Every account, service, action and result here is synthetic: no real service is ever contacted.

export const SERVICES: ServiceOption[] = [
  { id: 'ac_synthetique_gmail', toolkit: 'gmail', name: 'Courriel (synthétique)', connectable: true, reason: null },
  { id: 'ac_synthetique_slack', toolkit: 'slack', name: 'Messagerie d’équipe (synthétique)', connectable: true, reason: null },
  { id: 'ac_synthetique_notion', toolkit: 'notion', name: 'Notes par clé (synthétique)', connectable: false, reason: 'Méthode de connexion non prise en charge ici (API_KEY). Seul OAuth 2 est pris en charge.' },
];

export const SEND_EMAIL: RawToolFacts = {
  slug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', name: 'Envoyer un courriel', description: 'Envoie un courriel depuis le compte relié. Action synthétique de test.', version: '20260101_00',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['to', 'subject', 'body'],
    properties: { to: { type: 'string', minLength: 3 }, subject: { type: 'string' }, body: { type: 'string' } },
  },
};
export const FETCH_EMAILS: RawToolFacts = {
  slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', name: 'Lire des courriels', description: 'Lit les derniers courriels. Action synthétique de test.', version: '20260101_00',
  inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 10 } } },
};
export const UNVERSIONED: RawToolFacts = {
  slug: 'GMAIL_LIST_LABELS', toolkit: 'gmail', name: 'Lister les libellés', description: 'Action synthétique sans version annoncée.', version: null,
  inputSchema: { type: 'object', properties: {} },
};
export const META_TOOL: RawToolFacts = {
  slug: 'COMPOSIO_MULTI_EXECUTE_TOOL', toolkit: 'gmail', name: 'Exécution groupée', description: 'Outil interne synthétique.', version: '20260101_00',
  inputSchema: { type: 'object', properties: {} },
};
export const SEND_MESSAGE: RawToolFacts = {
  slug: 'SLACK_SEND_MESSAGE', toolkit: 'slack', name: 'Publier un message', description: 'Publie un message dans un canal. Action synthétique de test.', version: '20260202_00',
  inputSchema: { type: 'object', additionalProperties: false, required: ['channel', 'text'], properties: { channel: { type: 'string' }, text: { type: 'string' } } },
};

export const ACCOUNT_A: AccountFacts = { id: 'ca_synthetique_a', toolkit: 'gmail', alias: 'Compte synthétique A', status: 'ACTIVE' };
export const ACCOUNT_B: AccountFacts = { id: 'ca_synthetique_b', toolkit: 'gmail', alias: 'Compte synthétique B', status: 'ACTIVE' };

export type FakeProvider = Provider & {
  accounts: Map<string, AccountFacts>;
  /** The provider's current catalogue. Tests change it to simulate a new version or schema. */
  tools: RawToolFacts[];
  /** Actions that really reached the provider's execute call. */
  sent: { pin: Pin; args: Record<string, unknown> }[];
  /** When set, every read fails with this category. */
  failing: ProviderErrorCategory | null;
  /** Replaces the default outcome of the next sends. */
  outcome: ((pin: Pin, args: Record<string, unknown>) => SendResult | Promise<SendResult>) | null;
  reads: number;
};

/**
 * Follows the adapter's contract: an account belongs to the owner or does not exist, a send first re-reads the catalogue,
 * and a mismatch is `not_sent`. Without a scripted outcome, the subject or text of the action picks a synthetic result.
 */
export function createFakeProvider(): FakeProvider {
  let links = 0;
  const provider: FakeProvider = {
    accounts: new Map(),
    tools: [SEND_EMAIL, FETCH_EMAILS, UNVERSIONED, META_TOOL, SEND_MESSAGE],
    sent: [],
    failing: null,
    outcome: null,
    reads: 0,
    async catalog() {
      read();
      return SERVICES;
    },
    async startLink(serviceId, alias, callbackUrl) {
      read();
      const service = SERVICES.find(candidate => candidate.id === serviceId);
      if (!service?.connectable || !callbackUrl.startsWith('http://127.0.0.1:')) throw new ProviderError('not_found');
      links += 1;
      const accountId = `ca_synthetique_lien_${links}`;
      provider.accounts.set(accountId, { id: accountId, toolkit: service.toolkit, alias, status: alias.includes('refus') ? 'FAILED' : alias.includes('attente') ? 'INITIATED' : 'ACTIVE' });
      return { accountId, toolkit: service.toolkit, redirectUrl: `https://connexion-synthetique.invalid/lien/${links}` };
    },
    async account(accountId, toolkit) {
      read();
      const account = provider.accounts.get(accountId);
      return account && account.toolkit === toolkit ? { ...account } : null;
    },
    async toolsFor(toolkit, accountId, only) {
      read();
      if (!provider.accounts.has(accountId)) throw new ProviderError('not_found');
      return provider.tools.filter(tool => tool.toolkit === toolkit && (!only || only.includes(tool.slug)));
    },
    async send(pin, args) {
      if (provider.failing) return { kind: 'not_sent', reason: 'session' };
      const tool = provider.tools.find(candidate => candidate.slug === pin.toolSlug && candidate.toolkit === pin.toolkit);
      if (!tool) return { kind: 'not_sent', reason: 'tool_absent' };
      if (!tool.version) return { kind: 'not_sent', reason: 'version_missing' };
      if (tool.version !== pin.version || schemaSha256(tool.inputSchema) !== pin.schemaSha256) return { kind: 'not_sent', reason: 'schema_changed' };
      provider.sent.push({ pin, args });
      if (provider.outcome) return provider.outcome(pin, args);
      const marker = String(args.subject ?? args.text ?? '');
      if (marker.includes('inconnu')) return { kind: 'unknown', category: 'timeout' };
      if (marker.includes('échec')) return { kind: 'failed', data: {}, error: null, logId: `log_synthetique_${provider.sent.length}` };
      return { kind: 'completed', data: { id: `resultat_synthetique_${provider.sent.length}`, access_token: 'jeton-synthetique-a-retirer' }, error: null, logId: `log_synthetique_${provider.sent.length}` };
    },
  };
  function read(): void {
    provider.reads += 1;
    if (provider.failing) throw new ProviderError(provider.failing);
  }
  return provider;
}
