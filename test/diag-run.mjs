// 调插件的 /diag，判断持久化层认不认得那三个"未分组"会话
const BASE = 'http://127.0.0.1:19387';
const suspects = [
  'session-cf007cbf-0328-41ed-99df-61a7ef31e929',
  'session-ee8e72b9-8a16-42be-912b-861e781ed321',
  'session-08727c94-27b1-4c12-ae69-59025799c47c',
];
const short = (s) => s.slice(0, 16);

let j;
try {
  const r = await fetch(`${BASE}/__session-delete/diag`);
  j = await r.json();
  console.log(`HTTP ${r.status}  ok=${j.ok}`);
} catch (e) {
  console.log('请求失败:', e.message);
  process.exit(1);
}

if (!j.ok) {
  console.log('diag 返回错误:', JSON.stringify(j));
  process.exit(1);
}

console.log('recycleAvailable:', j.recycleAvailable);
console.log('persistence.count:', j.persistence?.count ?? '(服务不可用)');

const ids = new Set(j.persistence?.ids ?? []);
console.log('\n=== 持久化层是否认得这三个会话 ===');
for (const s of suspects) {
  console.log(`  ${short(s)}  ${ids.has(s) ? '认得 ✓' : '不认得 ✗'}`);
}

console.log('\n=== 工作区账目 ===');
for (const ws of j.workspaces ?? []) {
  const getter = ws.sessionIds ?? [];
  const raw = ws.rawSessionIds ?? [];
  console.log(`  ${ws.title}  path=${ws.path}`);
  console.log(`    实时视图 sessionIds = ${getter.length} 个`);
  console.log(`    落盘数组 rawSessionIds = ${raw.length} 个`);
  for (const s of suspects) {
    const inGetter = getter.includes(s);
    const inRaw = raw.includes(s);
    if (inGetter || inRaw) console.log(`      ${short(s)}  实时=${inGetter}  落盘=${inRaw}`);
  }
  // 落盘有但实时没有的 = 正在被"过滤掉"的
  const filtered = raw.filter((x) => !getter.includes(x));
  if (filtered.length > 0) {
    console.log(`    ⚠️ 落盘有但被实时过滤掉的 ${filtered.length} 个:`);
    for (const f of filtered) console.log(`        ${f}`);
  }
}

console.log('\n=== 结论 ===');
const allKnown = suspects.every((s) => ids.has(s));
console.log(allKnown
  ? '持久化层认得它们 → reattach 应该能成功挂回'
  : '持久化层认不出它们 → attachSession 也会失败（它内部走同一个 list）');
