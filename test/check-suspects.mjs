// 核实：可疑会话的 cwd 是否与工作区匹配；workspace.json 何时被改动
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const WS = path.join(DSH_HOME, 'storages', 'workspace.json');
const enc = (s) => encodeURIComponent(String(s ?? ''));

const suspects = [
  'cf007cbf-0328-41ed-99df-61a7ef31e929',
  'ee8e72b9-8a16-42be-912b-861e781ed321',
  '08727c94-27b1-4c12-ae69-59025799c47c',
  '3121f050',
];

const wsRaw = JSON.parse(fs.readFileSync(WS, 'utf8'));
console.log('workspace.json 修改时间:', fs.statSync(WS).mtime.toISOString());
console.log('  工作区 updatedAt:');
for (const [wid, rec] of Object.entries(wsRaw.tables?.workspaces ?? {})) {
  console.log(`    ${rec.title}  updatedAt=${rec.updatedAt}  createdAt=${rec.createdAt}  sessionIds=${(rec.sessionIds ?? []).length}`);
}
console.log('');

for (const full of suspects) {
  const id = full.includes('-') && full.length > 20 ? full : full;
  const short = id.slice(0, 8);
  // 找磁盘上的日志目录
  let logDir = null;
  for (const b of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!b.isDirectory()) continue;
    for (const cand of [id, `session-${id}`]) {
      const p = path.join(SESSIONS, b.name, cand);
      if (fs.existsSync(p)) logDir = p;
    }
  }
  // 投影缓存
  let cwd = null;
  let title = null;
  let cacheName = null;
  for (const cand of [`${id}.json`, `session-${id}.json`]) {
    const f = path.join(PROJ, cand);
    if (fs.existsSync(f)) {
      cacheName = cand;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        cwd = j?.record?.identity?.cwd ?? null;
        title = j?.record?.rows?.title?.val ?? null;
      } catch {}
      break;
    }
  }
  // 是否在账目里
  let inLedger = false;
  for (const rec of Object.values(wsRaw.tables?.workspaces ?? {})) {
    if ((rec.sessionIds ?? []).some((x) => String(x).replace(/^session-/, '') === id)) inLedger = true;
  }
  console.log(`[${short}] ${enc(title)}`);
  console.log(`   日志目录: ${logDir ? '存在' : '缺失'}`);
  console.log(`   缓存文件: ${cacheName ?? '(无)'}   cwd=${cwd ?? '?'}`);
  console.log(`   在账目里: ${inLedger}`);
}
