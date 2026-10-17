// dsh-session-delete（Host 半边）
//
// 在会话列表的「⋯」菜单里提供「删除会话」，支持单选与批量。
// 与官方「归档」的区别：这是真的把会话从磁盘上移除，但**移入回收站**而不是永久删除，
// 误删可以从回收站恢复。
//
// 删除顺序（顺序很重要，错了会留下「未分组」幽灵行）：
//   1. 运行中的会话直接拒绝（`ctx.agents.get(id)?.status === 'running'`）
//   2. 扫描产出，先算清楚这次要动哪些东西（给确认框用）
//   3. flush 活动会话，避免 dispose 阶段回写日志
//   4. 会话日志目录 + 投影缓存文件 → 回收站
//   5. 确认日志目录真的没了，再摘工作区记账（`workspaceRegistry` / storageDomain）
//   6. `ctx.emit('api-session/removed', id)` 让列表行当场消失（**不能重拉列表**）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { scanSession, bareSessionId, sessionIdVariants, findSessionLog } from './scan-session-core.mjs';
import { recyclePaths, checkRecycleAvailable } from './recycle.mjs';

// 回收站能力探测带 TTL 缓存：探测本身要在临时目录建个目录再回收，
// 每点一次菜单就探一次会在回收站里堆空目录。删除时的真实验证不受影响。
let recycleProbe = { at: 0, value: null };
function recycleAvailable() {
  const now = Date.now();
  if (recycleProbe.value !== null && now - recycleProbe.at < 30000) return recycleProbe.value;
  const value = checkRecycleAvailable();
  recycleProbe = { at: now, value };
  return value;
}

export const name = 'session-delete';
// 不声明任何必需服务：webServer 是可选的（有就注册 HTTP 路由，没有就等），
// 通过 ctx.get() 惰性访问。声明 inject 会让插件等那个服务就绪才加载 ——
// 本插件不需要任何服务才能起来，声明了反而可能在缺服务的 profile 上永远等下去。
export const inject = [];

const ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class DeleteError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}
function projCacheDir() {
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
}

// --- storageDomain：让内存态与磁盘保持一致 -------------------------------------

function projTable(ctx) {
  try {
    const sd = ctx.get('storageDomain');
    if (!sd || typeof sd.get !== 'function') return null;
    const domain = sd.get('session_projcache');
    if (!domain || typeof domain.table !== 'function') return null;
    return domain.table('sessions');
  } catch {
    return null;
  }
}

function workspaceDomain(ctx) {
  try {
    const sd = ctx.get('storageDomain');
    if (!sd || typeof sd.get !== 'function') return null;
    return sd.get('workspace') ?? null;
  } catch {
    return null;
  }
}

