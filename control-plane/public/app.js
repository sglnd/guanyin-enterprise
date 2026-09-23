const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]
let me
let overview
let auditUser
let selectedSpace
let spaceMembers = []
let instancePollTimer
let auditOffset = 0
const auditPageSize = 20
let adminAuditOffset = 0
const adminAuditPageSize = 20

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data
}

function showLogin() { clearTimeout(instancePollTimer); $('#login').classList.remove('hidden'); $('#app').classList.add('hidden') }
function showApp() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden')
  $('#display-name').textContent = me.displayName; $('#tenant-name').textContent = me.tenantName || '平台'
  $('#avatar').textContent = me.displayName.slice(0, 1); $$('.admin-only').forEach(el => el.classList.toggle('hidden', me.role !== 'platform_admin'))
  $$('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === 'instances'))
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== 'instances-view'))
  $('#page-title').textContent = '我的工作空间'
  $('#admin-instance-grid').innerHTML = ''; $('#audit-table').innerHTML = ''
}

function scheduleInstancePoll(loader, instances) {
  clearTimeout(instancePollTimer)
  if (instances.some(instance => ['starting','provisioning','stopping'].includes(instance.status))) instancePollTimer = setTimeout(loader, 3000)
}

function instanceCard(instance, admin = false) {
  const status = ({running:'运行中',starting:'启动中',provisioning:'创建中',stopped:'已休眠',stopping:'休眠中',error:'异常'})[instance.status] || instance.status
  const busy = ['starting','provisioning','stopping'].includes(instance.status)
  let primary
  if (instance.status === 'running') primary = admin ? `<button class="impersonate" data-id="${instance.id}" data-name="${escapeHtml(instance.name)}">管理员代入访问</button>` : `<button class="enter" data-id="${instance.id}">进入工作空间</button>`
  else primary = `<button class="wake" data-id="${instance.id}" ${busy ? 'disabled' : ''}>${instance.status === 'stopped' ? '启动空间' : '重试启动'}</button>`
  const sleep = instance.idleTimeoutMinutes == null ? '永不休眠' : `${instance.idleTimeoutMinutes} 分钟休眠`
  const identity = admin ? `${instance.memberCount} 位成员` : ({owner:'负责人',operator:'运维者',member:'成员'})[instance.accessRole]
  const canStop = admin || ['owner','operator'].includes(instance.accessRole)
  return `<article class="instance-card"><div class="top"><div class="instance-icon">◇</div><span class="status ${instance.status}">${status}</span></div><h3>${escapeHtml(instance.name)}</h3><p>${escapeHtml(instance.tenant || '')} · ${escapeHtml(identity || '尚未授权成员')}</p><div class="space-policy">${escapeHtml(sleep)}</div><div class="meta"><span>DSH ${escapeHtml(instance.version)}</span><span>${new Date(instance.createdAt).toLocaleDateString()}</span></div>${primary}${instance.status === 'running' && canStop ? `<button class="sleep" data-id="${instance.id}">停止空间</button>` : ''}${admin ? `<button class="manage-space" data-id="${instance.id}">管理空间</button>` : ''}</article>`
}

function bindInstanceActions(root, reload) {
  root.querySelectorAll('.enter').forEach(button => button.onclick = async () => { button.disabled = true; const result = await request(`/api/instances/${button.dataset.id}/launch`, { method: 'POST' }); if (result.location) location.href = result.location; else setTimeout(reload, 2500) })
  root.querySelectorAll('.wake').forEach(button => button.onclick = async () => { button.disabled = true; await request(`/api/instances/${button.dataset.id}/start`, { method: 'POST' }); setTimeout(reload, 2500) })
  root.querySelectorAll('.sleep').forEach(button => button.onclick = async () => { button.disabled = true; await request(`/api/instances/${button.dataset.id}/stop`, { method: 'POST' }); await reload() })
  root.querySelectorAll('.impersonate').forEach(button => button.onclick = async () => {
    const confirmed = confirm(`管理员代入访问确认\n\n空间：${button.dataset.name}\n\n您将访问该共享空间，本次操作将写入审计日志。`)
    if (!confirmed) return
    button.disabled = true
    try { const result = await request(`/api/admin/instances/${button.dataset.id}/impersonate`, { method: 'POST' }); location.href = result.location }
    catch (error) { alert(error.message); button.disabled = false }
  })
  root.querySelectorAll('.manage-space').forEach(button => button.onclick = () => openSpaceManagement(button.dataset.id))
}

