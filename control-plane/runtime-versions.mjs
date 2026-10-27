// The catalog controls creation only. Persisted spaces keep their own image
// even when an administrator later disables a version for new spaces.
export function runtimeVersions({ defaultVersion, defaultImage, additional = '' }) {
  const rows = [{ id: defaultVersion, image: defaultImage, enabled: true }]
  if (additional) {
    const extra = JSON.parse(additional)
    if (!Array.isArray(extra)) throw new Error('DSH_ADDITIONAL_VERSIONS 必须为版本数组')
    rows.push(...extra)
  }
  const ids = new Set()
  return rows.map(row => {
    if (!row || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(row.id || '') || typeof row.image !== 'string' || !row.image || /\s/.test(row.image) || ids.has(row.id)) throw new Error('空间版本目录无效或版本重复')
    ids.add(row.id)
    const upstream = row.id.match(/^(\d+\.\d+\.\d+)-rc[.-]?(\d+)(?:-|$)/)
    const label = row.label ? String(row.label).slice(0, 100) : upstream ? `${upstream[1]}-rc${upstream[2]}` : row.id
    return Object.freeze({ id: row.id, image: row.image, enabled: row.enabled !== false, label })
  })
}

export function versionForCreation(catalog, id) {
  const version = catalog.find(row => row.id === id && row.enabled)
  if (!version) throw new Error('运行核心版本无效或已停用')
  return version
}

export function imageForSpace(instance, catalog) {
  if (instance.image) return instance.image
  const version = catalog.find(row => row.id === instance.version)
  if (!version) throw new Error('空间镜像记录不存在，无法安全启动')
  return version.image
}
