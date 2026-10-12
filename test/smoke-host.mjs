// 冒烟测试 host 半边：模块能否加载、ctx 访问是否安全、扫描结果对不对。
// 只做扫描，**不删除任何东西**。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
// 插件路径跟着本文件的位置走：换机器、换目录都不用改
const PLUGIN = fileURLToPath(new URL('../lib/index.js', import.meta.url));

console.log('DSH_HOME =', DSH_HOME);

// --- 造一个最小 mock ctx -------------------------------------------------------
const registered = { http: [], effects: [] };

function makeCtx() {
  const projRows = new Map();
  // 用真实投影缓存填充（模拟 storageDomain 内存态）
  const dir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  for (const f of fs.readdirSync(dir)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      projRows.set(f.replace(/\.json$/, ''), j.record);
    } catch {}
  }

  const sessionsTable = {
    get: (k) => projRows.get(k),
    delete: async (k) => projRows.delete(k),
    entries: () => projRows.entries(),
  };
  const workspacesTable = {
    entries: () => new Map().entries(),
    put: async () => {},
  };
  const sd = {
    get: (name) => {
      if (name === 'session_projcache') return { table: () => sessionsTable };
      if (name === 'workspace') return { table: () => workspacesTable, global: { get: () => ({}), set: async () => {} } };
      return undefined;
    },
  };

  const services = {
    storageDomain: sd,
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    tools: { register: () => {} },
    webServer: {
      register: (route) => {
        registered.http.push(route);
        return () => {};
      },
    },
    workspaceRegistry: { list: () => [] },
  };

  return {
    get: (name) => services[name],
    effect: (fn) => {
      registered.effects.push(fn);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject: (names, fn) => {
      // 模拟服务已就绪：直接调用
      const sub = {
        get: (n) => services[n],
        effect: (f) => {
          registered.effects.push(f);
          const d = f();
          return typeof d === 'function' ? d : () => {};
        },
      };
      fn(sub);
    },
    emit: (type, id) => console.log(`  [emit] ${type} ${id}`),
  };
}

// --- 加载插件 ------------------------------------------------------------------
let mod;
try {
  mod = await import('file:///' + PLUGIN.replace(/\\/g, '/'));
  console.log('\n[1] 模块加载成功');
  console.log('    name   =', mod.name);
  console.log('    inject =', JSON.stringify(mod.inject));
  console.log('    exports:', Object.keys(mod).join(', '));
} catch (e) {
  console.error('[1] 模块加载失败:', e.message);
  console.error(e.stack);
  process.exit(1);
}

if (typeof mod.apply !== 'function') {
  console.error('[2] 没有导出 apply —— 插件加载会失败');
  process.exit(1);
}

// --- 调 apply ------------------------------------------------------------------
const ctx = makeCtx();
try {
  mod.apply(ctx);
  console.log('\n[2] apply() 执行成功，注册了', registered.http.length, '个 HTTP 路由');
  for (const r of registered.http) console.log('    ', r.kind, r.path);
} catch (e) {
  console.error('[2] apply() 抛错:', e.message);
  console.error(e.stack);
  process.exit(1);
}

// --- 直接测扫描 -----------------------------------------------------------------
const core = await import(new URL('../lib/scan-session-core.mjs', import.meta.url).href);
const sessionsRoot = path.join(DSH_HOME, 'sessions');
const projCacheDir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

const buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
const allIds = [];
for (const b of buckets) {
  const bp = path.join(sessionsRoot, b.name);
  for (const d of fs.readdirSync(bp, { withFileTypes: true })) {
    if (d.isDirectory()) allIds.push(d.name);
  }
}
console.log('\n[3] 发现', allIds.length, '个会话目录');

// 挑一个有产出的会话来验证（用 argv 指定，否则自动找第一个有产出的）
const wanted = process.argv[2];
let shown = 0;
for (const id of allIds) {
  if (wanted && id !== wanted) continue;
  const scan = core.scanSession({ sessionId: id, sessionsRoot, projCacheDir });
  const hasProduced = scan.producedTopEntries.length > 0;
  if (!wanted && !hasProduced) continue;
  console.log(`\n  --- ${id} ---`);
  console.log(`    标题: ${scan.title ?? '(无)'}`);
  console.log(`    cwd : ${scan.cwd ?? '(未知)'}`);
  console.log(`    记录: ${scan.records.length} 项, ${(scan.recordBytes / 1024).toFixed(1)} KiB`);
  for (const r of scan.records) console.log(`           ${r}`);
  console.log(`    产出: ${scan.producedPaths.length} 个文件 -> ${scan.producedTopEntries.length} 个顶层条目, ${(scan.producedBytes / 1024).toFixed(1)} KiB`);
  for (const e of scan.producedTopEntries) {
    console.log(`           ${e.isDir ? '[目录]' : '[文件]'} ${e.name}  ${e.fileCount} 个文件  ${(e.bytes / 1024).toFixed(1)} KiB`);
  }
  if (scan.errors.length) console.log(`    错误: ${scan.errors.join('; ')}`);
  shown++;
  if (!wanted && shown >= 3) break;
}

if (shown === 0 && wanted) console.log(`\n  没找到会话 ${wanted}`);
console.log('\n[4] 冒烟测试结束（没有删除任何东西）');
