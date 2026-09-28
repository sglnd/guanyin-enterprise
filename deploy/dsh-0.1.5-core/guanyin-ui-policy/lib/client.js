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
      matching(root, '[data-mpi-check], .mpi-check-host').forEach((element) => element.remove())

      matching(root, 'a[href]').forEach((link) => {
        if (!isSettingsSurface(link)) return
        const href = link.getAttribute('href') || ''
        if (/^https:\/\/(?:www\.)?(?:github\.com|npmjs\.com)\//i.test(href)) link.remove()
      })

      matching(root, 'button').forEach((button) => {
        const label = textOf(button)
        if ([...updateLabels].some(value => label.includes(value))) button.remove()
      })
    }

    function removeUpdateActionsImmediately(root) {
      if (!root) return
      matching(root, '[data-mpi-check], .mpi-check-host, button').forEach((element) => {
        if (element.matches('[data-mpi-check], .mpi-check-host') || [...updateLabels].some(value => textOf(element).includes(value))) {
          element.remove()
        }
      })
    }

    function removeContextPluginInfo(root) {
      matching(root, '.lc-pi-grid').forEach((grid) => grid.closest('.lc-card')?.remove())
    }

    function removeManagedSettings(root) {
      matching(root, 'button, [role="tab"], [role="menuitem"], a').forEach((element) => {
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

      const faviconHref = 'data:image/png;base64,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'
      document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach((link) => {
        if (link.dataset.guanyinFavicon !== 'true') link.remove()
      })
      let favicon = document.querySelector('link[data-guanyin-favicon]')
      if (!favicon) {
        favicon = document.createElement('link')
        favicon.rel = 'icon'
        favicon.type = 'image/png'
        favicon.dataset.guanyinFavicon = 'true'
        document.head.append(favicon)
      }
      if (favicon.href !== new URL(faviconHref, location.href).href) favicon.href = faviconHref

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
        brand.innerHTML = '<span class="dcu-guanyin-logo" aria-hidden="true"></span><strong>观因</strong>'
      })

      matching(root, '[class*="_titleGroup"]').forEach((group) => {
        const title = [...group.children].find((element) => ['探索未至之境', '让智能，安全服务每个团队。'].includes(textOf(element)))
        if (!title) return
        const sourceLogo = group.previousElementSibling
        if (sourceLogo && !sourceLogo.matches('.dcu-guanyin-logo--hero')) sourceLogo.remove()
        title.textContent = '让智能，安全服务每个团队。'
        ;[...group.children].forEach((element) => {
          if (element !== title) element.remove()
        })
        if (!group.querySelector('.dcu-guanyin-logo--hero')) {
          const logo = document.createElement('span')
          logo.className = 'dcu-guanyin-logo dcu-guanyin-logo--hero'
          logo.dataset.guanyinManaged = 'true'
          logo.setAttribute('aria-hidden', 'true')
          group.prepend(logo)
        }
      })
    }

    function installBrandStyles() {
      if (document.querySelector('#guanyin-brand-styles')) return
      const style = document.createElement('style')
      style.id = 'guanyin-brand-styles'
      style.textContent = `
        .dcu-brand[data-guanyin-brand=true] { gap:9px; color:var(--dcu-sidebar-primary); }
        .dcu-guanyin-logo { display:inline-block; flex:none; width:25px; height:25px; color:inherit; background:currentColor; -webkit-mask:url('/__guanyin/brand/logo.png') center/contain no-repeat; mask:url('/__guanyin/brand/logo.png') center/contain no-repeat; }
        .dcu-guanyin-logo--hero { width:35px; height:35px; color:var(--dsw-alias-label-primary,#fff); }
        [class*="_titleGroup"]::before { display:none!important; content:none!important; }
        .dcu-brand[data-guanyin-brand=true] strong { overflow:hidden; font-size:18px; line-height:24px; font-weight:650; letter-spacing:.08em; text-overflow:ellipsis; white-space:nowrap; }
        .dcu-guanyin-identity { position:relative; left:-16px; display:grid; grid-template-columns:24px minmax(0,1fr); gap:8px; align-items:center; width:calc(100% + 32px); box-sizing:border-box; margin:0; padding:11px 16px; border-top:1px solid var(--dcu-sidebar-border); color:var(--dcu-sidebar-primary); text-align:left; text-decoration:none; }
        .dcu-guanyin-back { display:grid; place-items:center; width:24px; height:24px; color:var(--dcu-sidebar-secondary); }
        .dcu-guanyin-back svg { width:18px; height:18px; }
        .dcu-guanyin-copy { display:flex; flex-direction:column; min-width:0; line-height:1.35; }
        .dcu-guanyin-copy strong,.dcu-guanyin-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .dcu-guanyin-copy strong { font-size:12px; font-weight:600; }
        .dcu-guanyin-copy small { color:var(--dcu-sidebar-secondary); font-size:10px; }
        .dcu-guanyin-impersonated { color:#d66b5d!important; }
        .dcu-root.dcu-compact .dcu-brand[data-guanyin-brand=true] strong,.dcu-root.dcu-compact .dcu-guanyin-copy { display:none; }
        .dcu-root.dcu-compact .dcu-guanyin-identity { grid-template-columns:24px; justify-content:center; padding-inline:0; }
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
        panel = document.createElement('a')
        panel.dataset.guanyinIdentity = 'true'
        panel.dataset.guanyinManaged = 'true'
        panel.href = '/console'
        panel.title = '返回观因平台'
        footer.append(panel)
      }
      const displayName = identity?.user?.displayName || identity?.user?.username || '已登录用户'
      const spaceName = identity?.space?.name || 'Agent 工作空间'
      const departmentName = identity?.tenant?.name || ''
      panel.className = 'dcu-guanyin-identity'
      const detail = [departmentName, spaceName].filter(Boolean).join(' · ')
      const content = `<span class="dcu-guanyin-back"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18l-6-6 6-6M9 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="dcu-guanyin-copy"><strong${identity?.impersonated ? ' class="dcu-guanyin-impersonated"' : ''}>${escapeHtml(displayName)}</strong><small title="${escapeHtml(detail)}">${escapeHtml(detail)}</small></span>`
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
      removeContextPluginInfo(root)
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
            removeUpdateActionsImmediately(target)
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
