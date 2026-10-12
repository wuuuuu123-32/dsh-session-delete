// Verify: scanSession finds BOTH proj-cache filename spellings (session-<uuid> and <uuid>)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSession } from '../lib/scan-session-core.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const projCacheDir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const sessionsRoot = path.join(DSH_HOME, 'sessions');

const names = fs.readdirSync(projCacheDir).filter((n) => n.endsWith('.json'));
const prefixed = names.filter((n) => n.startsWith('session-'));
const bare = names.filter((n) => !n.startsWith('session-'));
console.log(`proj-cache files: total=${names.length} prefixed=${prefixed.length} bare=${bare.length}`);

for (const [label, sample] of [
  ['prefixed', prefixed[0]],
  ['bare', bare[0]],
]) {
  if (!sample) {
    console.log(`\n[${label}] no sample`);
    continue;
  }
  const id = sample.replace(/\.json$/, '');
  const s = scanSession({ sessionId: id, sessionsRoot, projCacheDir });
  const jsonRecords = s.records.filter((r) => r.endsWith('.json'));
  const found = jsonRecords.length > 0;
  console.log(`\n[${label}] id=${id}`);
  console.log(`  records=${s.records.length}  jsonRecords=${jsonRecords.length}  -> ${found ? 'OK found cache' : 'FAIL cache missing'}`);
  for (const r of s.records) console.log(`    - ${r}`);
  console.log(`  title=${s.title ?? '(none)'}  events=${s.eventCount}`);
}
