import { createHmac, randomUUID } from 'node:crypto';

/** Test-only stand-in for the provider: builds and signs one V3 trigger message exactly as its documentation describes. */
export type EventInput = {
  id?: string;
  triggerId?: string;
  slug?: string;
  accountId?: string;
  userId?: string | null;
  type?: string;
  data?: Record<string, unknown>;
};

export function eventBody(owner: string, input: EventInput = {}): { id: string; body: Buffer } {
  const id = input.id ?? `msg_${randomUUID()}`;
  const payload = {
    id,
    type: input.type ?? 'composio.trigger.message',
    timestamp: '2026-11-14T10:30:00Z',
    metadata: {
      log_id: 'log_synthetique',
      trigger_slug: input.slug ?? 'GITHUB_ISSUE_ADDED_EVENT',
      toolkit_slug: 'github',
      trigger_id: input.triggerId ?? 'ti_synthetique',
      connected_account_id: input.accountId ?? 'ca_synthetique',
      auth_config_id: 'ac_synthetique',
      user_id: input.userId === undefined ? owner : input.userId,
    },
    data: input.data ?? { title: 'Ticket synthétique', url: 'https://exemple.invalid/1' },
  };
  return { id, body: Buffer.from(JSON.stringify(payload), 'utf8') };
}

export function signHeaders(secret: string, id: string, body: Buffer, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${id}.${timestamp}.`).update(body).digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
    'x-composio-webhook-version': 'V3',
    'x-composio-delivery-attempt': '1',
  };
}

/** The same headers as Node gives a handler: every value in a list, names in lower case. */
export const distinct = (headers: Record<string, string>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), [value]]));
