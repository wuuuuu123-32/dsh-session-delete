// 会话日志读取：多 frame zstd 逐帧解压（DSH 的 session.v<N>.jsonl.zstd 格式）
// 自检用法: node lib/zstd-session.mjs <会话目录 | 日志文件>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ZSTD_MAGIC = 0xfd2fb528;

/** 扫描出每个 zstd frame 的 [start, end)；返回最后一个可能被截断的 frame 起点 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let pos = 0;
  let tornStart = -1;
  while (pos + 4 <= buffer.length) {
    if (buffer.readUInt32LE(pos) !== ZSTD_MAGIC) break;
    let end = pos + 4;
    // Frame_Header_Descriptor
    if (end >= buffer.length) {
      tornStart = pos;
      break;
    }
    const fhd = buffer[end];
    end += 1;
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksumFlag = (fhd >> 2) & 1;
    const dictIdFlag = fhd & 3;
    if (!singleSegment) {
      if (end >= buffer.length) {
        tornStart = pos;
        break;
      }
      end += 1; // Window_Descriptor
    }
    let dictIdSize;
    if (dictIdFlag === 0) dictIdSize = 0;
    else if (dictIdFlag === 1) dictIdSize = 1;
    else if (dictIdFlag === 2) dictIdSize = 2;
    else dictIdSize = 4;
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << (fcsFlag - 1);
    if (end + dictIdSize + fcsSize > buffer.length) {
      tornStart = pos;
      break;
    }
    end += dictIdSize + fcsSize;
    if (end > buffer.length) {
      tornStart = pos;
      break;
    }
    // 逐块推进
    let done = false;
    while (!done) {
      if (end + 3 > buffer.length) {
        tornStart = pos;
        break;
      }
      const blockHeader = buffer[end] | (buffer[end + 1] << 8) | (buffer[end + 2] << 16);
      end += 3;
      const lastBlock = blockHeader & 1;
      const blockType = (blockHeader >> 1) & 3;
      const blockSize = blockHeader >> 3;
      const payload = blockType === 1 ? 1 : blockSize; // RLE 只占 1 字节
      if (end + payload > buffer.length) {
        tornStart = pos;
        break;
      }
      end += payload;
      if (lastBlock) done = true;
    }
    if (tornStart === pos) break;
    if (checksumFlag) {
      if (end + 4 > buffer.length) {
        tornStart = pos;
        break;
      }
      end += 4;
    }
    frames.push({ start: pos, end });
    pos = end;
    if (frames.length >= maxFrames) break;
  }
  if (tornStart === -1) tornStart = pos;
  return { frames, tornStart };
}

/** 逐帧解压，拼成完整文本（跳过损坏的尾部残留帧） */
export function decompressSession(file) {
  const bytes = fs.readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(bytes);
  const parts = [];
  const skipped = [];
  for (const f of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(bytes.subarray(f.start, f.end)));
    } catch (e) {
      skipped.push({ frame: f, error: e.message });
    }
  }
  const text = Buffer.concat(parts).toString('utf8');
  return { text, frameCount: frames.length, skipped, tornStart, totalBytes: bytes.length };
}

/** 解析成事件数组 */
export function readSessionEvents(file) {
  const { text, frameCount, skipped, totalBytes } = decompressSession(file);
  const events = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      bad++;
    }
  }
  return { events, frameCount, skipped, bad, totalBytes };
}

// 直接运行时做自检
// ❗ 入口判断必须比较解析后的完整路径：用 endsWith('xxx.mjs') 会被同后缀的
//    文件（如 diag-xxx.mjs）误命中，import 它的时候主逻辑跟着跑，很难查。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: node lib/zstd-session.mjs <会话目录|日志文件>');
    process.exit(1);
  }
  let file = arg;
  if (fs.statSync(arg).isDirectory()) {
    // 日志文件名带版本号（0.2.x 是 v4），不要写死
    const hit = fs.readdirSync(arg).find((n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n));
    if (!hit) {
      console.error(`目录里没有会话日志: ${arg}`);
      process.exit(1);
    }
    file = path.join(arg, hit);
  }
  const r = readSessionEvents(file);
  console.log(`文件: ${file}`);
  console.log(`压缩 ${(r.totalBytes / 1024).toFixed(1)} KiB -> ${r.events.length} 个事件, ${r.frameCount} frame, 坏行 ${r.bad}, 跳过 frame ${r.skipped.length}`);
  const types = new Map();
  for (const e of r.events) types.set(e.type, (types.get(e.type) ?? 0) + 1);
  console.log('--- 事件类型 top 15 ---');
  for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${t}: ${n}`);
}
