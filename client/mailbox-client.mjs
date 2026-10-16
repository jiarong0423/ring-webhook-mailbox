// Home-side client: keeps an Ed25519 key, signs each pull, remembers the queue position and hands new events to onEvent.
// The first pull only notes where the queue is, so events from before the hub started are never acted on.
import { createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { canonical, PULL_SCHEMA } from '../src/mailbox.mjs';

export function generateHubKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey;   // store it yourself, e.g. privateKey.export({ format: 'pem', type: 'pkcs8' }) to a 0600 file
}
export const hubPublicKeySpki = (privateKey) => createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url');

export function createMailboxClient({ base, privateKey, onEvent, fetchImpl = fetch, clock = Date.now }) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new Error('mailbox base must be https');
  const pullUrl = `${url.href.replace(/\/$/u, '')}/pull`;
  let cursor = null;

  async function pull() {
    const now = clock();
    const claims = { schema: PULL_SCHEMA, after: cursor ?? 0, nonce: randomBytes(24).toString('base64url'), issuedAt: now, expiresAt: now + 15_000 };
    const signature = sign(null, Buffer.from(canonical(claims)), privateKey).toString('base64url');
    const res = await fetchImpl(pullUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claims, signature }),
      signal: AbortSignal.timeout(5000) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`pull HTTP ${res.status} ${out.error ?? ''}`.trim()), { status: res.status, code: out.error });
    if (cursor === null) { cursor = out.head; return { baseline: true, head: out.head }; }
    if (out.reset) cursor = 0;
    for (const e of out.events ?? []) { cursor = Math.max(cursor, e.seq); await onEvent(e); }
    if (!(out.events ?? []).length && out.head > cursor) cursor = out.head;   // the missing ones expired
    return { fired: (out.events ?? []).length, head: out.head };
  }

  // Poll every intervalMs; errors are reported to onError and the loop keeps going.
  function start({ intervalMs = 10_000, onError = () => {} } = {}) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return; busy = true;
      try { await pull(); } catch (error) { onError(error); } finally { busy = false; }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return Object.freeze({ pull, start, position: () => cursor });
}
