export function spaceListOptions(params) {
  const integer = (key, fallback, max) => {
    const raw = params.get(key)
    if (raw === null) return fallback
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`${key} 参数无效`)
    return Number(raw)
  }
  const status = params.get('status') || 'all'
  if (!['all', 'running', 'stopped', 'error', 'starting', 'provisioning', 'stopping', 'deleting'].includes(status)) throw new Error('status 参数无效')
  return { page: integer('page', 1, 1_000_000), pageSize: integer('pageSize', 20, 100), search: (params.get('q') || '').trim().slice(0, 200), status }
}

export async function removeSpaceResources(instance, { namespace, request, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const name = `dsh-${instance.slug}`
  const resources = [
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
    `/api/v1/namespaces/${namespace}/services/${name}`,
    `/api/v1/namespaces/${namespace}/secrets/${name}`,
    `/api/v1/namespaces/${namespace}/configmaps/${name}-mcp`,
  ]
  for (const path of resources) {
    try { await request('DELETE', path, { propagationPolicy: 'Foreground' }) }
    catch (error) { if (error.statusCode !== 404) throw error; continue }
    if (path.includes('/deployments/')) {
      let removed = false
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try { await request('GET', path) }
        catch (error) { if (error.statusCode !== 404) throw error; removed = true; break }
        await delay(500)
      }
      if (!removed) throw new Error('空间资源仍在删除中，请稍后重试')
    }
  }

}

export function userListOptions(params) {
  const copy = new URLSearchParams(params)
  copy.set('status', 'all')
  const options = spaceListOptions(copy)
  const status = params.get('status') || 'all', role = params.get('role') || 'all', tenantId = params.get('tenantId') || 'all'
  if (!['all','true','false'].includes(status)) throw new Error('用户状态参数无效')
  if (!['all','platform_admin','tenant_admin','member'].includes(role)) throw new Error('用户角色参数无效')
  if (tenantId !== 'all' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error('租户参数无效')
  return { ...options, status, role, tenantId }
}

// Check authorization before revoking access or changing database state.
export async function requireDeletePermissions(request, namespace, resources) {
  for (const [group, resource] of resources) {
    const review = await request('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: { namespace, verb: 'delete', group, resource } },
    })
    if (review.status?.allowed !== true) throw new Error(`平台运行账户缺少 ${namespace} 中 ${resource} 的删除权限。请由集群管理员应用更新包中的 rbac-instance-manager.yaml 后重试；PVC 保留。`)
  }
}
