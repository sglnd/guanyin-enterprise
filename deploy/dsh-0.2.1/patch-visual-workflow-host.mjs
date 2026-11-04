import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2] ?? '/opt/dsh-runtime/node_modules/dsh-visual-workflow/lib'
const policy = '/opt/dsh-runtime/workflow-policy.mjs'

async function patch(path, edits, imports = '') {
  const file = join(root, path)
  let source = await readFile(file, 'utf8')
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Unexpected Visual Workflow 0.10.3 target: ' + path)
    source = source.replace(before, after)
  }
  await writeFile(file, imports + source)
}

await patch('api/routes.js', [
  ['                let args = {};', `                let claims;
                try { claims = verifyIdentityToken(httpReq.headers['x-guanyin-identity'], process.env.DSH_EXT_TOKEN); }
                catch { throw httpError(401, '需要观因空间身份'); }
                if (!claims.space?.id || !claims.user?.id) throw httpError(401, '需要观因空间身份');
                if (!workflowEndpointAllowed(endpoint)) throw httpError(403, '请通过观因平台管理连接或服务');
                let args = {};`],
  ['const value = await api.handle(endpoint, args);', 'const value = await withWorkflowActor(claims, () => api.handle(endpoint, args));'],
], `import { workflowEndpointAllowed, withWorkflowActor } from '${policy}';
import { verifyIdentityToken } from '/opt/dsh-runtime/guanyin-identity.mjs';
`)

await patch('api/ecosystem.js', [
  ['return await listEcosystemModels(this.ctx);', 'return workflowModels(await listEcosystemModels(this.ctx));'],
], `import { workflowModels } from '${policy}';\n`)

// Never publish the upstream connection credentials in the workflow UI.
await patch('api/catalog.js', [
  ['const mcpServers = await listMcpServers().catch(() => []);', 'const mcpServers = (await listMcpServers().catch(() => [])).filter(managedWorkflowMcp);'],
  ["command: String(server.command ?? ''),", "command: '',"],
  ['args: Array.isArray(server.args) ? server.args : [],', 'args: [],'],
  ["commandLine: renderCommandLine(String(server.command ?? ''), (Array.isArray(server.args) ? server.args : [])),", "commandLine: '',"],
  ['env: server.env ?? {},', 'env: {},'],
  ['headers: server.headers ?? {},', 'headers: {},'],
  ["url: String(server.url ?? ''),", "url: '',"],
], `import { managedWorkflowMcp } from '${policy}';\n`)

await patch('orchestrator/runtime-launch.js', [
  ["        const mode = input.mode ?? 'mode1';", "        const mode = input.mode ?? 'mode1';\n        if (mode !== 'mode1') throw new WfError('观因工作流仅支持站内运行', 'WF_MODE_MISMATCH');"],
  ["const flow = mode === 'mode2'", "let flow = mode === 'mode2'"],
  ["const flow = prev.mode === 'mode2'", "let flow = prev.mode === 'mode2'"],
  ['        // 运行前完整性：启动/输入与结束/输出必须齐备（保存中间态与运行分离）', "        if (flow.mode !== 'mode1') throw new WfError('观因工作流仅支持站内运行', 'WF_MODE_MISMATCH');\n        flow = resolveWorkflowModels(flow);"],
  ['        // 运行前完整性（与全新启动同一套校验）', `        if (prev.flowRevision !== flow.revision) throw new WfError('流程已修改，请启动新运行', 'WF_NOT_RESUMABLE');
        flow = resolveWorkflowModels(flow);`],
  ['        snapshot.systemLanguage = input.systemLanguage ?? this.deps.systemLanguage?.() ?? DEFAULT_SYSTEM_LANGUAGE;', '        snapshot.flowRevision = flow.revision;\n        snapshot.guanyinActor = workflowRunActor();\n        snapshot.systemLanguage = input.systemLanguage ?? this.deps.systemLanguage?.() ?? DEFAULT_SYSTEM_LANGUAGE;'],
  ['\n                source: { kind: \'user\' },', '\n                source: await workflowPromptSource(snapshot),'],
], `import { resolveWorkflowModels, workflowRunActor, workflowPromptSource } from '${policy}';\n`)

const runtime = join(root, 'orchestrator/runtime-base.js')
const source = await readFile(runtime, 'utf8')
const liveLookup = /    async currentResolvedFlow\(entry\) \{[\s\S]*?\n    \}\n/
const liveRefresh = /    async refreshActiveDefinitions\(flowId, sessionId, flow\) \{[\s\S]*?\n    \}\n/
if (!liveLookup.test(source) || !liveRefresh.test(source)) throw new Error('Unexpected workflow snapshot implementation')
await writeFile(runtime, source.replace(liveLookup, '    async currentResolvedFlow(entry) {\n        return entry.baseFlow;\n    }\n')
  .replace(liveRefresh, '    async refreshActiveDefinitions() {}\n'))

await patch('orchestrator/runtime-execute.js', [
  ['        const flow = await this.currentResolvedFlow(run);', '        const flow = await this.currentResolvedFlow(run);\n        assertWorkflowBranch(flow, run.snapshot, nodeId);'],
  ["        const isFailed = args?.status === 'failed';", "        const isFailed = args?.status === 'failed';\n        if (!isFailed) assertWorkflowBranchesFinished(run.baseFlow, snapshot);"],
], `import { assertWorkflowBranch, assertWorkflowBranchesFinished } from '${policy}';\n`)

await patch('agent/model-selection.js', [
  ['        if (selected === undefined)\n            return resolved;', '        if (selected === undefined)\n            return resolved;\n        assertWorkflowModel(selected);'],
], `import { assertWorkflowModel } from '${policy}';\n`)

await patch('agent/runner.js', [
  ['    return allow;\n}', '    return allow.filter(workflowToolAllowed);\n}'],
], `import { workflowToolAllowed } from '${policy}';\n`)

await patch('visual-workflow-host.js', [
  ['                await this.serviceManager.autoRecover();', '                // Independent workflow services are disabled in Guanyin.'],
  ["        this.ctx.effect(() => this.scheduler.start(), 'visualWorkflowHost.scheduler');", '        // Scheduling is managed by the platform.'],
  ["            this.ctx.effect(() => registerWfDbQuery(this.ctx, this), 'visualWorkflowHost.dataTools');", '            // Database connections are managed outside the workflow plugin.'],
], '')
