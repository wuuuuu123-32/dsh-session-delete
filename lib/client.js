// dsh-session-delete（客户端半边）
//
// 在会话行的「⋯」菜单里提供两件事：
//   1) 「删除会话」   —— 删当前这一条，弹确认框（显示产出清单/占用，必须勾选才能删）
//   2) 「批量删除会话」—— 打开一个面板，多选后一次删掉
// 删除是**移入回收站**，不是永久删除；确认框里明说，产出默认原地保留。
//
// 为什么不做 DOM 注入：本机 DSH 0.2.0-rc.2 的
// `sidebar.workspaces.session.menu.item` 是官方开放的正规插槽，
// 内置的 pin/rename/fork/archive 就注册在这里。
//
// 本文件是手写的模块表产物（与 dsh-better-sidebar 的 lib/client.js 同协议），
// 因此不需要构建步骤：工厂函数收 `require`，最后交出 apply / inject。
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // 只声明 slots（注册插槽的硬依赖）。locale 与 sessions 都通过 ctx.get() 惰性访问，
    // 声明成必需反而会让插件在缺这些服务的客户端上永远等下去。
    const inject = ['slots'];

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const OVERLAY_SLOT = 'shell.overlay';
    const NS = 'session-delete';

    const DICT_ZH = {
      'menu.delete': '删除会话',
      'menu.batch': '批量删除会话…',
      'dialog.title': '删除会话',
      'dialog.batchTitle': '批量删除会话',
      'dialog.desc': '会话记录会移入回收站，误删可以从回收站还原。',
      'dialog.batchDesc': '选中的会话记录都会移入回收站，误删可以从回收站还原。',
      'dialog.session': '会话：',
      'dialog.sessionId': '会话 id：',
      'dialog.produced': '这些会话在工作区里留下了产出：',
      'dialog.producedOne': '这个会话在工作区里留下了产出目录：',
      'dialog.looseFiles':
        '另外，这个会话还写过工作区根目录下的这些文件 —— 它们通常是跨对话公用的（日志、AGENTS.md 之类），不会被移动：',
      'dialog.producedItem': '{name}（{count} 个文件，{size}）',
      'dialog.sharedDirs':
        '下面这些目录里只有一部分文件是本会话写的（目录本身是公用的），不会被移动：',
      'dialog.sharedItem': '{name} —— 本会话写了 {count}/{total} 个文件（{size}），整个目录 {totalSize}',
      'dialog.deleteProducedHintShared':
        '只有整棵目录都属于本会话的产出才会被移动；公用目录里被你写过的文件会原地保留。',
      'dialog.records': '会话记录占用合计：{size}',
      'dialog.willRecycle': '以上记录将移入回收站（可从回收站还原）。',
      'dialog.deleteProduced': '把上面的产出目录也一并移入回收站',
      'dialog.deleteProducedHint': '不勾选则产出目录原封不动留在工作区。根目录的公用文件无论如何都不会被动。',
      'dialog.running': '这个会话正在运行，不能删除。请先中断当前回合或等它结束。',
      'dialog.runningSome': '有 {count} 个选中会话正在运行，先中断它们再删。',
      'dialog.runningBadge': '运行中',
      'dialog.ack': '我已了解后果',
      'dialog.cancel': '取消',
      'dialog.confirm': '移入回收站',
      'dialog.deleting': '处理中…',
      'dialog.scanning': '正在检查产出…',
      'dialog.noProduced': '没有在工作区留下产出。',
      'dialog.notFound': '找不到这些会话（可能已经被删除）。',
      'dialog.untitled': '（无标题）',
      'dialog.multi': '共 {count} 个会话',
      'panel.title': '批量删除会话',
      'panel.desc': '勾选要删除的会话，然后确认。展示的产出只统计选中项。',
      'panel.selectAll': '全选',
      'panel.clear': '清空',
      'panel.selected': '已选 {count} 个',
      'panel.loading': '正在读取会话列表…',
      'panel.checking': '正在检查选中项的产出…',
      'panel.empty': '没有可删除的会话。',
      'panel.needSelect': '先勾选至少一个会话。',
      'panel.next': '下一步：确认删除',
      'panel.onlySidebar': '只看侧边栏里的会话',
      'panel.notInSidebar': '子代理/未分组',
      'panel.hiddenHint': '另有 {count} 个未显示（取消勾选「只看侧边栏里的会话」即可看到）',
    };
    const DICT_EN = {
      'menu.delete': 'Delete session',
      'menu.batch': 'Delete multiple sessions…',
      'dialog.title': 'Delete session',
      'dialog.batchTitle': 'Delete multiple sessions',
      'dialog.desc': 'The session record is moved to the Recycle Bin and can be restored from there.',
      'dialog.batchDesc': 'The selected session records are moved to the Recycle Bin and can be restored from there.',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session id: ',
      'dialog.produced': 'These sessions left output in the workspace:',
      'dialog.producedOne': 'This session left output folders in the workspace:',
      'dialog.looseFiles':
        'Also, the session wrote these files at the workspace root. They are usually shared across conversations (logs, AGENTS.md and so on) and will NOT be moved:',
      'dialog.producedItem': '{name} ({count} files, {size})',
      'dialog.sharedDirs':
        'In the folders below only some files were written by this session (the folder itself is shared), so they will NOT be moved:',
      'dialog.sharedItem': '{name} — this session wrote {count}/{total} files ({size}); the whole folder is {totalSize}',
      'dialog.deleteProducedHintShared':
        'Only folders that belong entirely to this session are moved; files you wrote inside shared folders stay where they are.',
      'dialog.records': 'Session records total: {size}',
      'dialog.willRecycle': 'The records above are moved to the Recycle Bin (recoverable).',
      'dialog.deleteProduced': 'Also move the output folders above to the Recycle Bin',
      'dialog.deleteProducedHint':
        'Leave unchecked to keep the output folders untouched. Shared files at the workspace root are never touched.',
      'dialog.running': 'This session is running and cannot be deleted. Stop the current turn first.',
      'dialog.runningSome': '{count} selected sessions are running. Stop them first.',
      'dialog.runningBadge': 'running',
      'dialog.ack': 'I understand the consequences',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Move to Recycle Bin',
      'dialog.deleting': 'Working…',
      'dialog.scanning': 'Checking output…',
      'dialog.noProduced': 'No output was left in the workspace.',
      'dialog.notFound': 'These sessions were not found (they may already be deleted).',
      'dialog.untitled': '(untitled)',
      'dialog.multi': '{count} sessions',
      'panel.title': 'Delete multiple sessions',
      'panel.desc': 'Tick the sessions to delete, then confirm. Output is only counted for ticked rows.',
      'panel.selectAll': 'Select all',
      'panel.clear': 'Clear',
      'panel.selected': '{count} selected',
      'panel.loading': 'Loading sessions…',
      'panel.checking': 'Checking output for the selection…',
      'panel.empty': 'No sessions to delete.',
      'panel.needSelect': 'Tick at least one session first.',
      'panel.next': 'Next: confirm deletion',
      'panel.onlySidebar': 'Sidebar sessions only',
      'panel.notInSidebar': 'subagent/ungrouped',
      'panel.hiddenHint': '{count} more hidden (untick "Sidebar sessions only" to show them)',
    };

    let dict = DICT_ZH;
    function t(key, params) {
      let text = dict[key] ?? DICT_ZH[key] ?? key;
      if (params) for (const k of Object.keys(params)) text = text.split('{' + k + '}').join(String(params[k]));
      return text;
    }

    function formatBytes(n) {
      if (!n || n <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let v = n;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
    }

    // 当前请求：菜单项/面板写入，overlay 弹窗读取
    let activeRequest = null;
    const subscribers = new Set();
    function setActiveRequest(next) {
      activeRequest = next;
      for (const fn of subscribers) {
        try {
          fn(next);
        } catch (e) {
          console.warn('[session-delete] subscriber failed', e);
        }
      }
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (e) {
        /* 保持空对象 */
      }
      return { ok: res.ok, status: res.status, data };
    }

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      let data = {};
      try {
        data = await res.json();
      } catch (e) {
        /* 保持空对象 */
      }
      return { ok: res.ok, status: res.status, data };
    }

    /** 共用：关掉父菜单（父组件可能已卸载，忽略错误） */
    function closeMenu(setMenuOpen) {
      try {
        setMenuOpen(false);
      } catch (e) {
        /* 忽略 */
      }
    }

    // ────────────────────────── 菜单项 ──────────────────────────

    /** 单个删除：先 scan，再弹确认框 */
    function DeleteSessionMenuItem(props) {
      const sessionId = props.sessionId;
      const displayTitle = props.displayTitle;
      const setMenuOpen = props.useMenuOpenState ? props.useMenuOpenState()[1] : () => {};

      const onSelect = () => {
        closeMenu(setMenuOpen);
        setActiveRequest({ mode: 'single', ids: [sessionId], title: displayTitle, scans: null, scanning: true, error: null });
        postJson('/__session-delete/scan', { sessionIds: [sessionId] })
          .then((r) => {
            if (!activeRequest || activeRequest.mode !== 'single') return;
            const okScan = r.ok && r.data && r.data.ok;
            setActiveRequest({
              ...activeRequest,
              scanning: false,
              scans: okScan ? r.data.scans : null,
              error: okScan ? null : (r.data && r.data.error) || 'scan failed (HTTP ' + r.status + ')',
            });
          })
          .catch((e) => {
            if (!activeRequest || activeRequest.mode !== 'single') return;
            setActiveRequest({ ...activeRequest, scanning: false, error: String(e && e.message ? e.message : e) });
          });
      };

      // 图标名按实际导出取（IconDeleteOutlineRegular 不存在，正确的是 IconTrash*）
      const Icon = P.IconTrashOutlineRegular || P.IconDeleteOutlineRegular;
      return React.createElement(
        P.MenuItemButton,
        { icon: Icon ? React.createElement(Icon, { size: 14 }) : undefined, onSelect: onSelect },
        t('menu.delete')
      );
    }

    /** 批量删除：打开多选面板 */
    function BatchDeleteMenuItem(props) {
      const sessionId = props.sessionId;
      const setMenuOpen = props.useMenuOpenState ? props.useMenuOpenState()[1] : () => {};

      const onSelect = () => {
        closeMenu(setMenuOpen);
        setActiveRequest({
          mode: 'batch',
          ids: [],
          selectedIds: sessionId ? [sessionId] : [], // 默认把点开菜单这条勾上
          title: null,
          scans: null,
          scanning: false,
          error: null,
          sessions: null,
          loading: true,
        });
        getJson('/__session-delete/list')
          .then((r) => {
            if (!activeRequest || activeRequest.mode !== 'batch') return;
            const okList = r.ok && r.data && r.data.ok;
            setActiveRequest({
              ...activeRequest,
              loading: false,
              sessions: okList ? r.data.sessions : [],
              error: okList ? null : (r.data && r.data.error) || 'list failed (HTTP ' + r.status + ')',
            });
          })
          .catch((e) => {
            if (!activeRequest || activeRequest.mode !== 'batch') return;
            setActiveRequest({ ...activeRequest, loading: false, sessions: [], error: String(e && e.message ? e.message : e) });
          });
      };

      const Icon = P.IconTrashOutlineRegular || P.IconDeleteOutlineRegular;
      return React.createElement(
        P.MenuItemButton,
        { icon: Icon ? React.createElement(Icon, { size: 14 }) : undefined, onSelect: onSelect },
        t('menu.batch')
      );
    }

    // ────────────────────────── 批量面板 ──────────────────────────

    const panelStyles = {
      list: { maxHeight: 300, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2,#ddd)', borderRadius: 8, margin: '8px 0' },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1,#eee)' },
      title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      id: { color: '#999', fontSize: 11, fontFamily: 'monospace' },
      badge: { color: '#c60', fontSize: 11, border: '1px solid #c60', borderRadius: 4, padding: '0 4px' },
      badgeDim: { color: '#999', fontSize: 11, border: '1px solid #ccc', borderRadius: 4, padding: '0 4px' },
      bar: { display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0', flexWrap: 'wrap' },
      link: { background: 'none', border: 0, color: 'var(--dsw-alias-link,#06c)', cursor: 'pointer', padding: 0, font: 'inherit' },
      check: { fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' },
      hint: { color: '#999', fontSize: 12, marginBottom: 4 },
    };

    function BatchDeletePanel() {
      const [state, setState] = React.useState(activeRequest);
      // 默认只列**侧边栏看得见的主会话**：子代理会话（投影缓存用裸 uuid 存、不上侧边栏）
      // 有几十条，混在一起会让顺序看着很乱。
      const [onlySidebar, setOnlySidebar] = React.useState(true);

      // 只订阅一次；选中项放在 activeRequest.selectedIds 里，保持单一数据源
      React.useEffect(() => {
        const fn = (next) => setState(next);
        subscribers.add(fn);
        return () => {
          subscribers.delete(fn);
        };
      }, []);

      if (!state || state.mode !== 'batch') return null;

      const all = state.sessions || [];
      const sessions = onlySidebar ? all.filter((s) => s.inSidebar !== false) : all;
      const hiddenCount = all.length - sessions.length;
      const chosen = new Set(state.selectedIds || []);
      const runningChosen = sessions.filter((s) => chosen.has(s.sessionId) && s.running);
      const canNext = chosen.size > 0 && runningChosen.length === 0 && !state.loading && !state.error;

      const setChosen = (nextSet) => {
        setActiveRequest({ ...state, selectedIds: [...nextSet] });
      };

      const toggle = (id) => {
        const nextSet = new Set(chosen);
        if (nextSet.has(id)) nextSet.delete(id);
        else nextSet.add(id);
        setChosen(nextSet);
      };

      // 切回「只看侧边栏」时，把被隐藏的勾选一并去掉，避免"看不见却被删"
      const toggleOnlySidebar = (next) => {
        setOnlySidebar(next);
        if (next) {
          const visible = new Set(all.filter((s) => s.inSidebar !== false).map((s) => s.sessionId));
          setChosen(new Set([...chosen].filter((id) => visible.has(id))));
        }
      };

      const selectAll = () => setChosen(new Set(sessions.filter((s) => !s.running).map((s) => s.sessionId)));
      const clearAll = () => setChosen(new Set());

      const close = () => {
        setActiveRequest(null);
      };

      // 下一步：只扫描选中的那几个（避免几十个会话全扫一遍）
      const next = () => {
        if (!canNext) return;
        const ids = [...chosen];
        const titles = new Map(sessions.map((s) => [s.sessionId, s.title]));
        setActiveRequest({
          mode: 'confirm',
          ids,
          title: ids.length === 1 ? titles.get(ids[0]) : null,
          scans: null,
          scanning: true,
          error: null,
          fromBatch: true,
        });
        postJson('/__session-delete/scan', { sessionIds: ids })
          .then((r) => {
            if (!activeRequest || activeRequest.mode !== 'confirm') return;
            const okScan = r.ok && r.data && r.data.ok;
            setActiveRequest({
              mode: 'confirm',
              ids,
              title: ids.length === 1 ? titles.get(ids[0]) : null,
              scans: okScan ? r.data.scans : null,
              scanning: false,
              error: okScan ? null : (r.data && r.data.error) || 'scan failed (HTTP ' + r.status + ')',
              fromBatch: true,
            });
          })
          .catch((e) => {
            if (!activeRequest || activeRequest.mode !== 'confirm') return;
            setActiveRequest({
              mode: 'confirm',
              ids,
              title: null,
              scans: null,
              scanning: false,
              error: String(e && e.message ? e.message : e),
              fromBatch: true,
            });
          });
      };

      const body = [];
      if (state.loading) body.push(React.createElement('div', { key: 'l', style: { color: '#888' } }, t('panel.loading')));
      if (state.error) body.push(React.createElement('div', { key: 'e', style: { color: '#c00' } }, state.error));

      if (!state.loading && sessions.length === 0 && !state.error) {
        body.push(React.createElement('div', { key: 'empty', style: { color: '#888' } }, t('panel.empty')));
      } else if (sessions.length > 0) {
        body.push(
          React.createElement('div', { key: 'bar', style: panelStyles.bar },
            React.createElement('button', { type: 'button', style: panelStyles.link, onClick: selectAll }, t('panel.selectAll')),
            React.createElement('button', { type: 'button', style: panelStyles.link, onClick: clearAll }, t('panel.clear')),
            React.createElement('label', { key: 'only', style: panelStyles.check },
              React.createElement('input', {
                type: 'checkbox',
                checked: onlySidebar,
                onChange: (e) => toggleOnlySidebar(e.target.checked),
              }),
              t('panel.onlySidebar')
            ),
            React.createElement('span', { key: 'n', style: { color: '#888', fontSize: 12 } }, t('panel.selected', { count: chosen.size }))
          )
        );
        if (hiddenCount > 0) {
          body.push(React.createElement('div', { key: 'hint', style: panelStyles.hint }, t('panel.hiddenHint', { count: hiddenCount })));
        }
        body.push(
          React.createElement('div', { key: 'list', style: panelStyles.list },
            sessions.map((s) =>
              React.createElement('label', { key: s.sessionId, style: panelStyles.row },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: chosen.has(s.sessionId),
                  disabled: s.running,
                  onChange: () => toggle(s.sessionId),
                }),
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: panelStyles.title }, s.title || t('dialog.untitled')),
                  React.createElement('div', { style: panelStyles.id }, s.sessionId)
                ),
                s.inSidebar === false
                  ? React.createElement('span', { key: 'off', style: panelStyles.badgeDim }, t('panel.notInSidebar'))
                  : null,
                s.running ? React.createElement('span', { key: 'run', style: panelStyles.badge }, t('dialog.runningBadge')) : null
              )
            )
          )
        );
      }

      if (runningChosen.length > 0) {
        body.push(React.createElement('div', { key: 'run', style: { color: '#c60' } }, t('dialog.runningSome', { count: runningChosen.length })));
      }

      const footer = [
        React.createElement(P.Button, { key: 'cancel', variant: 'outline', onClick: close }, t('dialog.cancel')),
        React.createElement(
          P.Button,
          { key: 'next', variant: 'outline', disabled: !canNext, onClick: next },
          t('panel.next')
        ),
      ];

      return React.createElement(
        P.Modal,
        { open: true, onClose: close, closeLabel: t('dialog.cancel'), title: t('panel.title'), description: t('panel.desc'), footer: React.createElement(React.Fragment, null, ...footer) },
        body
      );
    }

    // ────────────────────────── 确认框 ──────────────────────────

    function ConfirmDeleteDialog() {
      const [state, setState] = React.useState(activeRequest);
      const [ack, setAck] = React.useState(false);
      const [deleteProduced, setDeleteProduced] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        const fn = (next) => {
          // 批量面板阶段不显示确认框
          if (next && next.mode === 'batch') {
            setState(null);
            return;
          }
          setState(next);
          setAck(false);
          setDeleteProduced(false);
          setBusy(false);
          setError(null);
        };
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      }, []);

      if (!state || state.mode === 'batch') return null;

      const scans = state.scans || [];
      const running = scans.filter((s) => s.running);
      const notFound = !state.scanning && scans.length === 0 && !state.error;
      const totalProduced = scans.reduce((n, s) => n + ((s.producedTopEntries || []).length), 0);
      const recordBytes = scans.reduce((n, s) => n + (s.recordBytes || 0), 0);
      const canConfirm = ack && !busy && !state.scanning && running.length === 0 && scans.length > 0;

      const close = () => {
        if (busy) return;
        setActiveRequest(null);
      };

      const confirm = () => {
        if (!canConfirm) return;
        setBusy(true);
        setError(null);
        postJson('/__session-delete/delete', { sessionIds: state.ids, deleteProduced: deleteProduced })
          .then((r) => {
            if (!r.ok || !r.data || !r.data.ok) {
              const failed = ((r.data && r.data.results) || [])
                .filter((x) => !x.ok)
                .map((x) => x.error)
                .join('; ');
              throw new Error(failed || (r.data && r.data.error) || 'delete failed (HTTP ' + r.status + ')');
            }
            // 行消失靠 host 发的 api-session/removed 事件，这里只关弹窗
            setActiveRequest(null);
          })
          .catch((e) => {
            setBusy(false);
            setError(e && e.message ? e.message : String(e));
          });
      };

      const body = [];
      if (state.scanning) body.push(React.createElement('div', { key: 'scan', style: { color: '#888' } }, t('dialog.scanning')));
      if (running.length > 0)
        body.push(React.createElement('div', { key: 'run', style: { color: '#c60', marginBottom: 8 } }, t('dialog.running')));
      if (notFound) body.push(React.createElement('div', { key: 'nf', style: { color: '#c60' } }, t('dialog.notFound')));

      body.push(
        React.createElement('div', { key: 'meta', style: { marginBottom: 8, lineHeight: 1.7 } },
          state.ids.length > 1
            ? t('dialog.multi', { count: state.ids.length })
            : [t('dialog.session'), React.createElement('b', { key: 'n' }, state.title || t('dialog.untitled'))],
          React.createElement('br'),
          t('dialog.sessionId'),
          React.createElement('code', { key: 'id' }, state.ids.join(', '))
        )
      );

      // 有产出的会话可能不止一个：多于一个时用小标题标明是哪个会话，
      // 不要每个都重复一遍「这些会话在工作区里留下了产出」。
      const withProduced = scans.filter((s) => (s.producedTopEntries || []).length > 0);
      for (const scan of withProduced) {
        const entries = scan.producedTopEntries || [];
        const heading =
          withProduced.length > 1
            ? scan.title || t('dialog.untitled') + ' ' + scan.sessionId.slice(0, 8)
            : t('dialog.producedOne');
        body.push(
          React.createElement('div', { key: 'prod-' + scan.sessionId, style: { margin: '8px 0' } },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, heading),
            entries.map((e, i) =>
              React.createElement('div', { key: i, style: { paddingLeft: 12, fontFamily: 'monospace', fontSize: 12 } },
                t('dialog.producedItem', { name: e.name, count: e.fileCount || 0, size: formatBytes(e.bytes) })
              )
            )
          )
        );
      }

      // 部分命中的目录（目录是公用的，只有其中若干文件属于本会话）：绝不移动，只说明。
      // 老版本会把这种目录整棵移进回收站 —— 会话只是往 _hooks 里写了一个脚本，
      // 整个 _hooks 就被当成它的产出（2026-10-17 盲审的 P0）。
      const sharedDirs = [];
      for (const scan of scans) {
        for (const d of scan.producedSharedDirs || []) sharedDirs.push(d);
      }
      if (sharedDirs.length > 0) {
        body.push(
          React.createElement(
            'div',
            { key: 'shared', style: { margin: '10px 0', padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1,#f7f7f7)', color: '#666', fontSize: 12 } },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('dialog.sharedDirs')),
            sharedDirs.map((d, i) =>
              React.createElement('div', { key: i, style: { paddingLeft: 12, fontFamily: 'monospace' } },
                t('dialog.sharedItem', {
                  name: d.name,
                  count: d.producedFileCount ?? d.fileCount ?? 0,
                  total: d.totalFileCount ?? 0,
                  size: formatBytes(d.bytes),
                  totalSize: formatBytes(d.totalBytes ?? d.bytes),
                })
              )
            )
          )
        );
      }

      // 工作区根目录下的散文件（公用日志 / AGENTS.md 之类）：只提示，永不动它们
      const loose = [];
      for (const scan of scans) {
        for (const f of scan.producedLooseFiles || []) loose.push(f);
      }
      if (loose.length > 0) {
        body.push(
          React.createElement('div', { key: 'loose', style: { margin: '10px 0', padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1,#f7f7f7)', color: '#666', fontSize: 12 } },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('dialog.looseFiles')),
            loose.map((f, i) =>
              React.createElement('div', { key: i, style: { paddingLeft: 12, fontFamily: 'monospace' } },
                t('dialog.producedItem', { name: f.name, count: f.fileCount || 1, size: formatBytes(f.bytes) })
              )
            )
          )
        );
      }

      if (!state.scanning && scans.length > 0 && totalProduced === 0 && loose.length === 0 && sharedDirs.length === 0)
        body.push(React.createElement('div', { key: 'np', style: { color: '#888' } }, t('dialog.noProduced')));

      if (recordBytes > 0)
        body.push(React.createElement('div', { key: 'rec', style: { color: '#888', marginBottom: 8 } }, t('dialog.records', { size: formatBytes(recordBytes) })));

      if (totalProduced > 0) {
        body.push(
          React.createElement('label', { key: 'prodopt', style: { display: 'block', margin: '8px 0' } },
            React.createElement('input', {
              type: 'checkbox',
              checked: deleteProduced,
              disabled: busy,
              onChange: (e) => setDeleteProduced(e.target.checked),
            }),
            ' ',
            t('dialog.deleteProduced'),
            React.createElement('div', { style: { color: '#888', fontSize: 12, paddingLeft: 20 } }, t('dialog.deleteProducedHint'))
          )
        );
      }

      body.push(React.createElement('div', { key: 'will', style: { color: '#888', fontSize: 12 } }, t('dialog.willRecycle')));
      body.push(
        React.createElement('label', { key: 'ack', style: { display: 'block', marginTop: 12, fontWeight: 600 } },
          React.createElement('input', {
            type: 'checkbox',
            checked: ack,
            disabled: busy || running.length > 0,
            onChange: (e) => setAck(e.target.checked),
          }),
          ' ',
          t('dialog.ack')
        )
      );
      if (busy) body.push(React.createElement('div', { key: 'b', style: { marginTop: 8, color: '#888' } }, t('dialog.deleting')));
      if (error) body.push(React.createElement('div', { key: 'e', role: 'alert', style: { marginTop: 8, color: '#c00' } }, error));

      const footer = [
        React.createElement(P.Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: close }, t('dialog.cancel')),
        React.createElement(
          P.Button,
          { key: 'ok', variant: 'outline', disabled: !canConfirm, onClick: confirm, style: { color: '#d33' } },
          busy ? t('dialog.deleting') : t('dialog.confirm')
        ),
      ];

      return React.createElement(
        P.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t('dialog.cancel'),
          title: state.ids.length > 1 ? t('dialog.batchTitle') : t('dialog.title'),
          description: state.ids.length > 1 ? t('dialog.batchDesc') : t('dialog.desc'),
          footer: React.createElement(React.Fragment, null, ...footer),
        },
        body
      );
    }

    // ────────────────────────── 注册 ──────────────────────────

    function apply(ctx) {
      // 语言跟随界面；locale 服务不在时用内置字典
      try {
        const locale = ctx.get ? ctx.get('locale') : null;
        if (typeof locale === 'function') {
          // 某些版本 locale 是服务函数形式，取它的 register
          const svc = locale();
          if (svc && typeof svc.register === 'function') {
            ctx.effect(() => svc.register(NS, { zh: DICT_ZH, en: DICT_EN }));
          }
        } else if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: DICT_ZH, en: DICT_EN }));
        }
      } catch (e) {
        console.warn('[session-delete] locale registration skipped', e);
      }

      // 菜单项：单个删除（order 500，排在内置 archive 400 之后）与批量删除
      ctx.slots.inject(MENU_SLOT, function* () {
        yield ctx.slots.register(
          { name: MENU_SLOT, id: 'session-delete:delete', order: 500, locale: NS },
          DeleteSessionMenuItem
        );
        yield ctx.slots.register(
          { name: MENU_SLOT, id: 'session-delete:batch', order: 501, locale: NS },
          BatchDeleteMenuItem
        );
      });

      // 弹窗：批量面板 + 确认框
      ctx.slots.inject(OVERLAY_SLOT, function* () {
        yield ctx.slots.register({ name: OVERLAY_SLOT, id: 'session-delete:batch-panel', locale: NS }, BatchDeletePanel);
        yield ctx.slots.register({ name: OVERLAY_SLOT, id: 'session-delete:confirm', locale: NS }, ConfirmDeleteDialog);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
