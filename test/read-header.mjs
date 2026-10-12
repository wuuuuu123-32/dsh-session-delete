// 读会话日志的 header（第一帧），看 DSH 启动时用于校验工作区归属的 cwd
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { scanZstdFrames } from '../lib/zstd-session.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const enc = (s) => encodeURIComponent(String(s ?? ''));

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: node read-header.mjs <sessionId> [...]');
  process.exit(1);
}

function findLog(id) {
  for (const b of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!b.isDirectory()) continue;
    for (const cand of [id, `session-${id}`]) {
      const dir = path.join(SESSIONS, b.name, cand);
      if (!fs.existsSync(dir)) continue;
      const f = fs.readdirSync(dir).find((n) => n.includes('jsonl'));
      if (f) return { file: path.join(dir, f), dir, bucket: b.name, dirName: cand };
    }
  }
  return null;
}

for (const id of ids) {
  const hit = findLog(id);
  console.log(`\n=== ${id.slice(0, 8)} ===`);
  if (!hit) {
    console.log('  日志目录缺失');
    continue;
  }
  console.log(`  目录名(磁盘): ${hit.dirName}`);
  console.log(`  桶: ${hit.bucket}`);

  const bytes = fs.readFileSync(hit.file);
  const { frames } = scanZstdFrames(bytes, 1);
  if (frames.length === 0) {
    console.log('  第一帧读不到');
    continue;
  }
  let line;
  try {
    line = zlib.zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8').trim().split('\n')[0];
  } catch (e) {
    console.log('  第一帧解压失败:', e.message);
    continue;
  }
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    console.log('  第一帧不是 JSON:', enc(line.slice(0, 120)));
    continue;
  }
  const h = ev?.data ?? ev;
  console.log(`  事件类型: ${ev.type}`);
  console.log(`  id: ${h?.id ?? h?.sessionId ?? '?'}`);
  console.log(`  cwd: ${enc(h?.cwd ?? '?')}`);
  console.log(`  createdAt: ${h?.createdAt ?? '?'}`);

  // 对比投影缓存里的 cwd
  for (const cand of [`${id}.json`, `session-${id}.json`]) {
    const f = path.join(PROJ, cand);
    if (fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        console.log(`  投影缓存 cwd: ${enc(j?.record?.identity?.cwd ?? '?')}   (文件 ${cand})`);
      } catch {}
      break;
    }
  }
}
