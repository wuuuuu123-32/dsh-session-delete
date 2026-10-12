// 把文件/目录移入 Windows 回收站（可恢复），并且在移动后**验证它真的进了回收站**。
//
// 两个已实测的坑，都在这里处理掉：
//
// 1) 沙箱：DSH 的受限令牌下，node 用管道捕获子进程输出会 EPERM
//    （见 dsh 的 sandbox 文档：piped grandchild spawn EPERM）。
//    → 用 stdio:'ignore' + 退出码判断，脚本用 -EncodedCommand 传，绕开引号转义。
//
// 2) 受限令牌下 VisualBasic.DeleteDirectory 会**静默永久删除**而不进回收站
//    （2026-09-30 实测：同一个调用，提权时进回收站、受限时被永久删）。
//    → 删除前后数一遍回收站里的 $I 元数据文件，数量没增加就报错，绝不谎报成功。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 把 PowerShell 脚本文本编码成 -EncodedCommand 需要的 base64（UTF-16LE） */
function encodeCommand(text) {
  return Buffer.from(text, 'utf16le').toString('base64');
}

/** 跑一段 PowerShell 脚本，只取退出码（不捕获输出，避免沙箱管道限制） */
export function runPowerShellQuiet(script) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
    { stdio: 'ignore', windowsHide: true }
  );
  return { status: res.status, error: res.error?.message ?? null };
}

/** 回收站所在目录（按盘符）。判断依据：文件进的是同盘回收站。 */
export function recycleBinDir(targetPath) {
  const root = path.parse(path.resolve(targetPath)).root; // 例如 "D:\"
  const sid = getCurrentUserSid();
  if (!sid) return null;
  return path.join(root, '$Recycle.Bin', sid);
}

let cachedSid;
/** 当前用户 SID；取不到时返回 null（此时无法验证，删除会被拒绝） */
export function getCurrentUserSid() {
  if (cachedSid !== undefined) return cachedSid;
  const res = runPowerShellOutput("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  cachedSid = res ? res.trim() : null;
  return cachedSid;
}

/**
 * 跑 PowerShell 并把一行结果写进临时文件再读回来。
 * （直接捕获 stdout 在受限令牌下 EPERM，所以走文件中转。）
 */
function runPowerShellOutput(script) {
  const out = path.join(
    process.env.TEMP || '.',
    `dsh-ps-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  const wrapped = [
    "$ErrorActionPreference = 'Stop'",
    `$out = $env:DSH_PS_OUT`,
    `$value = & { ${script} }`,
    `if ($null -eq $value) { '' | Set-Content -LiteralPath $out -Encoding UTF8 } else { ($value | Out-String).Trim() | Set-Content -LiteralPath $out -Encoding UTF8 }`,
  ].join('\n');
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(wrapped)],
    { stdio: 'ignore', windowsHide: true, env: { ...process.env, DSH_PS_OUT: out } }
  );
  let text = null;
  try {
    text = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    text = null;
  }
  try {
    fs.rmSync(out, { force: true });
  } catch {
    /* 清理失败不影响结果 */
  }
  if (res.status !== 0) return null;
  return text;
}

/** 数一个回收站目录里的 $I 元数据条目（代表"回收站里的项数"） */
export function countRecycleItems(binDir) {
  if (!binDir) return null;
  const text = runPowerShellOutput(
    `if (Test-Path -LiteralPath '${binDir.replace(/'/g, "''")}') { @(Get-ChildItem -LiteralPath '${binDir.replace(/'/g, "''")}' -Force -Filter '$I*' -ErrorAction SilentlyContinue).Count } else { 0 }`
  );
  if (text === null) return null;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** 生成"把给定路径移入回收站，失败则 exit 1"的脚本 */
function recycleScript(paths) {
  const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$paths = @(${list})`,
    '$bad = 0',
    'foreach ($p in $paths) {',
    '  if (-not (Test-Path -LiteralPath $p)) { continue }',
    '  try {',
    '    $item = Get-Item -LiteralPath $p -Force',
    '    if ($item.PSIsContainer) {',
    "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '    } else {',
    "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '    }',
    '  } catch { $bad++ }',
    '}',
    'exit $bad',
  ].join('\n');
}

/**
 * 把若干路径移入回收站，并验证真的进了回收站。
 *
 * @param {string[]} paths 绝对路径
 * @param {object} [opts]
 * @param {boolean} [opts.verify=true] 是否校验回收站条目增加（强烈建议开着）
 * @returns {{ok: string[], failed: {path: string, error: string}[], skipped: string[]}}
 */
export function recyclePaths(paths, opts = {}) {
  const verify = opts.verify !== false;
  const ok = [];
  const failed = [];
  const skipped = [];

  for (const p of paths) {
    if (!fs.existsSync(p)) {
      skipped.push(p);
      continue;
    }

    const binDir = recycleBinDir(p);
    const before = verify ? countRecycleItems(binDir) : null;

    const { status, error } = runPowerShellQuiet(recycleScript([p]));
    const gone = !fs.existsSync(p);

    if (!gone) {
      failed.push({ path: p, error: error ?? `删除没生效（PowerShell 退出码 ${status}）` });
      continue;
    }

    if (verify) {
      const after = countRecycleItems(binDir);
      if (before === null || after === null) {
        failed.push({
          path: p,
          error: '文件已被删除，但无法确认是否进了回收站（读不到回收站信息）——请不要再依赖「可恢复」这一说法',
        });
        continue;
      }
      if (after <= before) {
        failed.push({
          path: p,
          error: '这个文件被**永久删除**了，没有进回收站（当前权限下回收站不可用）。已经丢了。',
        });
        continue;
      }
    }
    ok.push(p);
  }

  return { ok, failed, skipped };
}

/**
 * 回收站能力探测：真的建一个临时目录、尝试回收、验证条目增加，然后（尽力）清理。
 * 这是唯一可靠的判断方式 —— 只看权限或只看 API 是否存在都不准。
 */
export function checkRecycleAvailable() {
  const probe = path.join(process.env.TEMP || '.', `_dsh-recycle-probe-${Date.now()}`);
  try {
    fs.mkdirSync(probe, { recursive: true });
  } catch {
    return false;
  }
  const binDir = recycleBinDir(probe);
  const before = countRecycleItems(binDir);
  const { status } = runPowerShellQuiet(recycleScript([probe]));
  const gone = !fs.existsSync(probe);
  if (!gone) {
    try {
      fs.rmSync(probe, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
    return false;
  }
  if (before === null) return false;
  const after = countRecycleItems(binDir);
  if (after === null) return false;
  return after > before && status === 0;
}

// 只有「本文件被直接执行」时才跑 CLI。
// 注意：不能用 endsWith('recycle.mjs') —— diag-recycle.mjs 这种名字也会命中，
// 结果 import 本模块时把 CLI 真跑了（踩过一次，排查了很久）。
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return path.basename(entry) === 'recycle.mjs';
  }
}

if (isDirectRun()) {
  const targets = process.argv.slice(2);
  const available = checkRecycleAvailable();
  if (targets.length === 0) {
    console.log('回收站可用:', available);
    process.exit(available ? 0 : 1);
  }
  console.log('回收站可用:', available);
  const result = recyclePaths(targets);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed.length > 0 ? 1 : 0);
}
