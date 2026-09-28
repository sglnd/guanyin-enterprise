window.__ModuleLoader__.load({
  id: '@guanyin/dsh-ui-policy',
  factory: () => {
    const module = { exports: {} }

    const exactHiddenLabels = new Set([
      '扩展管理',
      '专家',
      '技能',
      '插件',
      '连接器',
      'IM助理',
      'Extensions',
      'Experts',
      'Skills',
      'Plugins',
      'Connectors',
      'IM Assistant',
    ])

    const hiddenSettingsLabels = new Set(['MCP'])

    const updateLabels = new Set([
      '检查更新',
      '重新检查',
      'Check for updates',
      'Check updates',
      'Recheck',
    ])

    const brandReplacements = [
      [/DeepSeek Harness/gi, '观因工作空间'],
      [/DeepSeek-Harness/gi, '观因工作空间'],
      [/\bDSH\b/g, '观因工作空间'],
    ]

    const roleNames = { owner: '空间负责人', operator: '空间管理员', member: '空间成员', platform_admin: '平台管理员' }
    let identity
    let identityRequested = false

    function textOf(element) {
      return (element.textContent || '').replace(/\s+/g, ' ').trim()
    }

    function removeCodexSidebarExtensions(root) {
      root.querySelectorAll('.dcu-extensions-group').forEach((element) => element.remove())

      root.querySelectorAll('.dcu-root button, .dcu-search-dialog button').forEach((button) => {
        if (exactHiddenLabels.has(textOf(button))) button.remove()
      })
    }

    function removeCompanionManagement(root) {
      root.querySelectorAll('.dcu-about').forEach((about) => {
        about.querySelectorAll('.dcu-about-links').forEach((element) => element.remove())

        const features = about.querySelector('.dcu-about-features')
        if (!features) return
        let sibling = features.nextElementSibling
        while (sibling) {
          const next = sibling.nextElementSibling
          sibling.remove()
          sibling = next
        }
      })
    }

    function isSettingsSurface(element) {
      return element.closest([
        '.dcu-about',
        '[class*="settings"]',
        '[class*="Settings"]',
        '[role="dialog"]',
      ].join(',')) !== null
    }

    function removePluginExternalActions(root) {
      root.querySelectorAll('[data-mpi-check], .mpi-check-host').forEach((element) => element.remove())

      root.querySelectorAll('a[href]').forEach((link) => {
        if (!isSettingsSurface(link)) return
        const href = link.getAttribute('href') || ''
        if (/^https:\/\/(?:www\.)?(?:github\.com|npmjs\.com)\//i.test(href)) link.remove()
      })

      root.querySelectorAll('button').forEach((button) => {
        if (isSettingsSurface(button) && updateLabels.has(textOf(button))) button.remove()
      })
    }

    function removeManagedSettings(root) {
      root.querySelectorAll('button, [role="tab"], [role="menuitem"], a').forEach((element) => {
        if (hiddenSettingsLabels.has(textOf(element)) && isSettingsSurface(element)) element.remove()
      })
    }

    function branded(value) {
      return brandReplacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(value || ''))
    }

    function applyBranding(root) {
      document.title = branded(document.title || '观因工作空间')
      if (!document.title.includes('观因')) document.title = `观因工作空间 · ${document.title}`

      let favicon = document.querySelector('link[data-guanyin-favicon]')
      if (!favicon) {
        favicon = document.createElement('link')
        favicon.rel = 'icon'
        favicon.type = 'image/png'
        favicon.dataset.guanyinFavicon = 'true'
        document.head.append(favicon)
      }
      favicon.href = '/__guanyin/brand/favicon.png'

      const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT)
      const nodes = []
      while (walker.nextNode()) nodes.push(walker.currentNode)
      nodes.forEach((node) => {
        if (node.parentElement?.closest('script,style,pre,code,textarea,[data-guanyin-shell]')) return
        const next = branded(node.nodeValue)
        if (next !== node.nodeValue) node.nodeValue = next
      })

      root.querySelectorAll('[title],[aria-label],[alt]').forEach((element) => {
        if (element.closest('[data-guanyin-shell]')) return
        for (const attribute of ['title', 'aria-label', 'alt']) {
          if (!element.hasAttribute(attribute)) continue
          const value = element.getAttribute(attribute)
          const next = branded(value)
          if (next !== value) element.setAttribute(attribute, next)
        }
      })
    }

    function installBrandStyles() {
      if (document.querySelector('#guanyin-brand-styles')) return
      const style = document.createElement('style')
      style.id = 'guanyin-brand-styles'
      style.textContent = `
        :root { --guanyin-ink:#282622; --guanyin-paper:#f7f4ed; --guanyin-line:#ded8cc; --guanyin-red:#aa3b2d; --guanyin-green:#376c64; }
        body { padding-top: 52px !important; }
        .guanyin-shell { position:fixed; z-index:2147483000; inset:0 0 auto; height:52px; display:flex; align-items:center; gap:14px; box-sizing:border-box; padding:0 18px; color:var(--guanyin-ink); background:rgba(247,244,237,.96); border-bottom:1px solid var(--guanyin-line); box-shadow:0 3px 14px rgba(40,38,34,.08); backdrop-filter:blur(12px); font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif; }
        .guanyin-shell__brand { display:flex; align-items:center; gap:9px; min-width:0; color:inherit; text-decoration:none; }
        .guanyin-shell__brand img { width:29px; height:29px; object-fit:contain; }
        .guanyin-shell__brand strong { font-size:14px; letter-spacing:.08em; white-space:nowrap; }
        .guanyin-shell__space { overflow:hidden; padding-left:14px; border-left:1px solid var(--guanyin-line); color:#6f6a61; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
        .guanyin-shell__identity { display:flex; align-items:center; gap:9px; margin-left:auto; min-width:0; }
        .guanyin-shell__avatar { display:grid; place-items:center; width:28px; height:28px; border-radius:9px; color:#fff; background:var(--guanyin-green); font-size:12px; font-weight:700; }
        .guanyin-shell__user { display:flex; flex-direction:column; min-width:0; line-height:1.25; }
        .guanyin-shell__user strong { max-width:180px; overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
        .guanyin-shell__user small { max-width:240px; overflow:hidden; color:#777168; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
        .guanyin-shell__back { padding:6px 10px; border:1px solid var(--guanyin-line); border-radius:8px; color:var(--guanyin-ink); background:#fff; font-size:11px; text-decoration:none; white-space:nowrap; }
        .guanyin-shell--impersonated { border-bottom-color:#d7a59d; background:rgba(255,242,239,.97); }
        .guanyin-shell__warning { padding:4px 8px; border-radius:999px; color:#8d2d22; background:#f5d9d4; font-size:10px; font-weight:700; white-space:nowrap; }
        @media (max-width:720px) { .guanyin-shell__space,.guanyin-shell__user small { display:none; } .guanyin-shell { padding:0 10px; gap:8px; } .guanyin-shell__brand strong { font-size:13px; } }
      `
      document.head.append(style)
    }

    function renderIdentityShell() {
      installBrandStyles()
      let shell = document.querySelector('[data-guanyin-shell]')
      if (!shell) {
        shell = document.createElement('header')
        shell.dataset.guanyinShell = 'true'
        document.body.prepend(shell)
      }
      const className = `guanyin-shell${identity?.impersonated ? ' guanyin-shell--impersonated' : ''}`
      if (shell.className !== className) shell.className = className
      const displayName = identity?.user?.displayName || identity?.user?.username || '已登录用户'
      const initial = Array.from(displayName)[0] || '观'
      const spaceName = identity?.space?.name || 'Agent 工作空间'
      const tenantName = identity?.tenant?.name || ''
      const role = roleNames[identity?.space?.role] || identity?.space?.role || '空间成员'
      const content = `<a class="guanyin-shell__brand" href="/console"><img src="/__guanyin/brand/logo.png" alt="观因"><strong>观因</strong></a><span class="guanyin-shell__space">${escapeHtml(spaceName)}</span>${identity?.impersonated ? '<span class="guanyin-shell__warning">管理员代入访问</span>' : ''}<div class="guanyin-shell__identity"><span class="guanyin-shell__avatar">${escapeHtml(initial)}</span><span class="guanyin-shell__user"><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml([tenantName, role].filter(Boolean).join(' · '))}</small></span><a class="guanyin-shell__back" href="/console">返回控制台</a></div>`
      if (shell.innerHTML !== content) shell.innerHTML = content
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
    }

    async function loadIdentity() {
      if (identityRequested) return
      identityRequested = true
      try {
        const response = await fetch('/__guanyin/identity', { credentials: 'same-origin', cache: 'no-store' })
        if (response.ok) identity = await response.json()
      } catch {}
      renderIdentityShell()
    }

    function enforcePolicy() {
      const root = document
      applyBranding(root)
      removeCodexSidebarExtensions(root)
      removeCompanionManagement(root)
      removePluginExternalActions(root)
      removeManagedSettings(root)
      renderIdentityShell()
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return

      const start = () => {
        enforcePolicy()
        void loadIdentity()
        const observer = new MutationObserver(() => enforcePolicy())
        observer.observe(document.documentElement, { childList: true, subtree: true })
        return () => observer.disconnect()
      }

      if (document.documentElement) {
        const dispose = start()
        if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose, 'guanyin: ui policy')
      } else {
        document.addEventListener('DOMContentLoaded', start, { once: true })
      }
    }

    module.exports = { inject: [], apply }
    return module.exports
  },
})
