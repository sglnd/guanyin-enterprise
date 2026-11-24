// Explicit, tested one-way upgrade. Never overwrite profile patches or sessions.
export function compatibleProfileUpgrade(actual, desired) {
  const rc2 = 'dsh=0.2.1-rc.2\nprofile=guanyin-enterprise-021-v1\n'
  const rc3 = 'dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v1\n'
  const rc3Memory = 'dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v2\n'
  const memoryLite = 'dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v3\n'
  return ((actual === rc2 || actual === rc3 || actual === rc3Memory) && desired === memoryLite) ||
    (actual === rc2 && desired === rc3) ||
    ((actual === rc2 || actual === rc3) && desired === rc3Memory)
}

export function managedBundles(existing, managed) {
  const enterprise = '@guanyin/dsh-enterprise'
  const replaceMemory = managed.includes('@alanzhao/dsh-memory-lite')
  const bundles = [...new Set([...existing, ...managed])].filter(name => !replaceMemory || name !== '@furongjun1999/dsh-memory')
  return [...bundles.filter(name => name !== enterprise), enterprise]
}

// Only remove the retired plugin's composition rows. Never scan or rewrite
// arbitrary config values: those may contain unrelated settings or credentials.
export function withoutLegacyMemory(rows) {
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [row]
    if (row.name === '@furongjun1999/dsh-memory' || row.id === 'furongjun1999-dsh-memory') return []
    if (Array.isArray(row.insert)) {
      const insert = withoutLegacyMemory(row.insert)
      return insert.length ? [{ ...row, insert }] : []
    }
    return [row]
  })
}
