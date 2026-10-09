# 平台模型登记与空间接入

平台管理员在“模型管理”登记提供方，再在“空间管理 → 管理 → 管理模型”选择接入。普通用户、租户管理员没有平台模型管理权限。

每个提供方对应 DSH `llm-pi-ai.providers` 中的一条路由，可包含多个模型。平台注册的路由名为 `guanyin-<编码>`，此命名空间专用于平台管理，不应在空间内手工添加同名前缀路由。

## 登记字段

- 名称、唯一编码（创建后不能修改）。
- API 协议：`openai-completions`、`openai-responses`、`anthropic-messages`。
- `baseURL`：基础地址。Chat Completions 的 `/chat/completions` 后缀自动去掉，SDK 会补上；保存时不会自动探测用户提供的地址。
- API Key：创建必填，修改留空保留原值；仅存 Kubernetes Secret `guanyin-model-<UUID>`，不存平台数据库、不回显、不写审计。
- 流空闲超时：默认 600000 毫秒。
- 模型列表 JSON，例如：

```json
[{"reasoningEfforts":{"off":null,"low":"low","medium":"medium","high":"high"}}]
```

- 模型 JSON 无需重复填写 `id`、`name`：省略时分别使用提供方编码和显示名称。提供方编码应填写网关接受的模型 ID（例如 `deepseek-v4-flash-0731-int8`）。已有显式 ID、名称保持兼容；同一提供方登记多个模型时仍可显式指定不同 ID。
- `compat` JSON，例如 `{"supportsReasoningEffort":true}`。
- 非推理模型可省略 `reasoningEfforts` 或设置 `false`。`off:null` 表示该等级不发送推理参数；是否符合具体网关语义仍需实际业务验证。

用户提供的生产配置里，`baseURIL` 应为 `baseURL`，模型 ID 的前导空格会被平台移除。`DEEPSEEK_V4_FLASH_API_KEEY` 是自定义凭证引用名，虽可作为名字使用，但容易与环境变量实际名称不一致；平台自动生成引用，避免这类错配。平台不自动导入生产网关或读取原有环境变量密钥，需管理员显式登记。

## 接入与同步

- 每个空间选择提供方，也可从已启用提供方中指定默认模型。不指定时不设置平台默认；若之前使用平台默认模型，取消后清除平台写入的默认值，回落到 DSH 自身默认选择。
- 默认模型用于新会话，不强制切换已有会话。
- 运行空间通过认证内部接口同步到 DSH 的 `settings` 和 `credentials` 服务，无需重启 DSH；休眠空间记录待同步，启动就绪后同步。
- 保存与实际同步分别报告。失败仍保留平台配置，界面显示失败并允许重新同步。没有此桥接接口的旧 DSH 镜像会显示失败，不会误报已同步。
- 平台只修改 `guanyin-*` 路由及 `GUANYIN_MODEL_*` 凭证，保留空间其他提供方、主题、权限等设置。不自动隐藏 DeepSeek 官方目录。
- 提供方停用或取消接入会移除对应空间中的平台路由与凭证；删除提供方前须先从所有空间取消接入，之后删除平台元数据和 Secret。PVC 始终保留。
- 配置包含版本号，过期页面保存会拒绝，防止覆盖他人修改。同步状态仅对对应版本提交。
- 工作空间中运行的代码拥有该空间自己的模型凭证，不能把空间凭证视为对空间成员保密。

## 更新范围

本功能需要同时构建新的控制面镜像和 DSH 镜像。DSH 镜像包含新增 `model-sync.mjs` 和更新的 `web-proxy.mjs`，标记 `io.guanyin.models-contract=1`。现有空间需要更新其 Deployment 的 DSH 镜像才能动态接收平台模型；仅更新平台默认 `DSH_IMAGE` 不会修改已创建空间锁定的镜像。

数据库启动时自动新增 `model_providers` 与 `space_model_configs` 表。沿用现有 Secret 的创建、读取、更新、删除权限，不需要 PVC 删除权限。应先升级 DSH，再接入平台模型。

平台接口均为 `/api/admin/` 下的管理员接口：

- `GET/POST /api/admin/model-providers`
- `PATCH/DELETE /api/admin/model-providers/{id}`（删除要求 `confirmName`）
- `GET /api/admin/model-providers/{id}/spaces`
- `GET/PUT /api/admin/instances/{id}/models`
- `POST /api/admin/instances/{id}/models/sync`

DSH 内部 `POST /__guanyin/models/sync` 仅接受空间内部管理令牌，平台浏览器入口不转发此路径。

## 测试连接

新增和编辑提供方时可点击“测试连接”，使用当前表单配置向首个模型发送最小推理请求。编辑时密钥留空会复用已保存的 Secret；测试不保存配置、不接入空间。支持上述三种 API 协议，30 秒超时，显示耗时及鉴权、地址、限流等失败分类，不返回密钥或网关原始响应。测试可能产生少量调用费用，且仅验证管理平台到网关的连通性，不代表各空间的网络均可达。