async function loadInstances() {
  const { instances } = await request('/api/instances')
  const root = $('#instance-grid')
  root.innerHTML = instances.length ? instances.map(instance => instanceCard(instance)).join('') : '<div class="empty">尚未授权可访问的 DSH 空间。</div>'
  bindInstanceActions(root, loadInstances)
  scheduleInstancePoll(loadInstances, instances)
}

async function loadAdminInstances() {
  if (me.role !== 'platform_admin') return
  const { instances } = await request('/api/admin/instances')
  const root = $('#admin-instance-grid')
  root.innerHTML = instances.length ? instances.map(instance => instanceCard(instance, true)).join('') : '<div class="empty">尚无空间。</div>'
  bindInstanceActions(root, loadAdminInstances)
  scheduleInstancePoll(loadAdminInstances, instances)
  await loadAdminAudit(adminAuditOffset)
}

async function loadAdminAudit(offset = 0) {
  if (me.role !== 'platform_admin') return
  adminAuditOffset = Math.max(offset, 0)
  const result = await request(`/api/admin/audit-logs?limit=${adminAuditPageSize}&offset=${adminAuditOffset}`)
  $('#audit-table').innerHTML = result.logs.length ? '<div class="row head"><span>时间</span><span>操作</span><span>目标</span></div>' + result.logs.map(log => `<div class="row"><span>${new Date(log.createdAt).toLocaleString()}</span><span>${escapeHtml(log.actor)} · ${escapeHtml(actionNames[log.action] || log.action)}</span><span>${escapeHtml(log.targetInstance || '')} · ${escapeHtml(log.targetUser || '')}</span></div>`).join('') : '<div class="empty compact">暂无管理员操作记录。</div>'
  $('#admin-audit-page').textContent = `${Math.floor(adminAuditOffset / adminAuditPageSize) + 1} / ${Math.max(Math.ceil(result.total / adminAuditPageSize), 1)} 页 · 共 ${result.total} 条`
  $('#admin-audit-prev').disabled = adminAuditOffset === 0
  $('#admin-audit-next').disabled = adminAuditOffset + adminAuditPageSize >= result.total
}

function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML }
function roleName(role) { return role === 'platform_admin' ? '平台管理员' : role === 'tenant_admin' ? '租户管理员' : '普通用户' }
const actionNames = {
  user_login: '登录', user_logout: '退出', user_create: '创建用户', user_update: '修改用户信息',
  user_password_reset: '初始化密码', dsh_enter: '进入工作空间', dsh_operation: 'DSH 操作',
  instance_start: '启动空间', instance_stop: '停止空间', space_create: '创建空间', space_update: '修改空间',
  space_member_set: '设置空间成员', space_member_remove: '移除空间成员',
  admin_impersonation_start: '管理员代入访问', admin_instance_start: '管理员启动空间', admin_instance_stop: '管理员停止空间',
}
function auditDescription(log) {
  if (log.action === 'dsh_operation') return `${log.details?.path || 'DSH 请求'} · HTTP ${log.details?.status || '-'} · ${log.details?.durationMs ?? '-'}ms`
  if (log.action === 'user_update') return '显示名称、角色、租户或启用状态发生变更'
  if (log.action === 'user_password_reset') return '旧登录会话已全部注销'
  return [log.targetInstance, log.targetUser].filter(Boolean).join(' · ') || '-'
}

