// 列出所有会话及其产出概况，便于挑选测试对象 / 评估批量删除范围（只读）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSession } from '../lib/scan-session-core.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

const rows = [];
for (const bucket of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!bucket.isDirectory()) continue;
  const bp = path.join(SESSIONS, bucket.name);
  for (const d of fs.readdirSync(bp, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const scan = scanSession({ sessionId: d.name, sessionsRoot: SESSIONS, projCacheDir: PROJ });
      rows.push({
        id: d.name,
        title: scan.title,
        produced: scan.producedTopEntries.length,
        producedBytes: scan.producedBytes,
        recordBytes: scan.recordBytes,
        events: scan.eventCount,
        producedNames: scan.producedTopEntries.map((e) => e.name),
      });
    } catch (e) {
      rows.push({ id: d.name, error: e.message });
    }
  }
}

rows.sort((a, b) => (a.producedBytes ?? 0) - (b.producedBytes ?? 0));

const withProduced = rows.filter((r) => (r.produced ?? 0) > 0);
console.log(`会话总数: ${rows.length}    有产出的: ${withProduced.length}    无产出: ${rows.length - withProduced.length}`);
console.log('\n=== 产出最小的 25 个（适合当测试对象）===');
for (const r of withProduced.slice(0, 25)) {
  console.log(
    `  ${r.id.slice(0, 8)}  ${(r.producedBytes / 1024).toFixed(1).padStart(8)} KiB  ${String(r.produced).padStart(2)} 项  ${(r.title ?? '(无标题)').slice(0, 40)}`
  );
  console.log(`             产出: ${r.producedNames.join(', ').slice(0, 120)}`);
}
