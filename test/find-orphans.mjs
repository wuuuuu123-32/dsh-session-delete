// 找出「不在工作区账目里」的会话，并判断它们是不是会出现为"未分组"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const enc = (s) => encodeURIComponent(String(s ?? ''));

const wsRaw = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'));
const bare = (id) => String(id).replace(/^session-/, '');

const inSidebar = new Set();
for (const [wid, rec] of Object.entries(wsRaw.tables?.workspaces ?? {})) {
  for (const id of rec.sessionIds ?? []) inSidebar.add(bare(id));
}

const onDisk = [];
for (const b of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!b.isDirectory()) continue;
  for (const d of fs.readdirSync(path.join(SESSIONS, b.name), { withFileTypes: true })) {
    if (d.isDirectory()) onDisk.push({ id: bare(d.name), raw: d.name, bucket: b.name });
  }
}

const cacheNames = new Set(fs.readdirSync(PROJ));
const hasCache = (id) => cacheNames.has(`${id}.json`) || cacheNames.has(`session-${id}.json`);

function titleOf(id) {
  for (const key of [id, `session-${id}`]) {
    const f = path.join(PROJ, `${key}.json`);
    if (fs.existsSync(f)) {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'))?.record?.rows?.title?.val ?? null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

console.log(`磁盘会话 ${onDisk.length} 个   账目里 ${inSidebar.size} 个`);
console.log(`带投影缓存的磁盘会话 ${onDisk.filter((s) => hasCache(s.id)).length} 个\n`);

const orphans = onDisk.filter((s) => !inSidebar.has(s.id));
const orphansWithCache = orphans.filter((s) => hasCache(s.id));
const orphansNoCache = orphans.filter((s) => !hasCache(s.id));

console.log(`不在账目: ${orphans.length} 个（有缓存 ${orphansWithCache.length} / 无缓存 ${orphansNoCache.length}）\n`);

// 分类标题：子代理类 vs 像是正常对话
const SUBAGENT_HINTS = ['你要访问', '你是', '任务', '访问这个', '调研', '请用你', '下面'];
function looksSubagent(title) {
  if (!title) return false;
  return SUBAGENT_HINTS.some((h) => title.includes(h));
}

console.log('=== 不在账目、有缓存、且标题不像子代理的（这些最可能是侧边栏「未分组」）===');
for (const s of orphansWithCache) {
  const t = titleOf(s.id);
  if (looksSubagent(t)) continue;
  console.log(`  ${s.id.slice(0, 8)}  [${s.bucket}]  ${enc(t)}`);
}

console.log('\n=== 不在账目、有缓存、标题像子代理的（前 12 个）===');
let n = 0;
for (const s of orphansWithCache) {
  const t = titleOf(s.id);
  if (!looksSubagent(t)) continue;
  if (n++ >= 12) break;
  console.log(`  ${s.id.slice(0, 8)}  ${enc(t)}`);
}

console.log('\n=== 不在账目、连投影缓存都没有的（前 12 个）===');
for (const s of orphansNoCache.slice(0, 12)) {
  console.log(`  ${s.id.slice(0, 8)}  [${s.bucket}]  raw=${s.raw}`);
}
