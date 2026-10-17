// 会话痕迹扫描：找出某个会话在磁盘上留下了什么、以及它在工作区里产出了什么。
//
// 「产出」的判定复刻 DSH 自己的 turn-deliverables 规则：只认**成功的**写文件类
// 工具调用（write / edit / str_replace_editor / present），失败的调用不算产出。
//
// 写入有两个入口，都必须扫（2026-10-15 补，与 dsh-open-artifacts 同源）：
//   · tool/call         —— 模型直接调 write / edit
//   · tool/ptc-dispatch —— run_code（PTC 模式）里调 tools.write / tools.edit
// 漏掉后者会让「整场对话都走 run_code 写文件」的会话被算成零产出，
// 删会话时它的产出目录就不会被列进清单（PTC 模式的会话几乎都是这种）。
import fs from 'node:fs';
import path from 'node:path';
import { readSessionEvents } from './zstd-session.mjs';

/** 路径比较用的规范化（Windows 不区分大小写） */
const normCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** 判定目录归属时最多枚举多少个文件；超过就当「无法证明专属」，一律不删 */
const MAX_SCAN_FILES = 20000;

/**
 * 递归列出目录下的普通文件（不跟随符号链接，避免跑到 cwd 以外）。
 * 超上限就停下并标 truncated —— 此时绝不当成专属目录。
 */
function listFilesUnder(root, cap) {
  const files = [];
  let totalBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      files.push({ path: full, size });
      totalBytes += size;
      if (files.length >= cap) return { files, totalBytes, truncated: true };
    }
  }
  return { files, totalBytes, truncated: false };
}

/** 会话 id 规范化：投影缓存/日程里可能带 session- 前缀，磁盘目录不带 */
export function bareSessionId(id) {
  return String(id).replace(/^session-/, '');
}

/** 会话 id 的两种拼写都清（不同存储可能用不同形式） */
export function sessionIdVariants(id) {
  const bare = bareSessionId(id);
  return [bare, `session-${bare}`];
}

/** 已知的会话日志文件名，按优先级（0.2.x 用 v4，旧版是 v3） */
const LOG_NAMES = [
  'session.v4.jsonl.zstd',
  'session.v4.jsonl',
  'session.v3.jsonl.zstd',
  'session.v3.jsonl',
  'session.jsonl.zstd',
  'session.jsonl',
];

/**
 * 在 sessions/<bucket>/<id>/ 里找会话日志。
 * bucket 名是**有损编码**（无法从 id 反推），所以必须遍历所有 bucket。
 * @returns {{file: string, dir: string, bucket: string}|null}
 */
export function findSessionLog(sessionsRoot, id) {
  const variants = sessionIdVariants(id);
  let buckets = [];
  try {
    buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  for (const bucket of buckets) {
    for (const variant of variants) {
      // 目录名必须**恰好**等于 id（转义后），避免前缀误匹配到别的会话
      const dir = path.join(sessionsRoot, bucket, variant);
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const name of LOG_NAMES) {
        const f = path.join(dir, name);
        if (fs.existsSync(f)) return { file: f, dir, bucket };
      }
      // 兜底：目录里的任意 session.*jsonl
      const found = fs.readdirSync(dir).find((n) => n.startsWith('session.') && n.includes('jsonl'));
      if (found) return { file: path.join(dir, found), dir, bucket };
      return { file: null, dir, bucket }; // 目录在但没有日志
    }
  }
  return null;
}

/** DSH 规则：从一次成功的工具调用里取出「它写了哪个文件」 */
export function producedPathFromCall(name, args) {
  if (typeof args !== 'object' || args === null) return null;
  const p = (v) => (typeof v === 'string' && v.trim().length > 0 ? v : null);
  switch (name) {
    case 'write':
      return typeof args.content === 'string' ? p(args.file_path) : null;
    case 'edit':
      return typeof args.old_string === 'string' ? p(args.file_path) : null;
    case 'str_replace_editor':
    case 'str-replace-editor': {
      const file = p(args.path);
      if (!file) return null;
      if (args.command === 'create') return typeof args.file_text === 'string' ? file : null;
      if (args.command === 'str_replace') return typeof args.old_str === 'string' ? file : null;
      if (args.command === 'insert') return typeof args.new_str === 'string' ? file : null;
      return null;
    }
    default:
      return null;
  }
}

