// 验证 /__session-delete/list 的会话顺序 == 侧边栏顺序（workspaceIds × sessionIds）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const WORKSPACE_JSON = path.join(DSH_HOME, 'storages', 'workspace.json');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

const bare = (id) => String(id).replace(/^session-/, '');

// --- 真实数据 ---------------------------------------------------------------
const wsRaw = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
const workspaceIds = wsRaw.global?.workspaceIds ?? [];
const workspaces = wsRaw.tables?.workspaces ?? {};

const expected = [];
for (const wid of workspaceIds) {
  for (const id of workspaces[wid]?.sessionIds ?? []) expected.push(bare(id));
}
for (const [wid, rec] of Object.entries(workspaces)) {
  if (workspaceIds.includes(wid)) continue;
  for (const id of rec.sessionIds ?? []) expected.push(bare(id));
}

const projRows = new Map();
for (const f of fs.readdirSync(PROJ)) {
  try {
    projRows.set(f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(PROJ, f), 'utf8')).record);
  } catch {
    /* 跳过坏缓存 */
  }
}

// --- mock ctx ---------------------------------------------------------------
const routes = [];
const services = {
  storageDomain: {
    get: (n) => {
      if (n === 'session_projcache')
        return {
          table: () => ({ get: (k) => projRows.get(k), entries: () => projRows.entries(), delete: async () => {} }),
        };
      if (n === 'workspace')
        return {
          table: () => ({ entries: () => new Map(Object.entries(workspaces)).entries(), put: async () => {} }),
          global: { get: () => ({ workspaceIds }), set: async () => {} },
        };
      return undefined;
    },
  },
  agents: { get: () => undefined },
  sessions: { get: () => undefined },
  tools: { register: () => {} },
  webServer: { register: (r) => (routes.push(r), () => {}) },
  workspaceRegistry: { list: () => [] },
};
const ctx = {
  get: (n) => services[n],
  effect: (fn) => {
    const d = fn();
    return typeof d === 'function' ? d : () => {};
  },
  inject: (names, fn) => fn({ get: (n) => services[n], effect: (f) => (f(), () => {}) }),
  emit: () => {},
};

const mod = await import(new URL('../lib/index.js', import.meta.url).href);
mod.apply(ctx);

const route = routes.find((r) => r.path === '/__session-delete/list');
let out = null;
const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
const res = { writeHead: (s) => (out = { status: s }), end: (t) => (out.body = t) };
await route.handler(req, res);
const data = JSON.parse(out.body);
const actual = data.sessions.map((s) => s.sessionId);

const show = (arr, n = 12) => arr.slice(0, n).map((x) => x.slice(0, 8)).join(' ');

console.log('侧边栏账目数:', expected.length, '  /list 返回数:', actual.length);
console.log('\n期望顺序(前12):', show(expected));
console.log('实际顺序(前12):', show(actual));

const inBoth = (arr, ref) => arr.filter((id) => ref.includes(id));
const expPart = inBoth(expected, actual);
const actPart = inBoth(actual, expected);
const ok = JSON.stringify(expPart) === JSON.stringify(actPart);
console.log('\n两者都有的会话:', expPart.length);
console.log('相对顺序一致:', ok ? '✅ 是' : '❌ 否');
if (!ok) {
  for (let i = 0; i < expPart.length; i++) {
    if (expPart[i] !== actPart[i]) {
      console.log(`  第一个不一致在位置 ${i}: 期望 ${expPart[i].slice(0, 8)} / 实际 ${actPart[i].slice(0, 8)}`);
      break;
    }
  }
}

// 没在侧边栏账目里的（应排在最后）
const notInSidebar = actual.filter((id) => !expected.includes(id));
console.log('不在侧边栏账目里的会话:', notInSidebar.length);
if (notInSidebar.length > 0) {
  const lastIdx = actual.lastIndexOf(notInSidebar[0]);
  const sidebarTail = actual.filter((id) => expected.includes(id)).length;
  console.log('  它们出现在下标', actual.map((id, i) => (notInSidebar.includes(id) ? i : -1)).filter((i) => i >= 0).join(','),
              `（侧边栏内的会话共 ${sidebarTail} 个，应从 ${sidebarTail} 往后）`);
}
