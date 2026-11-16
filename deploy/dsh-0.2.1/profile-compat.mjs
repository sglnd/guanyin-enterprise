// Explicit, tested one-way upgrade. Never overwrite profile patches or sessions.
export function compatibleProfileUpgrade(actual, desired) {
  const rc2 = 'dsh=0.2.1-rc.2\nprofile=guanyin-enterprise-021-v1\n'
  const rc3 = 'dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v1\n'
  const rc3Memory = 'dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v2\n'
  return (actual === rc2 && desired === rc3) ||
    ((actual === rc2 || actual === rc3) && desired === rc3Memory)
}

export function managedBundles(existing, managed) {
  const enterprise = '@guanyin/dsh-enterprise'
  const bundles = [...new Set([...existing, ...managed])]
  return [...bundles.filter(name => name !== enterprise), enterprise]
}
