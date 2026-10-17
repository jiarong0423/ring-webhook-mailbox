// The public import paths in package.json "exports" resolve (Node self-reference), so a project that installs this
// package can write `import { createMailboxClient } from 'ring-webhook-mailbox/client'`.
import assert from 'node:assert/strict';
import test from 'node:test';

test('package exports: ".", "./client", "./store" and "./handler" resolve to the documented functions', async () => {
  const main = await import('ring-webhook-mailbox');
  assert.equal(typeof main.createMailbox, 'function'); assert.equal(typeof main.ringSignatureOk, 'function');
  const client = await import('ring-webhook-mailbox/client');
  assert.equal(typeof client.createMailboxClient, 'function'); assert.equal(typeof client.generateHubKey, 'function');
  const store = await import('ring-webhook-mailbox/store');
  assert.equal(typeof store.createMemoryStore, 'function'); assert.equal(typeof store.createDynamoStore, 'function');
  const handler = await import('ring-webhook-mailbox/handler');
  assert.equal(typeof handler.handler, 'function');
  const pkg = (await import('ring-webhook-mailbox/package.json', { with: { type: 'json' } })).default;
  assert.equal(pkg.version, '0.1.0');
});
