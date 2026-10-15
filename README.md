# dsh-session-delete

给 DSH 会话列表的「⋯」菜单加两个动作：**删除当前会话** 和 **批量删除会话**。

删除不是永久删除 —— **记录进 Windows 回收站，误删可以还原**。
删除前会扫描该会话的产出，列出来让你决定是否一并清理。

> 起因：DSH 官方到 `0.2.0-rc.2` 都没有删除会话的能力。
> `sessionPersistence` 的契约只有 `create` / `open` / `stat` / `list` / `flush`，**没有 delete**；
> 唯一会话级移除是 `archiveSession`（只隐藏）。所以这个能力必须由插件补。

## 和现有几种做法比

| 方案 | 会话记录 | 产出文件 | 可恢复 |
|---|---|---|---|
| 官方「归档」 | 保留，只隐藏 | 不动 | — |
| npm 上的 `dsh-session-delete`（作者 vtxf，**与本项目无关**） | **永久删除** | 不动 | ❌ 不可恢复 |
| **本插件** | 移入回收站 | 扫描后由你勾选，默认不动 | ✅ 回收站还原 |

⚠️ npm 上已有一个同名包（别人写的，永久删除且不可恢复）。**本项目只从 GitHub 发布**，
安装时请始终带 `github:` 前缀，否则会装到那个包：

```bash
dsh plugin --profile desktop add dsh-session-delete          # ❌ 装到别人的包
dsh plugin --profile desktop add github:wuuuuu123-32/dsh-session-delete   # ✅ 本插件
```

## 安装

```bash
# 桌面端（profile 名换成你自己的）
dsh plugin --profile desktop add github:wuuuuu123-32/dsh-session-delete
```

装完**必须重启 DSH**（客户端插件的 HMR 对新增插槽项不可靠）。

<details>
<summary>手动安装（不用 <code>dsh plugin</code> 时）</summary>

把本仓库放到任意目录，然后在 profile 目录里建链接并登记：

```bash
cd ~/.dsh/profiles/desktop
pnpm add /path/to/dsh-session-delete        # 或用 junction / symlink 指过去
```

`~/.dsh/profiles/desktop/package.json` 里要有：

```json
{
  "dependencies": { "dsh-session-delete": "link:..." },
  "dsh": { "profile": { "bundles": ["dsh-session-delete"] } }
}
```

❗ 改这个 JSON 时**不要写 BOM**（PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM，
DSH 启动时 `JSON.parse` 直接抛 `SyntaxError: Unexpected token '﻿'`，表现为界面打不开）。
用 `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`。

</details>

## 用法

会话列表某一行的「⋯」菜单里：

| 菜单项 | 行为 |
|---|---|
| 删除会话 | 删这一条。先扫产出，弹确认框显示**产出清单 + 各项占用 + 记录大小**，勾选「我已了解后果」才能确认 |
| 批量删除会话… | 打开面板多选（支持全选/清空，运行中的不可勾），确认后先只扫选中项，再进确认框 |

产出默认**原地保留**；勾选「把上面的产出**目录**也一并移入回收站」才会动它。

### ❗ 什么算「产出」：只认专属子目录，绝不碰工作区根目录的公用文件

扫描的**事件来源有两种**（2026-10-15 补）：模型直接调 `write` / `edit` 时是 `tool/call`；
而 run_code（PTC 模式）里调 `tools.write` 时只有 `tool/ptc-dispatch`。两种都要扫，
否则「整场对话都走 run_code」的会话会被算成零产出（与 `dsh-open-artifacts` 同源）。

DSH 自己的 `turn-deliverables` 规则是"这个会话**写过**哪些文件"。写权限上这没问题
（没写过就不该删），但它会把**公用文件**算进某个会话的产出 —— 因为总有一个会话写过
`AGENTS.md` / 升级日志这类跨对话公用的资产。实测中确认框里就把 `升级日志.md` 列成了
某个会话的"产出"，一旦勾选就会被移进回收站。

所以现在的规则是：