/**
 * 从一次工具调用里取出它写出的**所有**文件。
 * 单数版只管 write / edit / str_replace_editor；这里再补上 present ——
 * 它是「声明交付物」，一次能报好几个（与 dsh-open-artifacts 保持同源）。
 * @returns {string[]}
 */
export function producedPathsFromCall(name, args) {
  const single = producedPathFromCall(name, args);
  if (single) return [single];
  if (name === 'present' && args && typeof args === 'object' && Array.isArray(args.files)) {
    const out = [];
    for (const f of args.files) {
      const p = f && typeof f.path === 'string' ? f.path.trim() : '';
      if (p) out.push(p);
    }
    return out;
  }
  return [];
}

/**
 * 从一组会话事件里推导产出路径（去重、保持首见顺序、跳过失败的调用）。
 *
 * 要扫**两种**事件，因为写入有两个入口：
 *   · tool/call         —— 模型直接调 write / edit（失败靠 tool/result 里的 isError 标记）
 *   · tool/ptc-dispatch —— run_code（PTC 模式）在程序里调 tools.write / tools.edit，
 *                          子进程里的调用不会产生 tool/call 事件，只有这一条，
 *                          而且它自带 isError（2026-10-15 补：漏掉它会导致
 *                          「整场对话都走 run_code 写文件」的会话被算成零产出）。
 * @returns {string[]}
 */
export function producedPathsFromEvents(events) {
  // 先收集失败的 callId
  const failed = new Set();
  for (const e of events) {
    if (e?.type !== 'tool/result') continue;
    const content = e.data?.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool-result' && c.isError === true && c.toolCallId) failed.add(c.toolCallId);
      }
    }
    if (e.data?.error && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool-result' && c.toolCallId) failed.add(c.toolCallId);
    }
  }
  const seen = new Set();
  const out = [];
  const push = (list) => {
    for (const p of list) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  };
  const parseArgs = (raw) => {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  for (const e of events) {
    if (!e) continue;
    if (e.type === 'tool/call') {
      const callId = e.data?.callId;
      if (callId && failed.has(callId)) continue;
      push(producedPathsFromCall(e.data?.name, parseArgs(e.data?.arguments)));
      continue;
    }
    if (e.type === 'tool/ptc-dispatch') {
      if (e.data?.isError === true) continue;
      push(producedPathsFromCall(e.data?.name, parseArgs(e.data?.arguments)));
    }
  }
  return out;
}

/** 目录/文件大小（字节）；出错返回 0 */
export function sizeOf(target) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const child = path.join(target, e.name);
    if (e.isDirectory()) total += sizeOf(child);
    else if (e.isFile()) {
      try {
        total += fs.statSync(child).size;
      } catch {
        /* 忽略读不到的项 */
      }
    }
  }
  return total;
}

/**
 * 扫描一个会话：要清理的记录、以及它在工作区里产出的顶层条目。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.sessionsRoot   ~/.dsh/sessions
 * @param {string} [opts.projCacheDir] ~/.dsh/storages/session_projcache/sessions
 * @param {string} [opts.cwd]          会话工作目录（缺省时尝试从投影缓存推断）
 * @param {string} [opts.title]
 * @param {object} [opts.storage]      可选：{ getProjCacheRow, listWorkspaceSessionIds }
 */
