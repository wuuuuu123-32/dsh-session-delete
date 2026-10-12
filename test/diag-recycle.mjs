// 诊断：回收站调用在工作区内 vs 外、以及 powershell 退出码的实际表现（纯 ASCII 输出，避免管道编码问题）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recyclePaths, checkRecycleAvailable, runPowerShellQuiet } from '../lib/recycle.mjs';

const cases = [
  { name: 'inside-workspace', dir: path.join(process.cwd(), 'test', '_rt-in') },
  { name: 'outside-dsh-home', dir: path.join(os.homedir(), '.dsh', '_rt-out') },
  { name: 'outside-temp', dir: path.join(os.tmpdir(), '_rt-temp') },
];

console.log('recycle available (probe):', checkRecycleAvailable());

for (const c of cases) {
  try {
    fs.mkdirSync(path.join(c.dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(c.dir, 'sub', 'b.txt'), 'world');
  } catch (e) {
    console.log(`\n[${c.name}] cannot create: ${e.message}`);
    continue;
  }
  const before = fs.existsSync(c.dir);
  const r = recyclePaths([c.dir]);
  console.log(`\n[${c.name}]`);
  console.log(`  path: ${c.dir}`);
  console.log(`  exists before=${before} after=${fs.existsSync(c.dir)}`);
  console.log(`  ok=${r.ok.length} failed=${r.failed.length} skipped=${r.skipped.length}`);
  for (const f of r.failed) console.log(`  FAIL ${f.path} -> ${f.error}`);
}

console.log('\n=== powershell exit code self-test ===');
console.log('  ok script:', JSON.stringify(runPowerShellQuiet("exit 0")));
console.log('  fail script:', JSON.stringify(runPowerShellQuiet('exit 3')));

// 可选：校验某个指定目录是否还在（node diag-recycle.mjs <目录>）
const sessDir = process.argv[2];
if (sessDir) console.log('\nsession dir still on disk:', fs.existsSync(sessDir));
