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

fs.rmSync(root, { recursive: true, force: true });
console.log('PASS classify-produce');