export function scanSession(opts) {
  const { sessionId, sessionsRoot, projCacheDir, storage } = opts;
  const bare = bareSessionId(sessionId);

  // 1) 投影缓存里的元数据（标题 / cwd）——权威来源
  let metaCwd = opts.cwd ?? null;
  let metaTitle = opts.title ?? null;
  let metaCreatedAt = null;
  // 缓存的文件名有两种拼写：侧边栏会话用 `session-<uuid>.json`，子代理会话用 `<uuid>.json`。
  // 只找裸 uuid 会漏掉前者 —— 那样它的缓存就进不了回收站（踩过）。
  const projFileCandidates = projCacheDir
    ? sessionIdVariants(bare).map((v) => path.join(projCacheDir, `${v}.json`))
    : [];
  const projFile = projFileCandidates.find((f) => fs.existsSync(f)) ?? projFileCandidates[0] ?? null;
  if (!metaCwd || !metaTitle) {
    if (storage && typeof storage.getProjCacheRow === 'function') {
      const row = storage.getProjCacheRow(bare);
      if (row) {
        metaCwd = metaCwd ?? row?.identity?.cwd ?? null;
        metaTitle = metaTitle ?? row?.rows?.title?.val ?? null;
        metaCreatedAt = row?.identity?.createdAt ?? null;
      }
    }
    if ((!metaCwd || !metaTitle) && projFile && fs.existsSync(projFile)) {
      try {
        const j = JSON.parse(fs.readFileSync(projFile, 'utf8'));
        const rec = j?.record ?? {};
        metaCwd = metaCwd ?? rec?.identity?.cwd ?? null;
        metaTitle = metaTitle ?? rec?.rows?.title?.val ?? null;
        metaCreatedAt = rec?.identity?.createdAt ?? null;
      } catch {
        /* 缓存坏了不影响删除 */
      }
    }
  }

  const result = {
    sessionId: bare,
    title: metaTitle,
    cwd: metaCwd,
    createdAt: metaCreatedAt,
    records: [], // 会话记录类路径（会移入回收站）
    producedPaths: [], // 这个会话写过的所有文件路径（工作区内）
    producedTopEntries: [], // 产出在 cwd 下的**专属子目录**（可移入回收站）
    producedSharedDirs: [], // 部分命中的目录（不是整棵都归这个会话）：只提示不删
  producedLooseFiles: [], // cwd 根目录下的散文件：很可能是公用资产，只提示不动
    recordBytes: 0,
    producedBytes: 0,
    looseBytes: 0,
    errors: [],
    eventCount: 0,
  };

  // 2) 会话日志目录
  const log = findSessionLog(sessionsRoot, sessionId);
  if (log) {
    result.records.push(log.dir);
    if (log.file) {
      try {
        const { events } = readSessionEvents(log.file);
        result.eventCount = events.length;
        result.producedPaths = producedPathsFromEvents(events);
      } catch (err) {
        result.errors.push(`读取会话日志失败：${err.message}`);
      }
    }
  } else {
    result.errors.push('找不到会话日志目录');
  }

  // 3) 投影缓存文件（磁盘上的那份）
  if (projFile && fs.existsSync(projFile)) result.records.push(projFile);

  // 4) 记录占用
  for (const r of result.records) result.recordBytes += sizeOf(r);

  // 5) 产出路径 -> cwd 下的顶层条目
  //
  // ⚠️ 只有「专属目录」才算可删产出：该目录下的**每一个文件**都在本会话的 producedPaths 里。
  // 判据是目录内容的实际清单，不是「路径里带没带分隔符」—— 旧实现只看 rel.includes(path.sep)，
  // 于是「会话往公用目录里写了一个文件」（例如 D:/dsh/config/_hooks/x.ps1）会被当成
  // 「整个 _hooks 目录都归它」，删会话时把公用目录整棵移进回收站（2026-10-17 盲审的 P0）。
  //
  // 部分命中的目录放进 producedSharedDirs：只提示「其中 N 个文件属于本会话」，永不删除。
  // 根目录下的散文件（升级日志.md、AGENTS.md 等跨会话公用脚本）同样只提示、不动。
  if (metaCwd) {
    const classified = classifyProduced(metaCwd, result.producedPaths);
    result.producedTopEntries = classified.topEntries;
    result.producedSharedDirs = classified.sharedDirs;
    result.producedLooseFiles = classified.looseFiles;
    result.producedBytes = classified.producedBytes;
    result.sharedBytes = classified.sharedBytes;
    result.looseBytes = classified.looseBytes;
  }
  return result;
}

