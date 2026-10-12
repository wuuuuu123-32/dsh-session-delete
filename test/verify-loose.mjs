// Verify: workspace-root loose files are no longer treated as deletable output
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSession } from '../lib/scan-session-core.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const enc = (s) => encodeURIComponent(String(s)); // keep output ASCII-safe

let withDirs = 0;
let withLoose = 0;
const dirExamples = [];
const looseExamples = [];

for (const b of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!b.isDirectory()) continue;
  for (const d of fs.readdirSync(path.join(SESSIONS, b.name), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let s;
    try {
      s = scanSession({ sessionId: d.name, sessionsRoot: SESSIONS, projCacheDir: PROJ });
    } catch {
      continue;
    }
    if (s.producedTopEntries.length) {
      withDirs++;
      if (dirExamples.length < 6) dirExamples.push({ id: d.name.slice(0, 8), dirs: s.producedTopEntries.map((e) => enc(e.name)) });
    }
    if (s.producedLooseFiles.length) {
      withLoose++;
      if (looseExamples.length < 6) looseExamples.push({ id: d.name.slice(0, 8), loose: s.producedLooseFiles.map((e) => enc(e.name)) });
    }
  }
}

console.log('sessions with deletable output DIRS :', withDirs);
console.log('sessions with LOOSE root files only :', withLoose);
console.log('\n--- DIR examples (deletable when ticked) ---');
for (const e of dirExamples) console.log(`  ${e.id}  ${e.dirs.join(', ')}`);
console.log('\n--- LOOSE examples (root files, never touched) ---');
for (const e of looseExamples) console.log(`  ${e.id}  ${e.loose.join(', ')}`);

// The specific file the user pointed at must NOT be in any deletable dir set
let foundInDirs = false;
for (const b of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!b.isDirectory()) continue;
  for (const d of fs.readdirSync(path.join(SESSIONS, b.name), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let s;
    try {
      s = scanSession({ sessionId: d.name, sessionsRoot: SESSIONS, projCacheDir: PROJ });
    } catch {
      continue;
    }
    for (const e of s.producedTopEntries) {
      if (e.name.startsWith('升级日志') || e.name === 'AGENTS.md') {
        foundInDirs = true;
        console.log(`\nFAIL: ${enc(e.name)} appears as a deletable output in ${d.name.slice(0, 8)}`);
      }
    }
  }
}
console.log(`\n${foundInDirs ? 'FAIL' : 'OK'}  升级日志.md / AGENTS.md are not in any deletable output set`);
