import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { classifyProduced } from '../lib/scan-session-core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-'));
const mk = (rel, body = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

// 公用目录：一个原有文件 + 一个本会话写的文件
mk('_hooks/existing.ps1', 'old');
mk('_hooks/mine.ps1', 'new');
// 专属目录：两个文件都是本会话写的
mk('own/a.txt', 'aaa');
mk('own/sub/b.txt', 'bb');
// 根目录散文件（公用）
mk('AGENTS.md', 'shared');
// 空目录（不该出现）
fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });

const produced = [
  path.join(root, '_hooks/mine.ps1'),
  path.join(root, 'own/a.txt'),
  path.join(root, 'own/sub/b.txt'),
  path.join(root, 'AGENTS.md'),
];

const r = classifyProduced(root, produced);

assert.equal(r.topEntries.length, 1, '只有一个专属目录');
assert.equal(r.topEntries[0].name, 'own');
assert.equal(r.topEntries[0].exclusive, true);
assert.equal(r.topEntries[0].fileCount, 2);
assert.equal(r.topEntries[0].bytes, 5, '专属目录按整棵大小算');

assert.equal(r.sharedDirs.length, 1, '公用目录不算可删产出');
assert.equal(r.sharedDirs[0].name, '_hooks');
assert.equal(r.sharedDirs[0].exclusive, false);
assert.equal(r.sharedDirs[0].producedFileCount, 1);
assert.equal(r.sharedDirs[0].totalFileCount, 2);
assert.equal(r.sharedDirs[0].bytes, 3, '只算本会话写的那一个文件');

assert.equal(r.looseFiles.length, 1, '根目录散文件只提示');
assert.equal(r.looseFiles[0].name, 'AGENTS.md');

assert.ok(!r.topEntries.some((e) => e.name === '_hooks'), '❗公用目录绝不能进可删清单');

// 空目录不应出现在任何清单
const all = [...r.topEntries, ...r.sharedDirs].map((e) => e.name);
assert.ok(!all.includes('empty-dir'));

// cwd 之外的路径必须被忽略
const outside = classifyProduced(root, ['C:/Windows/System32/drivers/etc/hosts']);
assert.equal(outside.topEntries.length + outside.sharedDirs.length + outside.looseFiles.length, 0, 'cwd 外的路径必须忽略');

// ---- 用例：目录里含符号链接 / junction ----
// 链接指向的内容没被枚举过，属于「没核验」，这种目录即使所有可见文件都是本会话写的，
// 也不能当成专属目录整棵回收（2026-10-17 独立评审指出的误删路径）。
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-outside-'));
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'do-not-delete');
mk('linkedown/c.txt', 'ccc');
let junctionOk = false;
try {
  fs.symlinkSync(outsideDir, path.join(root, 'linkedown', 'point'), 'junction');
  junctionOk = true;
} catch {
  junctionOk = false; // 没有权限建链接时跳过这一段，不把环境限制当成用例失败
}
const r2 = classifyProduced(root, [path.join(root, 'linkedown/c.txt')]);
if (junctionOk) {
  const linked = [...r2.topEntries, ...r2.sharedDirs].find((e) => e.name === 'linkedown');
  assert.ok(linked, 'linkedown 应被列出（但只能当公用）');
  assert.equal(linked.exclusive, false, '含链接的目录绝不能判成专属');
  assert.ok(!r2.topEntries.some((e) => e.name === 'linkedown'), '含链接的目录绝不能进可删清单');
} else {
  console.log('SKIP 符号链接用例（当前账户建不了 junction）');
}

// ---- 用例：Windows 大小写不敏感 ----
// 产出记录里的大小写与磁盘上的实际大小写不一致时必须仍能命中，
// 否则同一目录会被判成「有没核验过的文件」，白白从可删清单里掉出去。
mk('CaseDir/A.txt', 'aaa');
const r3 = classifyProduced(root, [path.join(root, 'casedir/a.txt')]);
// 注意：返回的 name 取自产出路径里的写法（这里是 casedir），不是磁盘上的真实大小写。
const cased = [...r3.topEntries, ...r3.sharedDirs].find((e) => e.name.toLowerCase() === 'casedir');
assert.ok(cased, '大小写不同的路径应命中同一目录');
if (process.platform === 'win32') {
  assert.equal(cased.exclusive, true, '大小写差异不应让专属目录降级');
}

// ---- 用例：顶层目录本身是指向 cwd 之外的 junction ----
// 必须完全不展开（不能把外部文件枚举进来），且永不判成可删。
const outsideTop = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-top-'));
fs.writeFileSync(path.join(outsideTop, 'big.bin'), 'zzz');
let topLinkOk = false;
try {
  fs.symlinkSync(outsideTop, path.join(root, 'toplink'), 'junction');
  topLinkOk = true;
} catch {
  topLinkOk = false;
}
if (topLinkOk) {
  const r4 = classifyProduced(root, [path.join(root, 'toplink/big.bin')]);
  const linkEntry = [...r4.topEntries, ...r4.sharedDirs].find((e) => e.name === 'toplink');
  assert.ok(linkEntry, 'toplink 应被列出');
  assert.equal(linkEntry.exclusive, false, '顶层链接目录永不判独占');
  assert.equal(linkEntry.totalFileCount, 0, '顶层链接目录不得展开枚举外部文件');
  assert.ok(!r4.topEntries.some((e) => e.name === 'toplink'), '顶层链接目录绝不能进可删清单');
} else {
  console.log('SKIP 顶层链接用例（当前账户建不了 junction）');
}
fs.rmSync(outsideTop, { recursive: true, force: true });
fs.rmSync(outsideDir, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS classify-produce');