/**
 * 把「这个会话写过的路径」归类成三种顶层条目（导出以便单测）。
 *
 * - topEntries：**专属目录** —— 目录下每一个文件都是这个会话写的，可以整棵移走
 * - sharedDirs：**部分命中的目录** —— 目录是公用的，只提示「其中 N 个文件属于本会话」，永不删除
 * - looseFiles：cwd 根目录下的散文件 —— 跨会话公用的资产，永不删除
 *
 * 判据是目录内容的真实清单，不是路径里有没有分隔符：旧实现用 rel.includes(path.sep)
 * 就认定「整个顶层目录都是它的产出」，会话往 _hooks 里写一个脚本 → 删会话时整个 _hooks 被移进回收站。
 */
export function classifyProduced(cwd, producedPaths) {
  const cwdResolved = path.resolve(cwd);
  const producedAbs = new Set();
  const inCwd = [];
  for (const p of producedPaths ?? []) {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwdResolved, p);
    const rel = path.relative(cwdResolved, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    producedAbs.add(normCase(abs));
    inCwd.push({ abs, rel });
  }

  const byTop = new Map();
  const loose = new Map();
  for (const { rel } of inCwd) {
    const seg = rel.split(path.sep)[0];
    const absTop = path.join(cwdResolved, seg);
    if (path.resolve(absTop) === cwdResolved) continue;

    let isDir = false;
    try {
      isDir = fs.statSync(absTop).isDirectory();
    } catch {
      isDir = false;
    }

    if (!isDir) {
      if (!loose.has(absTop)) loose.set(absTop, { name: seg, path: absTop, fileCount: 0, bytes: 0, files: [] });
      const entry = loose.get(absTop);
      entry.files.push(rel);
      entry.fileCount = entry.files.length;
      continue;
    }

    if (!byTop.has(absTop)) byTop.set(absTop, { name: seg, path: absTop, rels: [] });
    byTop.get(absTop).rels.push(rel);
  }

  const topEntries = [];
  const sharedDirs = [];
  for (const [absTop, info] of byTop) {
    const listing = listFilesUnder(absTop, MAX_SCAN_FILES);
    if (listing.files.length === 0) continue; // 空目录：没有可删内容
    let hitCount = 0;
    let hitBytes = 0;
    for (const f of listing.files) {
      if (producedAbs.has(normCase(f.path))) {
        hitCount += 1;
        hitBytes += f.size;
      }
    }
    const base = {
      name: info.name,
      path: info.path,
      isDir: true,
      fileCount: hitCount,
      producedFileCount: hitCount,
      totalFileCount: listing.files.length,
      bytes: hitBytes,
      totalBytes: listing.totalBytes,
      files: info.rels,
    };
    const exclusive = !listing.truncated && hitCount === listing.files.length;
    if (exclusive) {
      base.exclusive = true;
      base.bytes = listing.totalBytes;
      topEntries.push(base);
    } else {
      base.exclusive = false;
      sharedDirs.push(base);
    }
  }

  for (const entry of loose.values()) entry.bytes = sizeOf(entry.path);
  const looseFiles = [...loose.values()];
  return {
    topEntries,
    sharedDirs,
    looseFiles,
    producedBytes: topEntries.reduce((sum, e) => sum + e.bytes, 0),
    sharedBytes: sharedDirs.reduce((sum, e) => sum + e.bytes, 0),
    looseBytes: looseFiles.reduce((sum, e) => sum + e.bytes, 0),
  };
}
