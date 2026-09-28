# 观因开放 API V1 设计基线

## 目标与边界

V1 通过观因统一向外围系统开放 DSH 能力，不直接暴露 DSH 地址、Cookie、模型密钥或 MCP 密钥。支持同步 JSON、异步 Run + SSE、自动文档、API Key、接口/凭证/空间三级并发、模型生成草稿和管理员审核发布。V1 不包含定时调度、复杂工作流、OAuth2、计费和跨空间编排。

模型供应商、服务地址、模型名称和模型凭证由各空间用户在 DSH 内自行申请、配置和切换。观因不注入默认模型，不持有或展示模型密钥；接口运行使用目标空间在 DSH 中当前生效的模型配置。

## 权限

- 平台管理员：全部权限，并授予 `api_admin`。
- 接口管理员：新增、审核、验证、发布、下线接口和查看脱敏调用记录；可以同时是普通空间用户。
- 空间管理员：启用本空间已发布接口、管理本空间凭证和空间级并发，不能修改公共契约。
- 普通成员：模型可生成接口建议，但不能登记或发布。
- API Key：仅调用明确授权的接口版本。

接口状态固定为 `proposal → draft → validated → published → retired`。发布版本不可修改；变更必须创建下一版本。

## 核心对象

- `api_definitions`：接口身份、所属空间、当前草稿及状态。
- `api_releases`：不可变发布契约，保存输入、输出、事件、工具白名单、执行策略和文档；不复制或锁定 Skill 内容。
- `api_credentials`：只保存 Key 前缀和哈希，明文只在创建时显示一次。
- `api_credential_grants`：凭证到接口发布版本的授权。
- `api_runs`：一次调用的排队、执行和最终状态。
- `api_run_events`：有序、可恢复的 SSE 事件。
- `api_conversations`：凭证范围内的 `conversationKey` 到 DSH 会话映射。

## 调用契约

同步调用：`POST /openapi/v1/invoke/{slug}`，仅用于预计可在网关同步超时内完成的任务。结果必须通过发布快照中的 `outputSchema` 校验；允许一次格式修复，失败返回 `OUTPUT_SCHEMA_VALIDATION_FAILED`。

异步调用：`POST /openapi/v1/runs/{slug}` 创建 Run；`GET /openapi/v1/runs/{runId}/events` 订阅 SSE；`GET /openapi/v1/runs/{runId}` 获取状态和最终 JSON。SSE 支持 `Last-Event-ID`，断线不得重启任务。

标准事件：`run.queued`、`run.started`、`run.progress`、`step.started`、`step.completed`、`tool.started`、`tool.completed`、`finding.created`、`artifact.created`、`run.completed`、`run.failed`。事件展示可观测执行轨迹，不输出模型原始思维链；工具参数、凭证和敏感结果必须脱敏。

## 并发与队列

有效执行许可同时受接口、API Key、空间和 `conversationKey` 约束。`conversationKey` 固定串行。接口发布快照保存：`maxConcurrency`、`maxQueueSize`、`queueTimeoutSeconds`、`executionTimeoutSeconds`、`overflowStrategy`。队列满或拒绝策略返回 429 和 `Retry-After`；排队模式立即返回 Run ID。

并发许可必须使用数据库原子状态迁移或独立队列执行器，不能依赖单个控制平面进程的内存计数，因为控制平面有多个副本。

## 文档

发布事务同时生成并冻结 OpenAPI JSON/YAML、在线文档数据、Markdown/HTML 导出内容、请求响应示例、SSE 示例、错误码、并发与超时说明。文档与 `api_releases` 绑定，草稿变化不影响线上文档。API Key 明文不得进入文档。

## 模型生成

DSH 中的 API Builder Skill 根据自然语言、当前会话、Skill、MCP 和工具生成声明式 Manifest，通过观因内部 MCP 提交 `proposal`。平台执行 Schema、权限、工具白名单、敏感字段和试运行验证；只有平台管理员或接口管理员能够进入发布流程。

API Builder 通过观因自动注入的内置 `guanyin-api-builder` MCP 落库。该 MCP 使用每个空间独立的内部凭证，只能操作当前空间，提供上下文查询、草稿列表/详情、创建、修改和校验工具；不提供发布、下线、凭证管理、密钥读取或跨空间工具。第一版因 DSH `0.1.5-rc.2` 的 MCP 调用不携带浏览器用户身份，草稿操作按空间服务身份执行并归属空间负责人，审计记录 `source=dsh-ai-builder`；发布仍由接口管理员在观因平台完成。

接口只记录负责人和 Skill 引用说明，不复制 Skill、不保存 Skill 快照、不维护 Skill 版本。运行时使用 DSH 当前有效的 Skill。接口负责人负责持续维护 Skill，并在变更后按需执行“重新验证接口”。

## 身份传递

一次外围调用同时存在三类身份，必须分别保存和审计：

- 调用方身份：API Key 对应的外围系统，例如“运维大屏”。
- 接口负责人：对接口契约、Skill 和运行质量负责的观因用户。
- 执行身份：由观因签发并传入 DSH 的受控用户上下文，默认使用接口负责人或接口专用服务身份。

外围请求不得提交或覆盖观因用户 ID。Adapter 根据 API Key、发布契约和空间授权生成可信身份上下文，至少包含 `userId`、`displayName`、`tenantId`、`spaceId`、`apiDefinitionId`、`apiReleaseId`、`credentialId` 和 `requestId`。DSH 将其用于界面显示、会话归属、工具权限和审计，但不得把完整 API Key 传入模型上下文。

