// 单测：run_code（PTC）里的嵌套写入也必须算成产出
//   node test/ptc.test.mjs
//
// 背景（2026-10-15 的真实 bug）：整场对话都通过 run_code 里的 tools.write / tools.edit
// 干活时，会话日志里只有 tool/ptc-dispatch，没有 tool/call，扫描器算出「0 个产出」，
// 删除会话时它的产出目录就不会被列进清单。与 dsh-open-artifacts 同源（那边先修）。
import assert from 'node:assert/strict';
import { producedPathsFromEvents, producedPathsFromCall } from '../lib/scan-session-core.mjs';

const ptc = (name, args, isError = false) => ({ type: 'tool/ptc-dispatch', data: { name, arguments: args, isError } });
const call = (name, args, callId) => ({ type: 'tool/call', data: { name, arguments: args, callId } });
const result = (callId, isError) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', isError, toolCallId: callId }] } },
});

// 1) PTC 里的 write / edit / present 都要认出来
assert.deepEqual(
  producedPathsFromEvents([
    ptc('write', { file_path: 'lab-report-9/doc.docx', content: 'x' }),
    ptc('edit', { file_path: 'lab-report-9/fill.py', old_string: 'a', new_string: 'b' }),
    ptc('present', { files: [{ path: 'lab-report-9/报告.pdf', description: '交付' }] }),
  ]),
  ['lab-report-9/doc.docx', 'lab-report-9/fill.py', 'lab-report-9/报告.pdf'],
  'PTC 嵌套调用应被识别',
);

// 2) PTC 里失败的调用不算产出（ptc-dispatch 自带 isError）
assert.deepEqual(
  producedPathsFromEvents([ptc('write', { file_path: 'x/失败.py', content: 'x' }, true)]),
  [],
  'isError 的 PTC 调用应跳过',
);

// 3) 只读/执行类调用（ops_bash / read）永远不算产出
assert.deepEqual(
  producedPathsFromEvents([
    ptc('ops_bash', { command: 'python gen.py', description: '生成图' }),
    ptc('read', { file_path: 'a.py' }),
  ]),
  [],
  '非写入工具不算产出',
);

// 4) 顶层调用行为不变：成功的算，失败的跳过
assert.deepEqual(
  producedPathsFromEvents([
    call('write', { file_path: 'ok/a.md', content: 'a' }, 'c1'),
    call('write', { file_path: 'bad/b.md', content: 'b' }, 'c2'),
    result('c1', false),
    result('c2', true),
  ]),
  ['ok/a.md'],
  '顶层调用仍要按 tool/result 的 isError 过滤',
);

// 5) 两种来源合并 + 去重
assert.deepEqual(
  producedPathsFromEvents([
    ptc('write', { file_path: 'dir/f.pdf', content: 'x' }),
    ptc('present', { files: [{ path: 'dir/f.pdf' }] }),
  ]),
  ['dir/f.pdf'],
  '应按首见顺序去重',
);

// 6) arguments 是字符串时要能解析（老版本日志会 stringify）
assert.deepEqual(
  producedPathsFromEvents([ptc('write', JSON.stringify({ file_path: 'dir/s.py', content: 'x' }))]),
  ['dir/s.py'],
  'arguments 为字符串时也要解析',
);

// 7) write 必须带 content 才算真写（参数残缺的调用不当产出）
assert.deepEqual(producedPathsFromCall('write', { file_path: 'dir/x.py' }), [], '缺 content 的 write 不算');
assert.deepEqual(producedPathsFromCall('present', { files: [{ path: '  ' }] }), [], '空白路径忽略');

console.log('✅ test/ptc.test.mjs 全部通过（7 组断言）');
