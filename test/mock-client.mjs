// 用 mock 的 __ModuleLoader__ 验证客户端脚本：能否装载、导出是否齐、插槽是否注册到正确位置。
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const code = fs.readFileSync(CLIENT, 'utf8');

const slots = [];
const injections = [];

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  Fragment: 'Fragment',
};

const primitives = {
  MenuItemButton: 'MenuItemButton',
  Modal: 'Modal',
  Button: 'Button',
  IconDeleteOutlineRegular: 'IconDelete',
};

const requireFn = (spec) => {
  if (spec === 'react') return React;
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`unexpected require('${spec}')`);
};

let loadedEntry = null;
let loadedExports = null;

const windowObj = {
  __ModuleLoader__: {
    // 真实协议：factory 的返回值就是模块导出
    load: (entry) => {
      loadedEntry = entry;
      loadedExports = entry.factory(requireFn);
      return loadedExports;
    },
  },
};

const sandbox = { window: windowObj, console, fetch: () => Promise.reject(new Error('no network in test')) };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });

console.log('[1] entry id:', loadedEntry ? loadedEntry.id : '(none)');
console.log('[2] exports:', loadedExports ? Object.keys(loadedExports).join(', ') : '(none)');
console.log('    inject:', JSON.stringify(loadedExports && loadedExports.inject));

if (!loadedExports || typeof loadedExports.apply !== 'function') {
  console.error('[2] FAIL no apply export');
  process.exit(1);
}

const ctx = {
  get: (name) =>
    name === 'locale' ? { register: (ns, dict) => injections.push(['locale.register', ns, Object.keys(dict)]) } : undefined,
  effect: (fn) => {
    fn();
    return () => {};
  },
  slots: {
    inject: (name, fn) => {
      injections.push(['slots.inject', name]);
      // 支持生成器形式的注册回调（yield ctx.slots.register(...) 多次）
      const it = fn();
      if (it && typeof it.next === 'function') {
        let step = it.next();
        while (!step.done) step = it.next();
      }
    },
    register: (decl, Comp) => {
      slots.push({ decl, Comp });
      return () => {};
    },
  },
};

try {
  loadedExports.apply(ctx);
} catch (e) {
  console.error('[3] FAIL apply threw:', e.message);
  console.error(e.stack);
  process.exit(1);
}

console.log('[3] apply() ok');
for (const s of slots) {
  console.log(`    slot name=${s.decl.name} id=${s.decl.id} order=${s.decl.order} locale=${s.decl.locale}`);
}
console.log('    registered:', JSON.stringify(injections.filter((i) => i[0] === 'slots.inject')));

const menuItems = slots.filter((s) => s.decl.name === 'sidebar.workspaces.session.menu.item');
const overlayItems = slots.filter((s) => s.decl.name === 'shell.overlay');
const single = menuItems.find((s) => s.decl.id === 'session-delete:delete');
const batch = menuItems.find((s) => s.decl.id === 'session-delete:batch');
const confirmDlg = overlayItems.find((s) => s.decl.id === 'session-delete:confirm');
const batchPanel = overlayItems.find((s) => s.decl.id === 'session-delete:batch-panel');

const checks = [
  ['single delete item on official menu slot', !!single],
  ['batch delete item registered', !!batch],
  ['single order 500', single && single.decl.order === 500],
  ['batch order 501', batch && batch.decl.order === 501],
  ['confirm dialog registered', !!confirmDlg],
  ['batch panel registered', !!batchPanel],
  ['single is a component fn', typeof (single && single.Comp) === 'function'],
  ['batch is a component fn', typeof (batch && batch.Comp) === 'function'],
  ['confirm is a component fn', typeof (confirmDlg && confirmDlg.Comp) === 'function'],
  ['panel is a component fn', typeof (batchPanel && batchPanel.Comp) === 'function'],
];
console.log('\n[4] checks');
for (const [label, pass] of checks) console.log(`    ${pass ? 'OK  ' : 'FAIL'} ${label}`);

const props = {
  sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  displayTitle: 'test-session',
  useMenuOpenState: () => [false, () => {}],
};

for (const [name, item] of [['single', single], ['batch', batch]]) {
  try {
    const el = item.Comp(props);
    console.log(`\n[5] ${name} menu render:`, el && el.type === 'MenuItemButton' ? 'OK (MenuItemButton)' : `got ${typeof el}`);
    console.log('    label:', JSON.stringify(el.children));
  } catch (e) {
    console.error(`\n[5] FAIL ${name} menu render threw:`, e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

try {
  const el = confirmDlg.Comp({});
  console.log('\n[6] confirm dialog idle:', el === null ? 'null (correct)' : typeof el);
} catch (e) {
  console.error('[6] FAIL confirm idle threw:', e.message);
  process.exit(1);
}

try {
  const el = batchPanel.Comp({});
  console.log('[7] batch panel idle:', el === null ? 'null (correct)' : typeof el);
} catch (e) {
  console.error('[7] FAIL panel idle threw:', e.message);
  process.exit(1);
}
