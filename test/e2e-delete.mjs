// 端到端测试：走插件的 HTTP handler，真实删除**多个**会话，验证批量链路：
//   ① scan 批量  ② delete 批量  ③ 每条记录都进回收站  ④ 投影缓存被摘掉
//
// 用法: node e2e-delete.mjs <sessionId> [<sessionId> ...] [--with-produced]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const PLUGIN = fileURLToPath(new URL('../lib/index.js', import.meta.url));

const args = process.argv.slice(2);
const withProduced = args.includes('--with-produced');
const targets = args.filter((a) => !a.startsWith('--'));
if (targets.length === 0) {
  console.error('用法: node e2e-delete.mjs <sessionId> [<sessionId> ...] [--with-produced]');
  process.exit(1);
}

// ---------- mock ctx ----------
const routes = [];
function makeCtx() {
  const projRows = new Map();
  for (const f of fs.readdirSync(PROJ)) {
    try {
      projRows.set(f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(PROJ, f), 'utf8')).record);
    } catch {}
  }
  const services = {
    storageDomain: {
      get: (n) =>
        n === 'session_projcache'
          ? {
              table: () => ({
                get: (k) => projRows.get(k),
                delete: async (k) => projRows.delete(k),
                entries: () => projRows.entries(),
              }),
            }
          : n === 'workspace'
            ? { table: () => ({ entries: () => new Map().entries(), put: async () => {} }), global: { get: () => ({}), set: async () => {} } }
            : undefined,
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    tools: { register: () => {} },
    webServer: { register: (r) => (routes.push(r), () => {}) },
    workspaceRegistry: { list: () => [] },
  };
  return {
    get: (n) => services[n],
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
    inject: (names, fn) => fn({ get: (n) => services[n], effect: (f) => (f(), () => {}) }),
    emit: (type, id) => console.log(`    [emit] ${type} ${id}`),
  };
}

function callHandler(routePath, body) {
  const route = routes.find((r) => r.path === routePath);
  if (!route) throw new Error(`没注册路由 ${routePath}`);
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end') cb();
      return this;
    },
  };
  let out = null;
  const res = {
    writeHead(status, headers) {
      out = { status, headers };
    },
    end(text) {
      if (out) out.body = text;
      else out = { status: 200, body: text };
    },
  };
  return Promise.resolve(route.handler(req, res)).then(() => {
    try {
      return { ...out, json: JSON.parse(out.body) };
    } catch {
      return out;
    }
  });
}

function findByVariants(id) {
  const variants = [id, `session-${id}`];
  const dirs = [];
  for (const b of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!b.isDirectory()) continue;
    for (const v of variants) {
      const d = path.join(SESSIONS, b.name, v);
      if (fs.existsSync(d)) dirs.push(d);
    }
  }
  const projFiles = variants.map((v) => path.join(PROJ, `${v}.json`)).filter((f) => fs.existsSync(f));
  return { dirs, projFiles };
}

const mod = await import('file:///' + PLUGIN.replace(/\\/g, '/'));
mod.apply(makeCtx());
console.log(`已注册路由: ${routes.map((r) => r.path).join(', ')}`);
console.log(`测试对象 ${targets.length} 个: ${targets.map((t) => t.slice(0, 8)).join(', ')}`);

console.log('\n════ 删除前 ════');
const before = new Map(targets.map((t) => [t, findByVariants(t)]));
for (const t of targets) {
  const s = before.get(t);
  console.log(`  ${t.slice(0, 8)}: 目录 ${s.dirs.length} 个, 投影缓存 ${s.projFiles.length} 个`);
}

console.log('\n════ 1) 批量 scan ════');
const scan = await callHandler('/__session-delete/scan', { sessionIds: targets });
if (!scan.json?.ok) {
  console.error('scan 失败:', scan.body);
  process.exit(1);
}
for (const s of scan.json.scans) {
  console.log(`  ${s.sessionId.slice(0, 8)}  ${(s.recordBytes / 1024).toFixed(1)} KiB 记录, ${s.producedTopEntries.length} 项产出`);
}

console.log('\n════ 2) 批量 delete ════');
const del = await callHandler('/__session-delete/delete', { sessionIds: targets, deleteProduced: withProduced });
console.log(`  HTTP ${del.status}`);
for (const r of del.json?.results ?? []) {
  if (r.ok) {
    console.log(`  ✅ ${r.sessionId.slice(0, 8)}  记录回收 ${r.recycled.length} 项  投影摘除 ${r.projRemoved}  记账摘除 ${r.workspaceDetached}  信号 ${r.removedSignal}`);
    if (r.failed.length) for (const f of r.failed) console.log(`       ⚠️ 失败: ${f.path} -> ${f.error}`);
  } else {
    console.log(`  ❌ ${r.sessionId.slice(0, 8)}  ${r.error}`);
  }
}

console.log('\n════ 删除后 ════');
let allPass = true;
for (const t of targets) {
  const after = findByVariants(t);
  const b = before.get(t);
  const dirGone = b.dirs.length > 0 && after.dirs.length === 0;
  const projGone = b.projFiles.length === 0 || after.projFiles.length === 0;
  const pass = dirGone && projGone;
  if (!pass) allPass = false;
  console.log(`  ${pass ? '✅' : '❌'} ${t.slice(0, 8)}  目录 ${b.dirs.length}->${after.dirs.length}, 投影缓存 ${b.projFiles.length}->${after.projFiles.length}`);
}

console.log(`\n总计: ${allPass ? '全部通过' : '有失败项'}`);
process.exit(allPass ? 0 : 1);
