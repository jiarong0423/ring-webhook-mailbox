// Key-value ports for the mailbox: get(pk) and put(item, { ifNotExists }). Items carry expiresAtMs; DynamoDB's TTL attribute
// expires_at removes them (reads also treat an expired row as missing, since TTL deletion is lazy).

export function createDynamoStore({ getItem, putItem, tableName, clock = Date.now }) {
  if (typeof getItem !== 'function' || typeof putItem !== 'function' || typeof tableName !== 'string') throw new TypeError('dynamo ports required');
  return Object.freeze({
    async get(pk) {
      const out = await getItem({ TableName: tableName, Key: { pk: { S: pk } }, ConsistentRead: true });
      const item = out?.Item;
      if (!item?.data?.S) return null;
      const exp = Number(item.expires_at?.N ?? 0);
      if (exp && exp * 1000 <= clock()) return null;
      return JSON.parse(item.data.S);
    },
    async put(value, { ifNotExists = false } = {}) {
      const nowSec = Math.floor(clock() / 1000);
      const expSec = value.expiresAtMs ? Math.ceil(value.expiresAtMs / 1000) : nowSec + 30 * 86_400;   // nothing outlives 30 days
      const input = { TableName: tableName, Item: { pk: { S: value.pk }, data: { S: JSON.stringify(value) }, expires_at: { N: String(expSec) } } };
      if (ifNotExists) Object.assign(input, { ConditionExpression: 'attribute_not_exists(pk) OR expires_at < :now', ExpressionAttributeValues: { ':now': { N: String(nowSec) } } });
      try { await putItem(input); return true; }
      catch (error) { if (error?.name === 'ConditionalCheckFailedException') return false; throw error; }
    }
  });
}

// Same semantics in memory, for tests and local experiments.
export function createMemoryStore({ clock = Date.now } = {}) {
  const items = new Map();
  const alive = (v) => v && (!v.expiresAtMs || v.expiresAtMs > clock());
  return Object.freeze({
    async get(pk) { const v = items.get(pk); return alive(v) ? structuredClone(v) : null; },
    async put(item, { ifNotExists = false } = {}) { if (ifNotExists && alive(items.get(item.pk))) return false; items.set(item.pk, structuredClone(item)); return true; },
    size: () => items.size
  });
}
