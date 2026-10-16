// ring-webhook-mailbox end to end in memory: Ring-shaped webhooks -> handler -> mailbox -> signed pulls by the client.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMailbox, ringSignatureOk } from '../src/mailbox.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { handler, installMailboxForTest } from '../src/handler.mjs';
import { createMailboxClient, generateHubKey, hubPublicKeySpki } from '../client/mailbox-client.mjs';
import { buildZip } from '../scripts/build.mjs';

const KEY = 'example-ring-hmac-key-0123456789';
const sample = (name) => readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8');
function payload(type, { rid = randomBytes(8).toString('hex'), ts = Date.now(), sub } = {}) {
  return JSON.stringify({ meta: { version: '1.1', time: new Date(ts).toISOString(), request_id: rid, account_id: 'acct' },
    data: { id: `dev_${type}_${ts}`, type, attributes: { source: 'dev', source_type: 'devices', timestamp: ts, ...(sub ? { sub_type: sub } : {}) } } });
}
const sig = (raw, key = KEY) => `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;
const http = (path, body, headers = {}, b64 = false) => handler({ requestContext: { http: { method: 'POST' } }, rawPath: path,
  body: b64 ? Buffer.from(body).toString('base64') : body, isBase64Encoded: b64, headers });

function setup({ ringHmacKey = KEY } = {}) {
  const hubKey = generateHubKey();
  const store = createMemoryStore();
  installMailboxForTest(async () => createMailbox({ store, hubPublicKeySpki: hubPublicKeySpki(hubKey), ringHmacKey }));
  const seen = [];
  const fetchImpl = async (url, init) => { const r = await http(new URL(url).pathname, init.body); return { ok: r.statusCode < 300, status: r.statusCode, json: async () => JSON.parse(r.body) }; };
  const client = createMailboxClient({ base: 'https://mailbox.example/', privateKey: hubKey, fetchImpl, onEvent: (e) => seen.push(e) });
  return { hubKey, store, client, seen };
}

test('X-Signature: exact bytes, sha256= prefix, constant length; anything else is refused', () => {
  const raw = Buffer.from(payload('button_press'));
  assert.equal(ringSignatureOk(raw, sig(raw), KEY), true);
  assert.equal(ringSignatureOk(raw, sig(raw, 'other-key-0123456789'), KEY), false);
  assert.equal(ringSignatureOk(raw, sig(raw).slice(7), KEY), false);
  assert.equal(ringSignatureOk(Buffer.from(JSON.stringify(JSON.parse(raw), null, 2)), sig(raw), KEY), false);
  assert.equal(ringSignatureOk(raw, sig(raw), 'short'), false);
});

test('handler: 503 until configured, 401 bad signature, 400 junk, 413 oversized, 404 other routes; base64 bodies accepted', async () => {
  setup({ ringHmacKey: null });
  assert.equal((await http('/ring/webhook', payload('button_press'), { 'x-signature': 'sha256=' + '0'.repeat(64) })).statusCode, 503);
  setup();
  const raw = payload('button_press');
  assert.equal((await http('/ring/webhook', raw, { 'x-signature': sig(raw, 'wrong-key-0123456789') })).statusCode, 401);
  assert.equal((await http('/ring/webhook', raw, {})).statusCode, 401);
  assert.equal((await http('/ring/webhook', '{oops', { 'x-signature': sig('{oops') })).statusCode, 400);
  const big = JSON.stringify({ x: 'y'.repeat(17_000) });
  assert.equal((await http('/ring/webhook', big, { 'x-signature': sig(big) })).statusCode, 413);
  assert.equal((await handler({ requestContext: { http: { method: 'GET' } }, rawPath: '/ring/webhook' })).statusCode, 404);
  const ok = await http('/ring/webhook', raw, { 'x-signature': sig(raw) }, true);
  assert.equal(ok.statusCode, 200); assert.equal(JSON.parse(ok.body).seq, 1);
});

test('documented example payloads are accepted; repeats by request_id acknowledged once; unknown types 200 but not queued', async () => {
  const s = setup();
  for (const name of ['button_press', 'motion_detected', 'device_offline']) {
    const raw = sample(name);
    const r = await http('/ring/webhook', raw, { 'x-signature': sig(raw) });
    assert.equal(r.statusCode, 200, `${name}: ${r.body}`);
    assert.equal(JSON.parse((await http('/ring/webhook', raw, { 'x-signature': sig(raw) })).body).duplicate, true);
  }
  const other = payload('subscription_activated');
  assert.equal(JSON.parse((await http('/ring/webhook', other, { 'x-signature': sig(other) })).body).ignored, true);
  const row = await s.store.get('mailbox:evt:2');
  assert.deepEqual(Object.keys(row.event).sort(), ['at', 'deviceId', 'subType', 'type']);
  assert.equal(row.event.subType, 'human');
});

test('client: first pull only notes the position; later events arrive once, in order, 20 per pull; nothing twice', async () => {
  const s = setup();
  const deliver = (type, sub) => { const raw = payload(type, { sub }); return http('/ring/webhook', raw, { 'x-signature': sig(raw) }); };
  await deliver('button_press');
  assert.deepEqual(await s.client.pull(), { baseline: true, head: 1 });
  for (let i = 0; i < 22; i += 1) await deliver(i % 2 ? 'device_online' : 'device_offline');
  assert.equal((await s.client.pull()).fired, 20);
  assert.equal((await s.client.pull()).fired, 2);
  assert.equal((await s.client.pull()).fired, 0);
  assert.deepEqual(s.seen.map((e) => e.seq), Array.from({ length: 22 }, (_, i) => i + 2));
});

test('pulls: only the hub key can read the queue; replayed or stale pulls are refused', async () => {
  const s = setup();
  const stranger = createMailboxClient({ base: 'https://mailbox.example', privateKey: generateHubKey(), onEvent: () => {},
    fetchImpl: async (url, init) => { const r = await http('/pull', init.body); return { ok: r.statusCode < 300, status: r.statusCode, json: async () => JSON.parse(r.body) }; } });
  await assert.rejects(stranger.pull(), { status: 403, code: 'PULL_SIGNATURE_INVALID' });
  let captured = null;
  const recorder = createMailboxClient({ base: 'https://mailbox.example', privateKey: s.hubKey, onEvent: () => {},
    fetchImpl: async (url, init) => { captured = init.body; const r = await http('/pull', init.body); return { ok: r.statusCode < 300, status: r.statusCode, json: async () => JSON.parse(r.body) }; } });
  await recorder.pull();
  assert.equal((await http('/pull', captured)).statusCode, 409);   // the same signed pull again
  const old = JSON.parse(captured); old.claims.issuedAt -= 60_000; old.claims.expiresAt -= 60_000;
  assert.equal((await http('/pull', JSON.stringify(old))).statusCode, 403);
});

test('bundle: deterministic zip of the three Lambda files; template is least-privilege and keeps the HMAC key NoEcho', () => {
  assert.deepEqual(buildZip(), buildZip());
  const t = JSON.parse(readFileSync(new URL('../template.json', import.meta.url), 'utf8'));
  assert.equal(t.Parameters.RingWebhookHmacKey.NoEcho, true);
  const stmts = t.Resources.MailboxRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(stmts[0].Action, ['dynamodb:GetItem', 'dynamodb:PutItem']);
  assert.ok(stmts.every((st) => st.Resource !== '*'));
  assert.equal(t.Resources.MailboxFunction.Properties.Timeout <= 5, true);   // Ring expects an answer within 5 s
});
