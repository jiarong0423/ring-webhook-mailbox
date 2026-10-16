// ring-webhook-mailbox: a public HTTPS mailbox for Ring partner webhooks, for a hub that lives behind NAT at home.
//
//   Ring  --POST /ring/webhook (X-Signature)-->  mailbox (Lambda function URL + DynamoDB)  <--POST /pull (Ed25519)--  home hub
//
// Ring side (API reference, "Notifications"): every webhook carries X-Signature: sha256=<hex HMAC-SHA256 of the raw body>,
// keyed with the HMAC key issued with your partner credentials. Ring wants a 2xx within 5 s, retries 5xx and timeouts
// (1 s, 5 s, 30 s, 2 min, 10 min, 1 h) and never retries 4xx; repeats share meta.request_id.
// Hub side: the hub signs each pull with its own Ed25519 key; only its PUBLIC key is configured in the cloud, so the cloud
// holds no secret that lets anyone read the queue.
// Stored per event: { type, subType, deviceId, at }. Thumbnails, account ids and the rest of the payload are dropped.
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

export class MailboxError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const deny = (status, code) => { throw new MailboxError(status, code); };
const sha = (value) => createHash('sha256').update(value).digest('hex');

export const PULL_SCHEMA = 'ring-webhook-mailbox-pull-v1';
export const DEFAULT_EVENT_TYPES = Object.freeze(['button_press', 'motion_detected', 'person_detected', 'device_online', 'device_offline']);
const TTL_EVENT_MS = 24 * 3_600_000;
const TTL_NONCE_MS = 2 * 60_000;
const MAX_PULL = 20;
const RING_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

// Canonical JSON (sorted keys): both ends sign exactly the same bytes.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// X-Signature check over the exact bytes received (never re-serialized JSON), constant-time.
export function ringSignatureOk(rawBody, header, key) {
  if (typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/u.test(header) || typeof key !== 'string' || key.length < 16) return false;
  const want = createHmac('sha256', key).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function verifyPull(envelope, hubPublicKeySpki, { now }) {
  const e = envelope;
  if (!e || typeof e !== 'object' || !e.claims || typeof e.claims !== 'object' || typeof e.signature !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(e.signature)) deny(400, 'PULL_INVALID');
  const c = e.claims;
  if (c.schema !== PULL_SCHEMA || !Number.isSafeInteger(c.after) || c.after < 0 || typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(c.nonce) ||
      !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > 15_000) deny(400, 'PULL_INVALID');
  if (c.issuedAt > now + 5_000 || c.expiresAt <= now) deny(403, 'PULL_STALE');
  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.from(hubPublicKeySpki, 'base64url'), format: 'der', type: 'spki' });
    ok = key.asymmetricKeyType === 'ed25519' && cryptoVerify(null, Buffer.from(canonical(c)), key, Buffer.from(e.signature, 'base64url'));
  } catch { ok = false; }
  if (!ok) deny(403, 'PULL_SIGNATURE_INVALID');
  return c;
}

function eventOf(body, now) {
  const rid = body?.meta?.request_id; const type = body?.data?.type; const a = body?.data?.attributes ?? {};
  if (typeof rid !== 'string' || rid.length < 1 || rid.length > 128 || typeof type !== 'string' || type.length > 64) deny(400, 'RING_WEBHOOK_INVALID');
  const at = typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp ?? body?.meta?.time ?? '');
  return { rid, event: { type, subType: typeof a.sub_type === 'string' && /^[a-z_.]{1,32}$/u.test(a.sub_type) ? a.sub_type : null,
    deviceId: typeof a.source === 'string' && RING_ID.test(a.source) ? a.source : null, at: Number.isFinite(at) ? at : now } };
}

// store: { get(pk) -> item|null, put(item, { ifNotExists }) -> boolean }, items expire at item.expiresAtMs (see store.mjs).
export function createMailbox({ store, hubPublicKeySpki, ringHmacKey, eventTypes = DEFAULT_EVENT_TYPES, clock = Date.now }) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new TypeError('store required');
  if (typeof hubPublicKeySpki !== 'string' || !/^[A-Za-z0-9_-]{40,120}$/u.test(hubPublicKeySpki)) throw new TypeError('hub public key required');
  const live = (item) => (item && (!item.expiresAtMs || item.expiresAtMs > clock()) ? item : null);

  async function ringWebhook({ rawBody, signature }) {
    if (!ringHmacKey) deny(503, 'RING_WEBHOOK_NOT_CONFIGURED');
    if (!ringSignatureOk(rawBody, signature, ringHmacKey)) deny(401, 'RING_SIGNATURE_INVALID');
    let body;
    try { body = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { deny(400, 'RING_WEBHOOK_INVALID'); }
    const { rid, event } = eventOf(body, clock());
    const seenPk = `mailbox:req:${sha(rid)}`;
    if (live(await store.get(seenPk))) return { ok: true, duplicate: true };
    if (!eventTypes.includes(event.type)) return { ok: true, ignored: true };   // 2xx: Ring must not retry or disable the endpoint
    const head = (await store.get('mailbox:head'))?.seq ?? 0;
    for (let n = head + 1; n <= head + 50; n += 1) {   // claim the next free slot; concurrent deliveries take different ones
      if (await store.put({ pk: `mailbox:evt:${n}`, event, expiresAtMs: clock() + TTL_EVENT_MS }, { ifNotExists: true })) {
        await store.put({ pk: 'mailbox:head', seq: n });
        await store.put({ pk: seenPk, expiresAtMs: clock() + TTL_EVENT_MS });   // after queuing: a retry after a failure is not lost
        return { ok: true, seq: n };
      }
    }
    deny(503, 'MAILBOX_BUSY');   // 5xx: Ring retries later
  }

  async function pull(envelope) {
    const c = verifyPull(envelope, hubPublicKeySpki, { now: clock() });
    if (!(await store.put({ pk: `mailbox:nonce:${sha(c.nonce)}`, expiresAtMs: clock() + TTL_NONCE_MS }, { ifNotExists: true }))) deny(409, 'PULL_REPLAY');
    const head = (await store.get('mailbox:head'))?.seq ?? 0;
    const after = c.after > head ? 0 : c.after;   // the head row expired and numbering restarted
    const events = [];
    for (let n = after + 1; n <= Math.min(head, after + MAX_PULL); n += 1) {
      const row = live(await store.get(`mailbox:evt:${n}`));
      if (row) events.push({ seq: n, ...row.event });
    }
    return { ok: true, head, reset: c.after > head, events };
  }

  return Object.freeze({ ringWebhook, pull });
}
