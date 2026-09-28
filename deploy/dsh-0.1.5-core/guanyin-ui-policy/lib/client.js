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

    function matching(root, selector) {
      const matches = root.nodeType === Node.ELEMENT_NODE && root.matches?.(selector) ? [root] : []
      return matches.concat([...root.querySelectorAll(selector)])
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
        if (node.parentElement?.closest('script,style,pre,code,textarea,[data-guanyin-managed]')) return
        const next = branded(node.nodeValue)
        if (next !== node.nodeValue) node.nodeValue = next
      })

      root.querySelectorAll('[title],[aria-label],[alt]').forEach((element) => {
        if (element.closest('[data-guanyin-managed]')) return
        for (const attribute of ['title', 'aria-label', 'alt']) {
          if (!element.hasAttribute(attribute)) continue
          const value = element.getAttribute(attribute)
          const next = branded(value)
          if (next !== value) element.setAttribute(attribute, next)
        }
      })

      matching(root, '.dcu-brand').forEach((brand) => {
        if (brand.dataset.guanyinBrand === 'true') return
        brand.dataset.guanyinBrand = 'true'
        brand.setAttribute('aria-label', '观因 · 新建任务')
        brand.innerHTML = '<img src="/__guanyin/brand/logo.png" alt=""><strong>观因</strong>'
      })

      matching(root, '[class*="_titleGroup"] > span:first-child').forEach((title) => {
        if (textOf(title) === '探索未至之境') title.textContent = '让智能，安全服务每个团队。'
      })
    }

    function installBrandStyles() {
      if (document.querySelector('#guanyin-brand-styles')) return
      const style = document.createElement('style')
      style.id = 'guanyin-brand-styles'
      style.textContent = `
        .dcu-brand[data-guanyin-brand=true] { gap:9px; color:var(--dcu-sidebar-primary); }
        .dcu-brand[data-guanyin-brand=true] img { flex:none; width:25px; height:25px; object-fit:contain; }
        .dcu-brand[data-guanyin-brand=true] strong { overflow:hidden; font-size:18px; line-height:24px; font-weight:650; letter-spacing:.08em; text-overflow:ellipsis; white-space:nowrap; }
        .dcu-guanyin-identity { display:grid; grid-template-columns:30px minmax(0,1fr); gap:9px; align-items:center; margin:0 8px 8px; padding:10px 4px 2px; border-top:1px solid var(--dcu-sidebar-border); color:var(--dcu-sidebar-primary); }
        .dcu-guanyin-avatar { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; color:#fff; background:#376c64; font-size:12px; font-weight:700; }
        .dcu-guanyin-copy { display:flex; flex-direction:column; min-width:0; line-height:1.35; }
        .dcu-guanyin-copy strong,.dcu-guanyin-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .dcu-guanyin-copy strong { font-size:12px; font-weight:600; }
        .dcu-guanyin-copy small { color:var(--dcu-sidebar-secondary); font-size:10px; }
        .dcu-guanyin-impersonated { color:#d66b5d!important; }
        .dcu-root.dcu-compact .dcu-brand[data-guanyin-brand=true] strong,.dcu-root.dcu-compact .dcu-guanyin-copy { display:none; }
        .dcu-root.dcu-compact .dcu-guanyin-identity { grid-template-columns:30px; justify-content:center; margin-inline:5px; padding-inline:0; }
      `
      document.head.append(style)
    }

    function renderIdentityFooter() {
      installBrandStyles()
      document.querySelector('[data-guanyin-shell]')?.remove()
      const footer = document.querySelector('.dcu-foot')
      if (!footer) return
      let panel = footer.querySelector('[data-guanyin-identity]')
      if (!panel) {
        panel = document.createElement('div')
        panel.dataset.guanyinIdentity = 'true'
        panel.dataset.guanyinManaged = 'true'
        footer.append(panel)
      }
      const displayName = identity?.user?.displayName || identity?.user?.username || '已登录用户'
      const initial = Array.from(displayName)[0] || '观'
      const spaceName = identity?.space?.name || 'Agent 工作空间'
      const tenantName = identity?.tenant?.name || ''
      const role = roleNames[identity?.space?.role] || identity?.space?.role || '空间成员'
      panel.className = 'dcu-guanyin-identity'
      const detail = [tenantName, spaceName, role].filter(Boolean).join(' · ')
      const content = `<span class="dcu-guanyin-avatar">${escapeHtml(initial)}</span><span class="dcu-guanyin-copy"><strong${identity?.impersonated ? ' class="dcu-guanyin-impersonated"' : ''}>${escapeHtml(displayName)}${identity?.impersonated ? ' · 代入访问' : ''}</strong><small title="${escapeHtml(detail)}">${escapeHtml(detail)}</small></span>`
      if (panel.innerHTML !== content) panel.innerHTML = content
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
      renderIdentityFooter()
    }

    function enforcePolicy(root = document) {
      applyBranding(root)
      removeCodexSidebarExtensions(root)
      removeCompanionManagement(root)
      removePluginExternalActions(root)
      removeManagedSettings(root)
      renderIdentityFooter()
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return

      const start = () => {
        enforcePolicy()
        void loadIdentity()
        const pendingRoots = new Set()
        let timer
        const flush = () => {
          timer = undefined
          const roots = [...pendingRoots]
          pendingRoots.clear()
          roots.forEach(root => enforcePolicy(root))
        }
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement
            if (!target || target.closest?.('[data-guanyin-managed]')) continue
            pendingRoots.add(target)
          }
          if (pendingRoots.size && timer === undefined) timer = setTimeout(flush, 100)
        })
        observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true })
        return () => { observer.disconnect(); if (timer !== undefined) clearTimeout(timer) }
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
