window.__ModuleLoader__.load({
  id: '@guanyin/dsh-enterprise',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    let mermaidEngine
    function engine() {
      if (window.__GenuiAssets__?.mermaid) return Promise.resolve(window.__GenuiAssets__.mermaid)
      return mermaidEngine ||= new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = '/plugins/@changfenhuang/dsh-genui/assets/mermaid.js'
        script.onload = () => window.__GenuiAssets__?.mermaid ? resolve(window.__GenuiAssets__.mermaid) : reject(new Error('Mermaid engine unavailable'))
        script.onerror = () => reject(new Error('Mermaid asset unavailable'))
        document.head.append(script)
      })
    }
    // Share GenUI's local, sanitized Mermaid engine instead of shipping a
    // second 7 MB renderer. Keep the source available and leave streaming
    // fences alone; failed diagrams retain their ordinary code presentation.
    function installMermaid(ctx) {
      const owned = new Set()
      let stopped = false, timer
      let queue = Promise.resolve()
      function scan() {
        for (const entry of owned) if (!entry.block.isConnected) owned.delete(entry)
        for (const block of document.querySelectorAll('.md-code-block')) {
          if (block.dataset.guanyinMermaid || block.dataset.codeStreaming === 'true' || block.closest('[data-streaming]')) continue
          const language = (block.dataset.codeLanguage || block.children[0]?.children[0]?.children[0]?.textContent)?.trim().toLowerCase()
          if (language !== 'mermaid') continue
          const source = block.querySelector('pre')?.textContent
          if (!source?.trim()) continue
          block.dataset.guanyinMermaid = 'pending'
          queue = queue.catch(() => {}).then(async () => {
            try {
              const api = await engine()
              const svg = await api.renderMermaid(source, block)
              api.assertSafeSvg(svg)
              if (stopped || !block.isConnected) return
              const preview = document.createElement('div')
              preview.setAttribute('role', 'img'); preview.setAttribute('aria-label', 'Mermaid 图表')
              preview.style.cssText = 'padding:16px;overflow:auto;background:var(--dsw-alias-bg-layer-1);'
              const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
              preview.append(document.importNode(parsed.documentElement, true))
              const details = document.createElement('details')
              const summary = document.createElement('summary'); summary.textContent = '查看图表源码'
              details.append(summary)
              const original = [...block.children]
              details.append(...original)
              block.append(preview, details); block.dataset.guanyinMermaid = 'ready'
              owned.add({ block, preview, details, original })
            } catch { block.dataset.guanyinMermaid = 'failed' }
          })
        }
      }
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 100) })
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-streaming', 'data-code-streaming'] })
      scan()
      ctx.effect(() => () => {
        stopped = true; clearTimeout(timer); observer.disconnect()
        for (const { block, preview, details, original } of owned) {
          if (block.isConnected) { block.append(...original); preview.remove(); details.remove(); delete block.dataset.guanyinMermaid }
        }
      }, 'guanyin: shared Mermaid fences')
    }
    function Mark({ size = 24 }) {
      return h('span', { className: 'guanyin-brand-mark', 'aria-label': '观因', style: { width: size * 1.5, height: size, display: 'inline-block', flexShrink: 0, background: 'currentColor', mask: "url('/__guanyin/brand/logo.png') center / contain no-repeat", WebkitMask: "url('/__guanyin/brand/logo.png') center / contain no-repeat" } })
    }
    function Name() { return h('strong', { style: { fontSize: 18, letterSpacing: '0.08em' } }, '观因') }
    function installSessionDeletion(ctx) {
      const { Modal, Button, MenuItemButton, IconTrashOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
      let request = null
      const listeners = new Set()
      const update = value => { request = value; for (const listener of listeners) listener() }
      async function call(method, input, signal) {
        const response = await fetch(`/__guanyin/sessions/${method}`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-guanyin-action': 'session-delete' }, body: JSON.stringify(input) })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试')
        return result
      }
      function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
        const [, open] = useMenuOpenState()
        return h(MenuItemButton, { danger: true, separatorBefore: true, icon: IconTrashOutlineRegular ? h(IconTrashOutlineRegular, { size: 14 }) : undefined, onSelect: () => { open(false); update({ id: sessionId, title: displayTitle || '未命名会话' }) } }, '删除会话')
      }
      function DeleteDialog() {
        const value = React.useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => request, () => null)
        const [confirmation, setConfirmation] = React.useState(''), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [checked, setChecked] = React.useState(false)
        React.useEffect(() => {
          setConfirmation(''); setError(''); setChecked(false); setBusy(false)
          if (!value) return
          const abort = new AbortController()
          call('prepare', { sessionId: value.id }, abort.signal).then(result => setConfirmation(result.confirmation)).catch(e => { if (!abort.signal.aborted) setError(e.message) })
          return () => abort.abort()
        }, [value])
        if (!value) return null
        const close = () => { if (!busy) update(null) }
        const remove = async () => {
          if (busy || !checked || !confirmation) return
          setBusy(true); setError('')
          try {
            await call('delete', { sessionId: value.id, confirmation })
            const workspace = ctx.get('uiWorkspace')
            if (workspace?.mainReference?.sessionId === value.id) workspace.clearMain()
            update(null)
          } catch (e) { setError(e.message); setConfirmation('') }
          finally { setBusy(false) }
        }
        return h(Modal, { open: true, title: '删除会话', closeLabel: '关闭', onClose: close, description: `确定删除“${value.title}”吗？`, footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: busy, onClick: close }, '取消'),
          h(Button, { variant: 'danger', disabled: busy || !checked || !confirmation, onClick: remove }, busy ? '正在删除…' : '确认删除')) },
          h('p', null, '会话记录将被永久删除，无法通过取消归档恢复。工作目录文件及可能被其他会话引用的共享附件会保留。'),
          error ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : !confirmation ? h('p', { role: 'status' }, '正在检查会话状态…') : null,
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 18 } }, h('input', { type: 'checkbox', checked, disabled: busy || !confirmation, onChange: e => setChecked(e.target.checked) }), '我确认永久删除此会话'))
      }
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'guanyin-delete', order: 440 }, DeleteMenuItem))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'guanyin-session-delete', order: 110 }, DeleteDialog))
      ctx.effect(() => () => { request = null; listeners.clear() }, 'guanyin: delete dialog cleanup')
    }
    // Presentation-only rc3 adapter. Keep third-party skill IDs, paths and
    // operations intact; upstream upgrades need only recheck these selectors.
    function installEnterpriseSettings(ctx) {
      const style = document.createElement('style')
      style.dataset.guanyinSettings = ''
      style.textContent = `
        /* rc3 SettingsDocumentAction: shared by every settings section. */
        .me01iq_action,
        .dssm-feedback-links,
        #dssm-tab-repositories { display: none !important; }
        /* Upstream sizes both tracks and its sliding indicator for four tabs.
           Use three real tracks and let each visible tab own its selection. */
        .dssm-scope-tabs[role="tablist"] {
          grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
          gap: 4px !important; height: 38px !important;
          min-height: 38px !important; max-height: 38px !important;
          padding: 3px !important;
        }
        .dssm-scope-tabs > span[aria-hidden="true"],
        .dssm-scope-tabs > [class*="indicator"] { display: none !important; }
        .dssm-scope-tabs[role="tablist"] [role="tab"] {
          width: 100% !important; min-width: 0; height: 30px !important;
          position: relative; border: 1px solid transparent !important;
          transition: background-color 150ms ease, color 150ms ease !important;
        }
        .dssm-scope-tabs[role="tablist"] [role="tab"][aria-selected="true"] {
          background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.12)) !important;
          border-color: var(--dsw-alias-border-l3, rgba(127,127,127,.18)) !important;
          color: var(--dsw-alias-label-primary) !important;
        }
        .dssm-scope-tabs[role="tablist"] [role="tab"]:focus-visible {
          outline: 2px solid currentColor; outline-offset: -2px;
        }
        /* Drop the promotional card and give the remaining summary a full row. */
        .lc-card:has(.lc-pi-hint) { display: none !important; }
        .lc-cols.lc-head:has(.lc-pi-hint) {
          display: grid; grid-template-columns: minmax(0, 1fr);
        }
        [data-guanyin-advanced] a[href^="http://"],
        [data-guanyin-advanced] a[href^="https://"],
        [data-guanyin-advanced] p:has(a[href*="github.com/"]) { display: none !important; }
        .dssm-brand-icon[data-guanyin-mark] { color: inherit; }
        .dssm-brand-icon[data-guanyin-mark] > img { display: none !important; }
        .dssm-brand-icon[data-guanyin-mark]::before {
          content: ''; display: block; width: 20px; height: 16px;
          background: currentColor;
          mask: url('/__guanyin/brand/logo.png') center / contain no-repeat;
          -webkit-mask: url('/__guanyin/brand/logo.png') center / contain no-repeat;
        }
      `
      document.head.append(style)
      // Keep keyboard navigation aligned with the three visible tabs too.
      function navigateTabs(event) {
        const current = event.target.closest?.('.dssm-scope-tabs[role="tablist"] [role="tab"]')
        if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const tabs = [...current.parentElement.querySelectorAll('[role="tab"]')].filter(tab => tab.id !== 'dssm-tab-repositories')
        const index = tabs.indexOf(current)
        if (index < 0) return
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        event.preventDefault(); event.stopImmediatePropagation()
        tabs[next].focus(); tabs[next].click()
      }
      document.addEventListener('keydown', navigateTabs, true)
      const renamed = new Map(), labels = new Map(), marks = new Set()
      let queued = false, stopped = false
      function scan() {
        queued = false
        if (stopped) return
        for (const node of renamed.keys()) if (!node.isConnected) renamed.delete(node)
        for (const node of labels.keys()) if (!node.isConnected) labels.delete(node)
        for (const node of marks) if (!node.isConnected) marks.delete(node)
        for (const title of document.querySelectorAll('.dssm-source-title, .dssm-menu-select-label, .dssm-source-select-menu')) {
          const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
          for (let node; (node = walker.nextNode());) {
            if (!/^DSH(?: skills)?(?:$| ·)/.test(node.textContent.trim())) continue
            renamed.set(node, node.textContent)
            node.textContent = node.textContent.replace(/DSH(?: skills)?/, '观因')
          }
        }
        for (const el of document.querySelectorAll('.dssm-sources [aria-label]')) {
          const label = el.getAttribute('aria-label')
          if (!/\bDSH\b/.test(label)) continue
          labels.set(el, label)
          el.setAttribute('aria-label', label.replace(/\bDSH\b/g, '观因'))
        }
        for (const img of document.querySelectorAll('.dssm-brand-icon > img[alt="DSH"]')) {
          const mark = img.parentElement
          if (!marks.has(mark)) { mark.dataset.guanyinMark = ''; marks.add(mark) }
        }
        // If discovery was active before a hot reload, return to local skills.
        if (document.querySelector('#dssm-tab-repositories[aria-selected="true"]')) {
          document.getElementById('dssm-tab-user')?.click()
        }
      }
      const observer = new MutationObserver(() => {
        if (!queued && !stopped) { queued = true; queueMicrotask(scan) }
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-selected', 'aria-label'] })
      scan()
      ctx.effect(() => () => {
        stopped = true; observer.disconnect(); style.remove()
        document.removeEventListener('keydown', navigateTabs, true)
        for (const [node, text] of renamed) if (node.isConnected && node.textContent === text.replace(/DSH(?: skills)?/, '观因')) node.textContent = text
        for (const [el, label] of labels) if (el.isConnected && el.getAttribute('aria-label') === label.replace(/\bDSH\b/g, '观因')) el.setAttribute('aria-label', label)
        for (const mark of marks) delete mark.dataset.guanyinMark
      }, 'guanyin: enterprise settings presentation')
    }
    // Upstream moved feature settings onto the plugin-manager page. Expose
    // its contributed forms in Settings without enabling plugin installation.
    function advancedSettings(ctx) {
      return function AdvancedSettings({ renderSlot }) {
        const revision = () => `${ctx.slots.getVersion('plugins.item')}:${ctx.slots.getVersion('plugins.bundle.config')}`
        React.useSyncExternalStore(listener => {
          const offItem = ctx.slots.subscribe('plugins.item', listener)
          const offBundle = ctx.slots.subscribe('plugins.bundle.config', listener)
          return () => { offItem(); offBundle() }
        }, revision, revision)
        const rows = [
          ...ctx.slots.entries('plugins.item').map(e => ({ id: e.options.id, slot: 'plugins.item', options: { only: e.options.id }, label: ({ 'agent-loop': '智能体循环', subagent: '子智能体', shell: '终端' })[e.options.id] || (typeof e.options.label === 'function' ? e.options.label() : e.options.label || e.options.id) })),
          ...ctx.slots.entries('plugins.bundle.config').map(e => ({ id: e.options.key, slot: 'plugins.bundle.config', options: { entryKey: e.options.key }, label: ({ '@michengai/dsh-skills-manager': '技能', 'dsh-context': '上下文分析', '@changfenhuang/dsh-genui': '交互界面' })[e.options.key] || e.options.key })),
        ]
        const [selected, select] = React.useState('')
        const active = rows.find(r => r.id === selected) || rows[0]
        return h('section', { 'data-guanyin-advanced': '', style: { maxWidth: 850 } },
          h('h2', null, '高级设置'),
          h('p', { style: { opacity: 0.65, fontSize: 13 } }, '配置空间的运行行为和内置功能。Agent 的工具组合和工作方式在“Agent 预设”中管理。'),
          h('div', { role: 'tablist', 'aria-label': '高级设置分类', style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '20px 0' } }, rows.map(row => h('button', { key: row.id, role: 'tab', 'aria-selected': row === active, onClick: () => select(row.id), style: { cursor: 'pointer', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', color: 'inherit', background: row === active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' } }, row.label))),
          active ? h('div', { role: 'tabpanel' }, renderSlot(active.slot, { view: 'page' }, active.options)) : h('p', null, '当前没有可配置的功能。'))
      }
    }
    function Identity({ wide = true }) {
      const [value, setValue] = React.useState(null)
      React.useEffect(() => {
        const abort = new AbortController()
        fetch('/__guanyin/identity', { signal: abort.signal, cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(setValue).catch(() => {})
        return () => abort.abort()
      }, [])
      if (!value) return null
      const role = { owner: '空间所有者', operator: '空间管理员', member: '空间成员', platform_admin: '平台管理员' }[value.space?.role]
      const label = [value.user?.displayName || value.user?.username, value.tenant?.name, value.space?.name, role, value.impersonated ? '管理员代入' : ''].filter(Boolean).join(' · ')
      return h('a', { href: '/console?from=dsh', title: label + ' · 返回观因控制台', 'aria-label': label + ' · 返回观因控制台', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 6px', borderTop: '1px solid var(--dsw-alias-border-primary)', color: 'inherit', textDecoration: 'none', minWidth: 0 } },
        h('span', { 'aria-hidden': true }, '↩'), wide && h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 } }, label))
    }
    function Connectors() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [revision, refresh] = React.useState(0)
      React.useEffect(() => {
        const abort = new AbortController()
        setError(''); setData(null)
        fetch('/__guanyin/connectors', { signal: abort.signal, cache: 'no-store' }).then(async r => {
          if (!r.ok) throw new Error('连接器读取失败，请稍后刷新')
          return r.json()
        }).then(setData).catch(e => { if (!abort.signal.aborted) setError(e.message) })
        return () => abort.abort()
      }, [revision])
      const labels = { disabled: '已禁用', 'tools-registered': '工具已注册', 'no-tools': '尚无注册工具' }
      return h('section', { style: { maxWidth: 900 } },
        h('h2', null, '连接器'),
        h('p', { style: { opacity: 0.7 } }, '查看此空间已配置的 MCP。注册、授权和接入在观因平台的空间管理 → MCP 中完成。'),
        h('button', { onClick: () => refresh(v => v + 1), disabled: !data && !error }, '刷新连接器'),
        h('p', { style: { fontSize: 13, opacity: 0.65 } }, '以下状态表示工具注册情况，不代表实时连通性；未发现工具可能是服务未就绪、连接异常或服务仅提供资源。'),
        error ? h('p', { role: 'alert' }, error) : !data ? h('p', null, '正在读取连接器…') : !data.servers.length ? h('p', null, '当前空间尚未配置 MCP 连接器。') :
          data.servers.map(server => h('article', { key: server.id, style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: 18, marginTop: 14 } },
            h('h3', { style: { marginTop: 0 } }, server.name),
            h('p', null, `${labels[server.status] || '状态未知'} · ${server.source} · ${server.transport} · ${server.tools.length} 个工具`),
            server.endpoint && h('p', { style: { overflowWrap: 'anywhere', opacity: 0.7 } }, server.endpoint),
            server.tools.length > 0 && h('details', null, h('summary', null, '查看工具列表'), h('ul', null, server.tools.map(tool => h('li', { key: tool.name, style: { marginTop: 10 } }, h('strong', null, tool.name), tool.description && h('p', { style: { whiteSpace: 'pre-wrap', opacity: 0.7 } }, tool.description)))))
          )))
    }
    function apply(ctx) {
      installMermaid(ctx)
      installEnterpriseSettings(ctx)
      installSessionDeletion(ctx)
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'guanyin-connectors', label: '连接器', order: 16 }, Connectors))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'guanyin-advanced', label: '高级设置', order: 15,
        children: { 'plugins.item': { kind: 'list', scope: 'root' }, 'plugins.bundle.config': { kind: 'keyed', scope: 'root' } },
      }, advancedSettings(ctx)))
      ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, Mark))
      ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, Name))
      ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Mark))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'guanyin-identity', order: 100 }, Identity))
      document.title = '观因智能空间'
      const icon = document.createElement('link')
      icon.rel = 'icon'; icon.href = '/__guanyin/brand/favicon.png'
      document.querySelectorAll('link[rel~="icon"]').forEach(e => e.remove())
      document.head.append(icon)
      ctx.effect(() => () => icon.remove(), 'guanyin: favicon')
    }
    return { inject: ['slots'], apply }
  },
})