async function loadOverview() {
  if (me.role !== 'platform_admin') return
  overview = await request('/api/admin/overview')
  const tenantOptions = overview.tenants.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
  $('#user-form select[name=tenantId]').innerHTML = tenantOptions
  $('#instance-form select[name=tenantId]').innerHTML = tenantOptions
  $('#user-table').innerHTML = '<div class="row user-row head"><span>用户</span><span>租户</span><span>角色</span><span>操作</span></div>' + overview.users.map(u => `<div class="row user-row"><span><strong>${escapeHtml(u.displayName)}</strong><small>${escapeHtml(u.username)}${u.enabled ? '' : ' · 已停用'}</small></span><span>${escapeHtml(u.tenantName || '')}</span><span class="pill">${roleName(u.role)}</span><span class="row-actions"><button class="user-audit" data-id="${u.id}">审计</button>${u.role === 'platform_admin' ? '' : `<button class="user-edit" data-id="${u.id}">编辑</button><button class="user-password" data-id="${u.id}">初始化密码</button>`}</span></div>`).join('')
  bindUserActions()
  $('#tenant-table').innerHTML = '<div class="row head"><span>租户</span><span>编码</span><span>成员数</span></div>' + overview.tenants.map(t => `<div class="row"><strong>${escapeHtml(t.name)}</strong><span>${escapeHtml(t.code)}</span><span>${overview.users.filter(u => u.tenantId === t.id).length}</span></div>`).join('')
}

function sleepOptions(selected) {
  const values = [['never','永不休眠'],[30,'空闲 30 分钟'],[60,'空闲 1 小时'],[120,'空闲 2 小时'],[240,'空闲 4 小时'],[480,'空闲 8 小时']]
  return values.map(([value,label]) => `<option value="${value}" ${String(selected ?? 'never') === String(value) ? 'selected' : ''}>${label}</option>`).join('')
}

async function openSpaceManagement(id) {
  selectedSpace = (await request('/api/admin/instances')).instances.find(item => item.id === id)
  if (!selectedSpace) return
  const form = $('#space-settings-form'); form.elements.name.value = selectedSpace.name
  form.elements.idleTimeoutMinutes.innerHTML = sleepOptions(selectedSpace.idleTimeoutMinutes)
  form.querySelector('button[type=submit]').textContent = '保存空间设置'; $('#space-settings-message').textContent = ''
  $('#space-dialog-name').textContent = selectedSpace.name
  const eligible = overview.users.filter(u => u.role !== 'platform_admin' && u.tenantId === selectedSpace.tenantId)
  $('#space-member-form select[name=userId]').innerHTML = eligible.map(u => `<option value="${u.id}">${escapeHtml(u.displayName)}（${escapeHtml(u.username)}）</option>`).join('')
  await loadSpaceMembers(); $('#space-dialog').showModal()
}

async function loadSpaceMembers() {
  const result = await request(`/api/admin/instances/${selectedSpace.id}/members`); spaceMembers = result.members
  $('#space-member-list').innerHTML = spaceMembers.length ? spaceMembers.map(member => `<div class="member-row"><span><strong>${escapeHtml(member.displayName)}</strong><small>${escapeHtml(member.username)}</small></span><span class="pill">${({owner:'负责人',operator:'运维者',member:'成员'})[member.accessRole]}</span>${member.accessRole === 'owner' ? '<span></span>' : `<button class="remove-member" data-id="${member.id}">移除</button>`}</div>`).join('') : '<div class="empty compact">尚未绑定成员。</div>'
  $('#space-member-list').querySelectorAll('.remove-member').forEach(button => button.onclick = async () => { await request(`/api/admin/instances/${selectedSpace.id}/members/${button.dataset.id}`, { method: 'DELETE' }); await Promise.all([loadSpaceMembers(),loadAdminInstances()]) })
  const memberSelect = $('#space-member-form select[name=userId]')
  const syncRole = () => { const current = spaceMembers.find(member => member.id === memberSelect.value); $('#space-member-form select[name=accessRole]').value = current?.accessRole || 'member' }
  memberSelect.onchange = syncRole; syncRole()
}