/** 读投影缓存行（内存态优先，失败再读磁盘） */
function readProjRow(ctx, id) {
  const table = projTable(ctx);
  if (table) {
    for (const v of sessionIdVariants(id)) {
      try {
        const row = table.get(v);
        if (row) return row;
      } catch {
        /* 表可能未打开 */
      }
    }
  }
  const file = path.join(projCacheDir(), `${bareSessionId(id)}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.record ?? null;
  } catch {
    return null;
  }
}

/** 删投影缓存行（内存 + 磁盘） */
async function stripProjCache(ctx, id) {
  const table = projTable(ctx);
  let removed = false;
  if (table) {
    for (const v of sessionIdVariants(id)) {
      try {
        if (table.get(v) !== undefined) {
          await table.delete(v);
          removed = true;
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  // 磁盘上的那份单独处理（可能内存态里已经没有）
  const file = path.join(projCacheDir(), `${bareSessionId(id)}.json`);
  if (fs.existsSync(file)) removed = true;
  return { removed, projFile: fs.existsSync(file) ? file : null };
}

/**
 * 摘掉工作区记账 —— **只走 storageDomain 精确移除目标 id**。
 *
 * 刻意**不**调用 `workspaceRegistry.detachSession()`：它会触发该工作区的
 * `mutate()`，而 mutate 会拿 `sessionPath(id)` 重新过滤**整个** `sessionIds` 数组，
 * 顺带把别的"临时查不到归属"的会话一起踢出账目（2026-09-30 实测踩到：
 * 删除一个会话后，另外三个数据文件处于 v3/v4 双代际、`sessionPath` 一时查不到的
 * 会话被一起踢成了「未分组」）。storageDomain 的写入是同一个 domain，
 * 所以注册表读到的仍是同一份表，但不会触发那轮全量过滤。
 */
async function detachFromWorkspace(ctx, id) {
  const variants = new Set(sessionIdVariants(id));
  let done = false;

  const ws = workspaceDomain(ctx);
  if (ws) {
    try {
      const table = typeof ws.table === 'function' ? ws.table('workspaces') : null;
      if (table && typeof table.entries === 'function') {
        for (const [wid, rec] of table.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.some((x) => variants.has(x))) {
            await table.put(wid, { ...rec, sessionIds: rec.sessionIds.filter((x) => !variants.has(x)) });
            done = true;
          }
        }
      }
      const g = ws.global;
      if (g && typeof g.get === 'function' && typeof g.set === 'function') {
        const state = g.get();
        if (state && Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.some((x) => variants.has(x))) {
          await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.has(x)) });
          done = true;
        }
      }
    } catch {
      /* 忽略 */
    }
  }
  return done;
}

// --- 活动会话处理 ---------------------------------------------------------------

function agentOf(ctx, id) {
  const agents = ctx.get('agents');
  if (!agents || typeof agents.get !== 'function') return null;
  try {
    return agents.get(bareSessionId(id)) ?? agents.get(id) ?? null;
  } catch {
    return null;
  }
}

function isRunning(ctx, id) {
  const agent = agentOf(ctx, id);
  return !!(agent && agent.status === 'running');
}

/** flush 活动会话，避免 dispose 阶段回写重建日志 */
async function flushIfLive(ctx, id) {
  const sessions = ctx.get('sessions');
  if (!sessions || typeof sessions.get !== 'function') return false;
  let flushed = false;
  for (const v of sessionIdVariants(id)) {
    let session;
    try {
      session = sessions.get(v);
    } catch {
      continue;
    }
    if (!session) continue;
    try {
      if (typeof sessions.flush === 'function') {
        await sessions.flush(session);
        flushed = true;
      }
    } catch {
      /* 忽略：删除照常进行 */
    }
  }
  return flushed;
}

/** 把会话从内存 store 里摘掉（没有公开 API，用 store 自己的路径） */
function detachLive(ctx, id) {
  const sessions = ctx.get('sessions');
  if (!sessions) return false;
  let detached = false;
  try {
    const store = sessions.store;
    for (const v of sessionIdVariants(id)) {
      const entry = store && typeof store.get === 'function' ? store.get(v) : undefined;
      if (entry === undefined) continue;
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry);
        detached = true;
      } else if (store && typeof store.delete === 'function') {
        store.delete(v);
        detached = true;
      }
    }
  } catch {
    /* 忽略 */
  }
  return detached;
}

// --- 扫描 ----------------------------------------------------------------------

/** 给一个会话做完整扫描（确认框用） */
function scanOne(ctx, id) {
  const row = readProjRow(ctx, id);
  return scanSession({
    sessionId: id,
    sessionsRoot: sessionsRoot(),
    projCacheDir: projCacheDir(),
    cwd: row?.identity?.cwd ?? null,
    title: row?.rows?.title?.val ?? null,
    storage: null,
  });
}

// --- 删除 ----------------------------------------------------------------------

/**
 * 删除一个会话。默认把记录与产出**移入回收站**；`permanent: true` 时永久删除。
 * @param {object} ctx cordis 上下文
 * @param {string} id 会话 id（uuid 或 session-<uuid>）
 * @param {object} opts { deleteProduced?: boolean, permanent?: boolean, allowRunning?: boolean }
 */
async function deleteOne(ctx, id, opts = {}) {
  const bare = bareSessionId(id);
  if (!ID_RE.test(id) && !ID_RE.test(bare)) throw new DeleteError(`会话 id 不合法：${id}`, 400);
  if (isRunning(ctx, id) && !opts.allowRunning) {
    throw new DeleteError('这个会话正在运行，不能删除（先等它结束，或中断当前回合）', 409);
  }

  const scan = scanOne(ctx, id);
  const result = {
    sessionId: bare,
    title: scan.title,
    cwd: scan.cwd,
    // 回收站结果
    recycled: [],
    failed: [],
    // 产出
    producedRequested: opts.deleteProduced === true,
    producedPermanentlyDeleted: [],
    producedErrors: [],
    producedBytes: scan.producedBytes,
    recordBytes: scan.recordBytes,
    // 记账
    workspaceDetached: false,
    projRemoved: false,
    removedSignal: false,
  };

  if (!scan.records.length && !scan.producedPaths.length) {
    // 记录和产出都没有：可能 id 不存在
    if (!scan.eventCount && !scan.errors.length) throw new DeleteError(`找不到会话：${bare}`, 404);
  }

  // 3) flush 活动会话
  await flushIfLive(ctx, id);
  detachLive(ctx, id);

  // 4) 记录 → 回收站
  //    如果回收站不可用（受限权限/关闭了回收站），recyclePaths 会**拒绝**而不是
  //    悄悄永久删除 —— 宁可删不掉，也不能让"可恢复"变成谎话。
  const targets = [...new Set(scan.records.filter(Boolean))];
  if (targets.length) {
    if (opts.permanent) {
      for (const t of targets) {
        try {
          fs.rmSync(t, { recursive: true, force: true });
          result.recycled.push(t);
        } catch (e) {
          result.failed.push({ path: t, error: e.message });
        }
      }
    } else {
      const r = recyclePaths(targets);
      result.recycled.push(...r.ok, ...r.skipped);
      result.failed.push(...r.failed);
    }
    if (result.failed.length > 0) {
      // ❗不能一律说「没有删除任何东西」：失败发生在记录逐个入回收站的过程中，
      // 前面的目标可能已经成功移走了（旧文案在这里是假的，用户会以为回收站里没有东西）。
      const first = result.failed[0].error;
      const done = result.recycled.length + result.producedPermanentlyDeleted.length;
      const head =
        result.failed.length === targets.length
          ? '没能把会话记录移入回收站，已中止'
          : `有 ${result.failed.length} 项没能移入回收站，已中止`;
      const middle =
        done > 0
          ? `注意：此前已有 ${done} 项成功移入回收站，可以从回收站还原。`
          : '本次没有任何项目被移动。';
      throw new DeleteError(
        `${head}。${middle}\n首个错误：${first}\n` +
          '如果反复出现，说明当前 DSH 进程的权限下 Windows 回收站不可用。',
        503
      );
    }
  }

  // 5) 确认日志目录真的没了
  const stillThere = findSessionLog(sessionsRoot(), id);
  if (stillThere) {
    throw new DeleteError(`会话文件没能清掉：${stillThere.dir}`, 500);
  }

  // 6) 投影缓存 + 工作区记账
  const proj = await stripProjCache(ctx, id);
  result.projRemoved = proj.removed;
  result.workspaceDetached = await detachFromWorkspace(ctx, id);

  // 7) 产出 → 回收站（只有显式要求才动）
  if (opts.deleteProduced && scan.producedTopEntries.length) {
    // 只移走 exclusive 目录（整棵都归这个会话）。部分命中的目录在 scan 阶段就没进这个数组，
    // 这里再兜一次底：万一有非 exclusive 混进来，直接跳过并记一笔，绝不动手。
    const producedTargets = scan.producedTopEntries.filter((e) => e.exclusive !== false).map((e) => e.path);
    const undeletable = scan.producedTopEntries.filter((e) => e.exclusive === false).map((e) => e.path);
    const r = recyclePaths(producedTargets);
    result.producedPermanentlyDeleted = [...r.ok, ...r.skipped];
    result.producedErrors = r.failed;
    result.producedSkippedShared = undeletable;
  }
  result.producedSharedKept = (scan.producedSharedDirs ?? []).map((e) => e.path);

  // 8) 通知客户端让行消失
  if (result.workspaceDetached || result.projRemoved || result.recycled.length) {
    try {
      ctx.emit('api-session/removed', bare);
      result.removedSignal = true;
    } catch {
      /* 事件不存在时忽略 */
    }
  }

  return result;
}

// --- HTTP ----------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => {
      data += d;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

/** 只接受回环地址，避免局域网/远程会话被删除 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

/** 会话列表（供客户端把侧栏行的标题映射到 id） */
function listSessions(ctx) {
  const out = [];
  const table = projTable(ctx);
  if (table && typeof table.entries === 'function') {
    try {
      for (const [id, rec] of table.entries()) {
        const rows = rec && typeof rec === 'object' && rec.rows ? rec.rows : {};
        out.push({
          sessionId: bareSessionId(id),
          title: typeof rows.title?.val === 'string' ? rows.title.val : null,
          createdAt: typeof rec?.identity?.createdAt === 'number' ? rec.identity.createdAt : null,
          cwd: rec?.identity?.cwd ?? null,
          running: isRunning(ctx, id),
        });
      }
    } catch {
      /* 表未打开 */
    }
  }

  // 按**侧边栏的顺序**排（用户看到的顺序），而不是投影缓存表的自然顺序。
  // 侧边栏顺序就是 workspace.json 里 DSH 自己维护的 `sessionIds` 数组顺序
  // （它也是 `insertSessionBefore` 那个 API 维护的顺序），所以直接照抄。
  const order = sidebarOrder(ctx);
  const has = (id) => order.has(id);
  for (const row of out) row.inSidebar = has(row.sessionId);
  out.sort((a, b) => {
    const ia = has(a.sessionId) ? order.get(a.sessionId) : Number.MAX_SAFE_INTEGER;
    const ib = has(b.sessionId) ? order.get(b.sessionId) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    // 不在侧边栏账目里的（子代理会话等）排在最后，按创建时间从新到旧
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
  return out;
}

/**
 * 侧边栏顺序：把每个工作区的 sessionIds 按序编号。
 * 按 `global.workspaceIds` 的顺序遍历（那是侧边栏的工作区分组顺序），
 * 组内按 sessionIds 顺序 —— 平铺后就与侧边栏看到的排布一致。
 * @returns {Map<string, number>} 裸会话 id -> 序号
 */
function sidebarOrder(ctx) {
  const order = new Map();
  const ws = workspaceDomain(ctx);
  if (!ws) return order;
  try {
    const table = typeof ws.table === 'function' ? ws.table('workspaces') : null;
    if (!table || typeof table.entries !== 'function') return order;
    const rows = new Map(table.entries());

    let workspaceIds = null;
    const g = ws.global;
    if (g && typeof g.get === 'function') {
      const state = g.get();
      if (state && Array.isArray(state.workspaceIds) && state.workspaceIds.length > 0) workspaceIds = state.workspaceIds;
    }

    let seq = 0;
    const take = (rec) => {
      if (!rec || !Array.isArray(rec.sessionIds)) return;
      for (const id of rec.sessionIds) {
        const bare = bareSessionId(id);
        if (!order.has(bare)) order.set(bare, seq++);
      }
    };

    if (workspaceIds) {
      for (const wid of workspaceIds) take(rows.get(wid));
    }
    // 兜底：不在 workspaceIds 账目里的工作区（顺序放在后面）
    for (const [wid, rec] of rows) {
      if (workspaceIds && workspaceIds.includes(wid)) continue;
      take(rec);
    }
  } catch {
    /* 域未打开时退化为原顺序 */
  }
  return order;
}

/**
 * 把一个不在账目里的会话重新挂回它自己的工作区。
 *
 * 走官方 `attachSession`：它读会话 header、用 realpath 校验 cwd 与工作区路径一致，
 * 通过后调 `rememberSessionPath`（补上归属索引）并把 id 前插进 sessionIds。
 * 因此它只会接受**真正属于该工作区**的会话，不会张冠李戴。
 */
async function reattachOne(ctx, id) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') {
    return { ok: false, sessionId: id, error: 'workspaceRegistry 服务不可用' };
  }
  const variants = sessionIdVariants(id);
  const tried = [];
  for (const ws of registry.list()) {
    for (const cand of variants) {
      try {
        await ws.attachSession(cand);
        const ids = ws.sessionIds ? [...ws.sessionIds] : [];
        return { ok: true, sessionId: cand, workspace: ws.title, path: ws.path, inLedger: ids.includes(cand) };
      } catch (e) {
        tried.push(`${ws.title}/${cand.slice(0, 12)}…: ${e.message}`);
      }
    }
  }
  return { ok: false, sessionId: id, error: `没有工作区接受它 —— ${tried.join(' | ')}` };
}

export function apply(ctx) {
  function registerHttp(host, targetCtx) {
    // 列表：把侧栏标题映射到会话 id
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__session-delete/list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
        try {
          sendJson(res, 200, { ok: true, sessions: listSessions(ctx) });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
      },
    }));

    // 诊断：直接问持久化层"你认得哪些会话"，用于排查「未分组」
    // （工作区账目里的会话若不在这个列表里，就会被 DSH 当成失效而移出）
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__session-delete/diag',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
        try {
          const out = { ok: true, persistence: null, workspaces: [], recycleAvailable: recycleAvailable() };

          const sp = ctx.get('sessionPersistence');
          if (sp && typeof sp.list === 'function') {
            const snaps = await sp.list();
            out.persistence = {
              count: Array.isArray(snaps) ? snaps.length : null,
              ids: (snaps ?? []).map((s) => s?.header?.id).filter(Boolean),
            };
          }

          const registry = ctx.get('workspaceRegistry');
          if (registry && typeof registry.list === 'function') {
            for (const ws of registry.list()) {
              out.workspaces.push({
                title: ws.title,
                path: ws.path,
                // sessionIds 是实时的过滤视图；rawSessionIds 是落盘数组
                sessionIds: ws.sessionIds ? [...ws.sessionIds] : null,
                rawSessionIds: ws.record?.sessionIds ? [...ws.record.sessionIds] : null,
              });
            }
          }
          sendJson(res, 200, out);
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
      },
    }));

    // 归回：把不在账目里的会话重新挂回它自己的工作区（走官方 attachSession，
    // 它会读 header 校验 cwd 并补上 sessionPath 索引）
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__session-delete/reattach',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
        let args = {};
        try {
          const body = await readBody(req);
          if (body) args = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'bad json body' });
        }
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds : [args.sessionId].filter(Boolean);
        if (!ids.length) return sendJson(res, 400, { error: 'sessionId required' });
        const results = [];
        for (const raw of ids) results.push(await reattachOne(ctx, String(raw)));
        sendJson(res, results.every((r) => r.ok) ? 200 : 207, { ok: results.every((r) => r.ok), results });
      },
    }));

    // 扫描：确认框要展示产出清单与大小
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__session-delete/scan',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
        let args = {};
        try {
          const body = await readBody(req);
          if (body) args = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'bad json body' });
        }
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds : [args.sessionId].filter(Boolean);
        if (!ids.length) return sendJson(res, 400, { error: 'sessionId required' });
        try {
          const scans = ids.map((id) => ({
            ...scanOne(ctx, String(id)),
            running: isRunning(ctx, id),
          }));
          sendJson(res, 200, {
            ok: true,
            scans,
            recycleAvailable: recycleAvailable(),
          });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
      },
    }));

    // 删除：单个或批量
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__session-delete/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
        let args = {};
        try {
          const body = await readBody(req);
          if (body) args = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'bad json body' });
        }
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds : [args.sessionId].filter(Boolean);
        if (!ids.length) return sendJson(res, 400, { error: 'sessionId required' });
        const opts = {
          deleteProduced: args.deleteProduced === true,
          permanent: args.permanent === true,
        };
        const results = [];
        for (const raw of ids) {
          try {
            results.push({ ok: true, ...(await deleteOne(ctx, String(raw), opts)) });
          } catch (e) {
            const status = e instanceof DeleteError ? e.status : 500;
            results.push({ ok: false, sessionId: bareSessionId(String(raw)), error: e.message, status });
          }
        }
        const anyFailed = results.some((r) => !r.ok);
        sendJson(res, anyFailed ? 207 : 200, { ok: !anyFailed, results });
      },
    }));
  }

  const ws = ctx.get('webServer');
  if (ws !== undefined) {
    registerHttp(ws, ctx);
  } else {
    ctx.inject(['webServer'], (sub) => registerHttp(sub.webServer, sub));
  }
}
