// 列出回收站内容 —— 用来确认「删除的东西真的可恢复」。
//
// 为什么不问 Shell.Application：沙箱令牌下 Namespace(10) 看不到回收站内容
// （实测项目数为 0，但 $I 记录明明在）。直接解析每个盘的
//   <盘>:\$Recycle.Bin\<SID>\$I*     （每个已删除项一条，记着原始路径）
// 更可靠，且不需要 COM。
import fs from 'node:fs';
import path from 'node:path';
import { getCurrentUserSid } from './recycle.mjs';

/** 解析一条 $I 记录：8B header + 8B size + 8B 时间 + 4B 路径长度 + UTF-16 路径 */
function parseDollarI(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (bytes.length < 28) return null;
  const version = bytes.readBigUInt64LE(0);
  const size = Number(bytes.readBigUInt64LE(8));
  const fileTime = bytes.readBigUInt64LE(16);
  const pathLen = bytes.readInt32LE(24);
  if (pathLen <= 0 || 28 + pathLen * 2 > bytes.length + 2) return null;
  let originalPath = '?';
  try {
    originalPath = bytes.toString('utf16le', 28, 28 + pathLen * 2 - 2);
  } catch {
    /* 路径读不出来时保持占位 */
  }
  // Windows FILETIME -> JS Date
  let deletedAt = null;
  try {
    if (fileTime > 0n) deletedAt = new Date(Number(fileTime / 10000n) - 11644473600000);
  } catch {
    /* 忽略 */
  }
  return { version: Number(version), size, deletedAt, originalPath, metaFile: file };
}

/**
 * 列出回收站里的项。
 * @param {string} [filter] 只返回原始路径包含该串的项
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多返回多少条（默认 100）
 */
export function listRecycleBin(filter, opts = {}) {
  const limit = opts.limit ?? 100;
  const sid = getCurrentUserSid();
  const rows = [];

  // 枚举所有存在的盘
  const drives = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch {
      /* 忽略不可访问的盘 */
    }
  }

  for (const root of drives) {
    const binDir = sid ? path.join(root, '$Recycle.Bin', sid) : null;
    if (!binDir || !fs.existsSync(binDir)) continue;
    let names;
    try {
      names = fs.readdirSync(binDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('$I')) continue;
      const parsed = parseDollarI(path.join(binDir, name));
      if (!parsed) continue;
      rows.push({ ...parsed, drive: root });
    }
  }

  rows.sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0));

  let filtered = rows;
  if (filter) {
    const f = String(filter).toLowerCase();
    filtered = rows.filter((r) => r.originalPath.toLowerCase().includes(f));
  }

  return { total: rows.length, rows: filtered.slice(0, limit), sid };
}

const entry = process.argv[1] ?? '';
if (path.basename(entry) === 'list-recycle-bin.mjs') {
  const filter = process.argv[2];
  const { total, rows, sid } = listRecycleBin(filter);
  console.log(`SID: ${sid ?? '(取不到)'}`);
  console.log(`回收站总项数: ${total}${filter ? `   匹配 "${filter}": ${rows.length}` : ''}`);
  for (const row of rows) {
    const when = row.deletedAt ? row.deletedAt.toLocaleString('zh-CN', { hour12: false }) : '?';
    console.log(`  [${when}] ${(row.size / 1024).toFixed(1)} KiB  ${row.originalPath}`);
  }
}
