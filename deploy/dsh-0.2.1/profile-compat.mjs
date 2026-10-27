// Explicit, tested one-way upgrade. Never overwrite profile patches or sessions.
export function compatibleProfileUpgrade(actual, desired) {
  return actual === 'dsh=0.2.1-rc.2\nprofile=guanyin-enterprise-021-v1\n' && desired === 'dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v1\n'
}

export function managedBundles(existing, managed) {
  const enterprise = '@guanyin/dsh-enterprise'
  const bundles = [...new Set([...existing, ...managed])]
  return [...bundles.filter(name => name !== enterprise), enterprise]
}