| 对象 | 处理 |
|---|---|
| `cwd` 下的**专属子目录**（`lab-report-9\`、`my-plugin\` …） | 列入**可删产出**，勾选才移入回收站 |
| `cwd` 根目录下的**散文件**（`AGENTS.md`、`升级日志.md`、`prompt-*.md`、临时脚本 …） | 分开列成「**不会被移动**」的提示区，**永远不动** |

取舍说明：根目录散文件里既有公用文件也有会话自己的临时脚本，**无法可靠自动区分**，
所以一律不动（安全优先）。要清临时文件请直接在工作区操作。

### 批量面板的排序与过滤

- **顺序照抄侧边栏**：按 `workspace.json` 里 DSH 自己维护的 `sessionIds` 数组排
  （先按 `global.workspaceIds` 的工作区分组顺序，组内按 `sessionIds`）。
  原先用投影缓存表的自然顺序，看着是乱的。
- **默认只列侧边栏看得见的主会话**：子代理会话的投影缓存存在
  `session_projcache/sessions/<裸uuid>.json`，标题多是"你要访问这个网页…"，
  **不在** `sessionIds` 账目里，侧边栏看不到。默认收起它们并提示"另有 N 个未显示"；
  取消勾选「只看侧边栏里的会话」即可看到全部（展开时排在最末，带灰色 `子代理/未分组` 标记）。
- 切回「只看侧边栏」会自动取消被隐藏项的勾选，避免"看不见却被删"。
- 批量确认框里若多个会话都有产出，按会话分别用小标题列，不再重复同一句提示。

## 删除链路（顺序不能换）

```
1. 运行中的会话 → 直接拒绝（409）
   ctx.agents.get(id)?.status === 'running'
2. 扫描产出（在删之前，日志还在）
3. flush 活动会话（避免 dispose 阶段回写重建日志）
4. 会话日志目录 + 投影缓存文件 → 回收站
   ★ 校验：删除后数一遍回收站 $I 条目，数量没增加就报错中止
5. 确认日志目录真的没了（被 dispose 回写的话这里会拦住）
6. 摘工作区记账（workspaceRegistry.detachSession / storageDomain）
7. ctx.emit('api-session/removed', id)   ← 让列表行当场消失
   ★ 注意：删完**不能重拉列表**，否则宿主基线会把行合并回来
```

第 4 步的校验是关键。见下面第一个坑。

## 实现要点

- **菜单项走官方插槽** `sidebar.workspaces.session.menu.item`（order 500 / 501，排在内置的
  pin 100 / rename 200 / fork 300 / archive 400 之后），不是 DOM 注入 —— DSH `0.2.0-rc.2` 已开放这个插槽。
- **必须发 `api-session/removed`**，客户端 `sessions.handleSessionRemoved` 靠它收敛列表。
- 客户端是**手写的模块表产物**（与 `dsh-better-sidebar/lib/client.js` 同协议：
  `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，最后 `exports.apply` / `exports.inject`），
  所以**不需要构建步骤**，直接改 `lib/client.js` 即可。
- 客户端装的是 `sidebar.workspaces.session.menu.item` 插槽；host 半边注册同源 HTTP 路由，
  客户端经 `fetch` 调用，删除动作全部在 host 侧完成。

## 兼容性

- DSH `0.2.0-rc.2`（桌面端 profile），依赖 `webServer` / `sessionPersistence` /
  `workspaceRegistry` / `sessions` 服务
- **Windows**（依赖 Windows 回收站；`recycle.mjs` 走 Shell COM + `$Recycle.Bin` 元数据解析）
- 旧版 web 端（`0.1.5-rc.2`）**不支持**：那一版前端产物里没有 `sidebar.workspaces.*` 插槽体系
  （客户端 UI 是打包进 `dsh-web-frontend` 的单体产物，不是独立 `@deepseek-ai/dsh-client-ui-*` 包），
  菜单项注入不成立。host 半边（HTTP 路由、扫描、回收站）本身不依赖客户端框架，可以跑。

## 目录

```
lib/index.js              host 半边：HTTP 路由 (/list /scan /delete …) + 删除链路
lib/client.js             客户端半边（手写模块表产物）：菜单项 + 批量面板 + 确认框
lib/recycle.mjs           移入回收站，并自证真的进了回收站
lib/list-recycle-bin.mjs  读回收站（解析每个盘 $I* 元数据），验证可恢复
lib/scan-session-core.mjs 产出扫描（复刻 DSH turn-deliverables 规则）
lib/zstd-session.mjs      会话日志多帧 zstd 逐帧解压
test/                     离线测试（不依赖 GUI）
```