function bindUserActions() {
  $('#user-table').querySelectorAll('.user-audit').forEach(button => button.onclick = () => openUserAudit(button.dataset.id))
  $('#user-table').querySelectorAll('.user-edit').forEach(button => button.onclick = () => openUserEdit(button.dataset.id))
  $('#user-table').querySelectorAll('.user-password').forEach(button => button.onclick = () => resetUserPassword(button.dataset.id))
}

function openUserEdit(id) {
  const user = overview.users.find(item => item.id === id)
  if (!user) return
  const form = $('#edit-user-form')
  form.dataset.id = id
  form.elements.displayName.value = user.displayName
  form.elements.role.value = user.role
  form.elements.tenantId.innerHTML = overview.tenants.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
  form.elements.tenantId.value = user.tenantId
  form.elements.enabled.checked = user.enabled
  $('#edit-user-name').textContent = user.username
  $('#edit-user-message').textContent = ''
  $('#edit-user-dialog').showModal()
}

async function openUserAudit(id, offset = 0) {
  auditUser = overview.users.find(item => item.id === id)
  if (!auditUser) return
  auditOffset = Math.max(offset, 0)
  $('#audit-user-name').textContent = `${auditUser.displayName}（${auditUser.username}）`
  $('#user-audit-table').innerHTML = '<div class="loading">正在读取审计日志…</div>'
  if (!$('#user-audit-dialog').open) $('#user-audit-dialog').showModal()
  try {
    const result = await request(`/api/admin/users/${id}/audit-logs?limit=${auditPageSize}&offset=${auditOffset}`)
    $('#user-audit-table').innerHTML = result.logs.length ? result.logs.map(log => `<div class="audit-item"><div><strong>${escapeHtml(actionNames[log.action] || log.action)}</strong><time>${new Date(log.createdAt).toLocaleString()}</time></div><p>${escapeHtml(auditDescription(log))}</p><small>操作人：${escapeHtml(log.actor)}${log.details?.ip ? ` · IP ${escapeHtml(log.details.ip)}` : ''}</small></div>`).join('') : '<div class="empty compact">暂无审计记录。</div>'
    $('#audit-page').textContent = `${Math.floor(auditOffset / auditPageSize) + 1} / ${Math.max(Math.ceil(result.total / auditPageSize), 1)} 页 · 共 ${result.total} 条`
    $('#audit-prev').disabled = auditOffset === 0
    $('#audit-next').disabled = auditOffset + auditPageSize >= result.total
  } catch (error) { $('#user-audit-table').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>` }
}

async function resetUserPassword(id) {
  const user = overview.users.find(item => item.id === id)
  if (!user || !confirm(`确定初始化 ${user.displayName}（${user.username}）的密码吗？\n\n该用户当前所有登录会话会立即失效。`)) return
  try {
    const result = await request(`/api/admin/users/${id}/reset-password`, { method: 'POST' })
    $('#password-user-name').textContent = user.displayName
    $('#temporary-password').textContent = result.temporaryPassword
    $('#copy-password').textContent = '复制密码'
    $('#password-dialog').showModal()
  } catch (error) { alert(error.message) }
}

async function submitForm(form, path) {
  const message = form.querySelector('.form-message'); const button = form.querySelector('button'); message.textContent = ''; button.disabled = true
  try { const body = Object.fromEntries(new FormData(form)); await request(path, { method: 'POST', body: JSON.stringify(body) }); message.style.color = '#2d8067'; message.textContent = '操作成功'; form.reset(); await Promise.all([loadOverview(), loadInstances(), loadAdminInstances()]) }
  catch (error) { message.style.color = ''; message.textContent = error.message }
  finally { button.disabled = false }
}

$('#login-form').onsubmit = async event => { event.preventDefault(); $('#login-error').textContent = ''; try { const result = await request('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); me = result.user; showApp(); await Promise.all([loadInstances(), loadOverview()]) } catch (error) { $('#login-error').textContent = error.message } }
$('#logout').onclick = async () => { await request('/api/logout', { method: 'POST' }); me = undefined; showLogin() }
$('#refresh').onclick = loadInstances
$('#admin-refresh').onclick = loadAdminInstances
$('#user-form').onsubmit = event => { event.preventDefault(); submitForm(event.target, '/api/admin/users') }
$('#tenant-form').onsubmit = event => { event.preventDefault(); submitForm(event.target, '/api/admin/tenants') }
$('#instance-form').onsubmit = event => { event.preventDefault(); submitForm(event.target, '/api/admin/instances') }
$('#space-settings-form').onsubmit = async event => {
  event.preventDefault(); const form = event.target; const button = form.querySelector('button[type=submit]'); button.disabled = true
  try {
    const result = await request(`/api/admin/instances/${selectedSpace.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form))) })
    selectedSpace = result.instance; await loadAdminInstances(); $('#space-dialog-name').textContent = form.elements.name.value
    $('#space-settings-message').textContent = '设置已保存并立即生效'; button.textContent = '已保存'
  } catch (error) { alert(error.message) } finally { button.disabled = false }
}
$('#space-member-form').onsubmit = async event => {
  event.preventDefault(); const form = event.target; const button = form.querySelector('button'); button.disabled = true
  try {
    await request(`/api/admin/instances/${selectedSpace.id}/members`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) })
    await Promise.all([loadSpaceMembers(),loadAdminInstances(),loadInstances()])
  } catch (error) { alert(error.message) } finally { button.disabled = false }
}
$('#edit-user-form').onsubmit = async event => {
  event.preventDefault(); const form = event.target; const button = form.querySelector('button[type=submit]'); button.disabled = true; $('#edit-user-message').textContent = ''
  try {
    const body = Object.fromEntries(new FormData(form)); body.enabled = form.elements.enabled.checked
    await request(`/api/admin/users/${form.dataset.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    $('#edit-user-dialog').close(); await loadOverview()
  } catch (error) { $('#edit-user-message').textContent = error.message } finally { button.disabled = false }
}
$$('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close())
$('#audit-prev').onclick = () => openUserAudit(auditUser.id, auditOffset - auditPageSize)
$('#audit-next').onclick = () => openUserAudit(auditUser.id, auditOffset + auditPageSize)
$('#admin-audit-prev').onclick = () => loadAdminAudit(adminAuditOffset - adminAuditPageSize)
$('#admin-audit-next').onclick = () => loadAdminAudit(adminAuditOffset + adminAuditPageSize)
$('#copy-password').onclick = async () => { await navigator.clipboard.writeText($('#temporary-password').textContent); $('#copy-password').textContent = '已复制' }
$$('.nav').forEach(button => button.onclick = async () => { clearTimeout(instancePollTimer); $$('.nav').forEach(v => v.classList.remove('active')); button.classList.add('active'); $$('.view').forEach(v => v.classList.add('hidden')); $(`#${button.dataset.view}-view`).classList.remove('hidden'); $('#page-title').textContent = ({instances:'我的工作空间','instance-admin':'空间管理',users:'用户与租户管理'})[button.dataset.view]; if (button.dataset.view === 'instance-admin') await loadAdminInstances(); if (button.dataset.view === 'instances') await loadInstances() })
$$('.tab').forEach(button => button.onclick = () => { $$('.tab').forEach(v => v.classList.remove('active')); button.classList.add('active'); $$('.tab-body').forEach(v => v.classList.add('hidden')); $(`#${button.dataset.tab}-tab`).classList.remove('hidden') })

try { const result = await request('/api/me'); me = result.user; showApp(); await Promise.all([loadInstances(), loadOverview()]) } catch { showLogin() }