## DSH Adapter

Adapter 对上提供稳定的 `startRun`、`cancelRun`、`getRun` 和事件流；对下适配 DSH 版本差异。它负责可信用户上下文、空间唤醒、会话创建/复用、消息提交、工具事件归一化、取消和最终结果提取。控制平面不能把 DSH 原始协议直接定义为公共 API。

`0.1.5-rc.2` 已验证的底层契约如下：

- 一元 Remote：`session/create`、`session/prompt`、`session/cancel`，请求由 DSH Connection 的 `client-request` envelope 承载。
- 流 Remote：`session/follow`，通过 `/api/remote.mux` 复用 WebSocket；首帧是 `snapshot`，后续是持久 Session event 与可选 `assistant-stream` 增量。
- 一次真实测试已观察到 `turn/start → step/start → user/message → request/header → assistant-stream → step/end → turn/end`，模型凭证错误也会以结构化 finish/turn error 结束。
- DSH 镜像只向控制平面开放受 `DSH_EXT_TOKEN` 保护的 `/__guanyin/dsh-rpc/*` 与 `/__guanyin/dsh-stream`。桥接层持有并刷新 DSH Web Cookie；公共网关和外围调用方均不得接触该 Cookie。

Adapter 必须把 DSH 原始事件映射为本文的标准事件，并从 durable `assistant/message` 提取最终结果。`assistant-stream` 只用于实时展示，不能单独作为最终结果来源；断线恢复应重新打开 follow 并以 snapshot/cursor 修补，不能重新提交 prompt。

## 实施顺序

1. 验证 DSH 0.1.5-rc.2 的会话、消息、事件流、取消和并发行为，固化 Adapter 契约。
2. 落权限、数据表、Manifest 校验、版本状态机和不可变发布快照。
3. 完成 API Key、授权、同步调用和审计闭环。
4. 完成数据库队列、并发许可、异步 Run、SSE 重连和取消。
5. 完成自动 OpenAPI/在线文档和导出。
6. 完成 API Builder Skill、内部 MCP 提案和管理页面。

## 当前实现状态

- 已完成 DSH `0.1.5-rc.2` Adapter、受保护的内部 RPC/WebSocket 桥接和真实协议验证。
- 已完成异步 `POST /openapi/v1/runs/{slug}`、状态查询、取消与 SSE 事件订阅；API Key 支持 `Authorization: Bearer` 和 `X-API-Key`。
- `X-Request-ID` 用于幂等创建；SSE 使用事件序号作为 `id`，支持 `Last-Event-ID` 从数据库续传。
- 队列由 PostgreSQL `FOR UPDATE SKIP LOCKED` 抢占；接口、凭证、空间和 `conversationKey` 并发均在数据库层判断。队列容量通过事务级 advisory lock 原子检查。
- 输入、输出使用发布契约中的 JSON Schema 校验；执行超时、排队超时、模型失败和调用方取消都会持久化为终态。
- 已用临时发布接口完成端到端失败链路验证：`run.queued → run.started → step.started → run.progress → step.completed → run.failed`，DSH 的模型 401 被准确转换为 `AUTH` 终态；临时接口、凭证和 Run 已清理。
- 已完成第一版接口管理页面与管理 API：草稿创建/编辑、Schema 校验、发布、自动 OpenAPI 3.1/Markdown 文档、空间凭证创建、一次性明文展示和发布版本授权。平台管理员与接口管理员维护接口；空间负责人/运维者管理本空间凭证。
- 管理链路已做端到端冒烟验证：创建草稿、校验、发布 v1、读取 OpenAPI/Markdown、创建 `gyn_` 凭证、授权发布版本均成功，临时数据已清理。
- 已完成接口下线、凭证启停、接口运行记录和结构化事件详情；在线文档支持 Markdown/OpenAPI 双视图。接口下线会立即阻止新调用和新授权，但保留历史发布文档与运行记录。
- 治理链路已做端到端冒烟验证：停用凭证后外部调用返回 403，重新启用成功；接口下线后外部调用返回 403，历史文档仍返回 200。临时接口、发布版本和凭证均已清理。
- 已使用空间内由用户自行配置的真实模型完成成功闭环验证：非法输入被 `inputSchema` 拒绝，同一 `X-Request-ID` 幂等复用 Run，异步执行成功，SSE 顺序输出 21 个公开事件，模型 JSON 通过 `outputSchema` 校验，最终状态为 `succeeded`；管理端运行记录、事件详情、OpenAPI 3.1 和 Markdown 文档均可读取。验证产生的临时接口、凭证、Run、事件和会话映射已清理。
- 已实现空间内置 API Builder MCP，可由 DSH AI 自主生成、更新和校验接口草稿；工具集刻意不包含发布、下线和凭证管理，用户不需要手工填写观因 API 信息。
- 已完成真实 AI 自主验证：DSH 模型根据一段自然语言需求，主动读取空间策略和已有草稿，自行生成输入/输出 Schema，调用内置 MCP 创建草稿并校验成功，最终停在“等待接口管理员发布”；测试草稿已清理。
- 新增接口弹窗提供“AI 帮你生成”：用户基于需求模板填写自然语言并选择空间，观因后台调用该空间当前模型生成契约建议，将名称、标识、说明、执行指令、输入/输出 Schema 和运行参数回填到当前页面；该过程不创建、不保存、不发布接口，用户确认修改后才保存草稿。

下一阶段是补充同步 JSON 调用模式，将闭环检查固化为可重复执行的验收脚本，并根据真实使用反馈优化 API Builder 的引导提示和草稿试运行体验。
