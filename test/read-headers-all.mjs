// 分别读一个会话目录里每个 jsonl 文件的 header（id / cwd），对比 id 形式
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { scanZstdFrames } from '../lib/zstd-session.mjs';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const enc = (s) => encodeURIComponent(String(s ?? ''));

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: node read-headers-all.mjs <sessionId> [...]');
  process.exit(1);
}

function readFirstEvent(file) {
  const bytes = fs.readFileSync(file);
  const { frames } = scanZstdFrames(bytes, 1);
  if (frames.length === 0) return { error: 'no frame' };
  let line;
  try {
    line = zlib.zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8').trim().split('\n')[0];
  } catch (e) {
    return { error: 'decompress: ' + e.message };
  }
  try {
    return { event: JSON.parse(line) };
  } catch {
    return { error: 'not json' };
  }
}

for (const id of ids) {
  console.log(`\n════ ${id.slice(0, 8)} ════`);
  let dir = null;
  for (const b of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!b.isDirectory()) continue;
    for (const cand of [id, `session-${id}`]) {
      const p = path.join(SESSIONS, b.name, cand);
      if (fs.existsSync(p)) dir = p;
    }
  }
  if (!dir) {
    console.log('  目录不存在');
    continue;
  }
  for (const f of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    const r = readFirstEvent(full);
    if (r.error) {
      console.log(`  ${f}  (${st.size} B)  -> ${r.error}`);
      continue;
    }
    const h = r.event?.data ?? r.event;
    console.log(`  ${f}  (${st.size} B, ${st.mtime.toISOString().slice(0, 19)})`);
    console.log(`      事件=${r.event?.type}  header.id=${enc(h?.id)}  cwd=${enc(h?.cwd)}`);
  }
}
