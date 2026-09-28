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

    function enforcePolicy() {
      const root = document
      removeCodexSidebarExtensions(root)
      removeCompanionManagement(root)
      removePluginExternalActions(root)
      removeManagedSettings(root)
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return

      const start = () => {
        enforcePolicy()
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
