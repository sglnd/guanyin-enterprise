# MCP 网关本地部署与验证

## 部署状态

- 控制台：http://127.0.0.1:18081/console
- Kubernetes 上下文：docker-desktop，企业系统命名空间 guanyin-enterprise-system。
- 控制面：host.docker.internal:5001/guanyin-control-plane:mcp-gateway-20261029-v4，1 副本。
- 网关：host.docker.internal:5001/guanyin-mcp-gateway:0.1.2-local，1 副本，复用原 PostgreSQL，无 Redis。
- 保留“网关验证 MCP”及独立 guanyin-mcp-smoke 服务，绑定到“智能运维0.2.1”；仅开放无业务副作用的 gateway_probe。默认限额恢复为并发 8、每分钟 120。
- 按用户授权将 Docker MemoryMiB 从 8192 改为 4096，并重启保留数据。为适应本地资源，控制面保持单副本，并增加启动探针；生产清单副本数未改。
- 临时验证 Pod、ConfigMap、网络策略和权限测试用户已清理。测试空间的休眠设置恢复为 120 分钟。
- 数据库和部署备份位于被 Git 忽略的 tmp/mcp-local-validation/，权限受限；其中包含运行信息，不应提交或公开。

## 实际结果

最终完整检查 18 项全部通过（执行区间 UTC：2026-10-29T16:34:50.268Z 至 2026-10-29T16:34:58.590Z）：

- workspace_ready：通过
- admin_connection_and_discovery：通过
- register_and_bind_real_running_space：通过
- tools_list_filters_unapproved_tool：通过
- authorized_tool_executes：通过
- sse_tool_result：通过
- forbidden_tool_never_reaches_upstream：通过
- modified_token_rejected：通过
- space_token_cannot_grant_permissions：通过
- space_operator_cannot_self_authorize：通过
- cross_space_session_rejected：通过
- concurrency_limit_enforced：通过
- 40_real_serial_tool_calls：通过
- request_rate_limit_enforced：通过
- space_revocation_blocks_new_calls：通过
- dsh_receives_gateway_configuration_without_upstream_secret：通过
- dsh_native_tool_registry_contains_only_authorized_tool：通过
- audit_records_success_and_denial：通过

额外使用 DSH 镜像中实际安装的 @modelcontextprotocol/client，以 versionNegotiation.mode=auto 验证：server/discover → HTTP 400 + JSON-RPC -32601 → initialize → tools/list → tools/call，得到 GUANYIN_GATEWAY_PROBE_OK。DSH 原生工具注册表仅出现 gateway_probe，未批准工具不注册。没有调用付费模型；这不是 LLM 自主调用测试。

40 次串行真实工具请求（含网络、下游及网关）中位耗时 1.39ms，P95 10.99ms。撤销空间授权后，在包含 DSH 配置同步的 1256ms 内观察到新调用被拒绝。这是本地功能样本，不是并发容量、可用性或撤权时限 SLA。

## 网络策略验证边界

本机 kindnetd 镜像为 docker.io/kindest/kindnetd:v20260528-9350166c。实际在专用测试 Pod 验证：

1. 无出站策略时，直连控制面 healthz 两次返回 200。
2. 禁止全部出站后，两次连接均超时。
3. 仅放行网关及 DNS 后，网关 readyz 返回 200，直连控制面超时。

因此当前本地 CNI 的策略执行能力已通过实际请求验证，不能沿用“kindnet 一定不支持 NetworkPolicy”的旧假设。可参考 [Kindnet 的网络策略实现](https://kindnet.sigs.k8s.io/docs/design/kindnet/)。测试策略随后删除。

**业务空间尚未全量启用 deploy/mcp-egress-policy.yaml。** 仍需迁移并验证模型、Git、依赖下载等正常出口，以及现有空间的代理环境变量，才能启用强制出站收口。当前不能宣称所有空间均已阻止直连。

## 本次实际验证修复

- DSH 受管配置 ID 只接受小写字母、数字和连字符，原先按服务名构造会被下划线或大写破坏。改用服务 UUID，保留服务名，新增回归测试。
- 新版 DSH 自动协商先调用 server/discover。原先 HTTP 403 阻断其回退，导致配置存在但无工具。网关明确以 HTTP 400 + -32601 表示旧版端点，恢复自动协商，并新增回归测试；不声称实现完整现代 MCP 协议。参见 [MCP 协议兼容规则](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/versioning.mdx)。
- 增加不含请求体、令牌的网关拒绝诊断日志，以及控制面请求错误诊断。

控制面语法检查通过，57 项测试中 53 通过、4 个需独立数据库的测试跳过；网关 Go 竞态检查和 go vet 通过。前一轮已用隔离 PostgreSQL 验证迁移可重入、配置通知、授权快照和审计写入。

后续更新：本地 0.2.1 已启用平台自动维护的基础出站策略；先前“尚未启用”的描述为当时记录。当前范围、启用和回滚方法见 [受管出站网络](managed-egress.md)。
