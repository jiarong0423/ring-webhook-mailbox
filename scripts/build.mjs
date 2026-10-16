// Builds the Lambda bundle (src/handler.mjs, mailbox.mjs, store.mjs, flat) as a deterministic zip: stored entries, fixed
// timestamps, fixed order, so the same source always gives the same sha256 (useful as the S3 key and for review).
//   node scripts/build.mjs <out-dir>   -> <out-dir>/ring-webhook-mailbox.zip, prints { sha256, bytes, key }
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
export const FILES = Object.freeze(['handler.mjs', 'mailbox.mjs', 'store.mjs']);
const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;   // 1980-01-01 00:00

export function buildZip() {
  const locals = []; const centrals = []; let offset = 0;
  for (const name of FILES) {
    const data = readFileSync(join(src, name)); const n = Buffer.from(name, 'utf8'); const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(FILES.length, 8); end.writeUInt16LE(FILES.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) { console.error('ERROR usage: node scripts/build.mjs <out-dir>'); process.exit(2); }
  const zip = buildZip(); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'ring-webhook-mailbox.zip'), zip);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  console.log(JSON.stringify({ sha256, bytes: zip.length, key: `ring-webhook-mailbox/${sha256}/ring-webhook-mailbox.zip` }));
}
