// 调 /reattach 把三个会话挂回工作区，然后重新 diag 验证
const BASE = 'http://127.0.0.1:19387';
const suspects = [
  'session-cf007cbf-0328-41ed-99df-61a7ef31e929',
  'session-ee8e72b9-8a16-42be-912b-861e781ed321',
  'session-08727c94-27b1-4c12-ae69-59025799c47c',
];
const short = (s) => s.slice(0, 16);

console.log('=== 执行 reattach ===');
const r = await fetch(`${BASE}/__session-delete/reattach`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionIds: suspects }),
});
const j = await r.json();
console.log(`HTTP ${r.status}  ok=${j.ok}`);
for (const res of j.results ?? []) {
  if (res.ok) {
    console.log(`  ✓ ${short(res.sessionId)}  -> 工作区「${res.workspace}」  已在账目=${res.inLedger}`);
  } else {
    console.log(`  ✗ ${short(res.sessionId)}  ${res.error}`);
  }
}

console.log('\n=== 重新诊断 ===');
const r2 = await fetch(`${BASE}/__session-delete/diag`);
const j2 = await r2.json();
for (const ws of j2.workspaces ?? []) {
  const raw = ws.rawSessionIds ?? [];
  const getter = ws.sessionIds ?? [];
  console.log(`  ${ws.title}: 落盘 ${raw.length} 个 / 实时 ${getter.length} 个`);
  for (const s of suspects) {
    if (raw.includes(s) || getter.includes(s)) {
      console.log(`      ${short(s)}  落盘=${raw.includes(s)}  实时=${getter.includes(s)}`);
    }
  }
}

console.log('\n=== 最终确认 ===');
const cfg = (j2.workspaces ?? []).find((w) => w.title === 'config');
const raw = cfg?.rawSessionIds ?? [];
const getter = cfg?.sessionIds ?? [];
const allBack = suspects.every((s) => raw.includes(s) && getter.includes(s));
console.log(allBack
  ? `✅ 三个会话都已回到 config 账目（落盘 ${raw.length} 个 / 实时 ${getter.length} 个）`
  : `⚠️ 还没全回来：落盘 ${raw.length} 个 / 实时 ${getter.length} 个`);