测试脚本（全部只依赖 `DSH_HOME` 指向的环境，路径自动从文件位置推导）：

```bash
node test/ptc.test.mjs            # 单测：PTC 嵌套写入也算产出（7 组断言）
node test/smoke-host.mjs          # host 模块加载 + apply + 扫描（只读）
node test/mock-client.mjs         # 客户端装载 + 插槽注册 + 组件渲染
node test/list-sessions.mjs       # 列出会话与产出概况（只读）
node lib/list-recycle-bin.mjs     # 看回收站里有什么
node lib/zstd-session.mjs <会话目录>   # 解压单个会话日志，打事件统计
```

真实删除（⚠️ 会真的动数据，先备份）：

```bash
node test/e2e-delete.mjs <sessionId> [...] [--with-produced]
```

## ❗ 踩过的坑

### 1. 受限令牌下 `DeleteDirectory` 会**静默永久删除**，不进回收站

实测：**同一个调用**，提权时文件进回收站，受限令牌下被永久删除，而且不抛任何异常 ——
函数"成功"返回，文件没了，回收站里也没有。

如果直接信它，用户以为"可恢复"，实际数据已经丢了。所以 `recycle.mjs` 的做法是：

1. 删除前数一遍回收站里的 `$I` 条目数；
2. 删除后数一遍；
3. **数量没增加就判定为永久删除，报错**。

宁可删不掉，也不能把"可恢复"变成谎话。

### 2. node 用管道捕获子进程输出会 EPERM

DSH 沙箱的 `piped grandchild spawn EPERM`。所以调用 PowerShell 必须
`stdio: 'ignore'` + 看退出码；需要拿返回值时，让 PowerShell 写临时文件、node 再读回来。

### 3. `endsWith('recycle.mjs')` 当入口判断会被同后缀文件名误命中

`diag-recycle.mjs` 也满足 `endsWith('recycle.mjs')`，于是 import 它时 CLI 主逻辑跟着跑了，
脚本在第 13 行就"停住"，查了很久。正确做法是比较 `import.meta.url` 解析后的完整路径：

```js
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
```

### 4. Shell.Application Namespace(10) 在沙箱下看不到回收站

项目数为 0，但 `$I` 记录明明在。改成直接解析
`<盘>:\$Recycle.Bin\<SID>\$I*`（8B header + 8B size + 8B FILETIME + 4B 路径长度 + UTF-16 路径）才可靠。

### 5. 会话日志是多帧 zstd，`zstdDecompressSync` 只吃第一帧

`session.v<N>.jsonl.zstd` 每个事件一个 frame（实测某会话 172 事件 = 93 帧）。
Node 自带的解压 API 和 `createZstdDecompress` 流都只返回第一帧。
必须自己扫 frame 边界（zstd 魔数 `0x28 B5 2F FD`）逐帧解压 —— 见 `zstd-session.mjs`。

### 6. 「有产出」的判据要跟着 DSH 的规则走

复刻 `@deepseek-ai/dsh-client-ui-deliverables` 的 `turn-deliverables`：
只认**成功的**写文件类调用（`write` / `edit` / `str_replace_editor` / `present`）。
成功判据看 `tool/result` 里 `message.content[].isError` 和 `data.error`，
失败的写调用**不算产出**（否则一次失败的 write 会凭空造出一个"产出目录"）。

**PTC 模式要另算一条**（2026-10-15 实测修过）：`run_code` 里嵌套的 `tools.write` 不产生
`tool/call`，只有 `tool/ptc-dispatch`，而且它**自带 `isError`**（不必去 `tool/result` 里找）。
所以 `producedPathsFromEvents` 同时扫这两种事件。回归测试：`node test/ptc.test.mjs`。

### 7. 会话日志的文件名带版本号，别写死

`session.v3.jsonl.zstd` → `session.v4.jsonl.zstd`（0.2.x 已升 v4）。
按固定文件名找日志会找不到；用 `session.v*.jsonl*` 匹配，并保留兜底扫描。

### 8. 改 profile 的 `package.json` 必须无 BOM

见上面「手动安装」里的说明。

## License

MIT
