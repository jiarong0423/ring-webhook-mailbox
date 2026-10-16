// AWS Lambda handler behind a function URL (payload v2). Routes: POST /ring/webhook (from Ring), POST /pull (from your hub).
// Environment: MAILBOX_TABLE, HUB_PUBLIC_KEY_SPKI (Ed25519 SPKI, base64url), RING_WEBHOOK_HMAC_KEY (empty = webhooks refused).
import { createMailbox, MailboxError } from './mailbox.mjs';
import { createDynamoStore } from './store.mjs';

const HEADERS = Object.freeze({ 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
const MAX_BODY = 16_384;
const respond = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

let factory = null; let mailbox = null;
export function installMailboxForTest(make) { factory = make; mailbox = null; }
async function production() {
  const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb');   // provided by the Lambda runtime
  const client = new DynamoDBClient({});
  const store = createDynamoStore({ tableName: process.env.MAILBOX_TABLE,
    getItem: (input) => client.send(new GetItemCommand(input)), putItem: (input) => client.send(new PutItemCommand(input)) });
  return createMailbox({ store, hubPublicKeySpki: process.env.HUB_PUBLIC_KEY_SPKI, ringHmacKey: process.env.RING_WEBHOOK_HMAC_KEY || null });
}

export async function handler(event) {
  const route = `${event?.requestContext?.http?.method ?? ''} ${event?.rawPath ?? ''}`;
  if (route !== 'POST /ring/webhook' && route !== 'POST /pull') return respond(404, { error: 'NOT_FOUND' });
  if (event.rawQueryString) return respond(400, { error: 'QUERY_NOT_ALLOWED' });
  const raw = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8');
  if (raw.length > MAX_BODY) return respond(413, { error: 'BODY_TOO_LARGE' });
  try {
    mailbox ??= await (factory ?? production)();
    if (route === 'POST /ring/webhook') return respond(200, await mailbox.ringWebhook({ rawBody: raw, signature: event.headers?.['x-signature'] }));
    let envelope;
    try { envelope = JSON.parse(raw.toString('utf8')); } catch { return respond(400, { error: 'PULL_INVALID' }); }
    return respond(200, await mailbox.pull(envelope));
  } catch (error) {
    if (error instanceof MailboxError) return respond(error.status, { error: error.code });
    console.error(JSON.stringify({ event: 'ring_webhook_mailbox', outcome: 'ERROR', name: error?.name }));
    return respond(503, { error: 'MAILBOX_UNAVAILABLE' });   // 5xx: Ring retries
  }
}
