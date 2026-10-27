# 观因 DSH 0.1.5 定制清单与 0.2.1 双版本空间方案

核对日期：2026-10-24。当前仓库基线：`3d6e144`。本次为清单和设计评估，没有修改运行配置、构建镜像或升级已有空间。

范围确认：保留现有 0.1.5 镜像，并独立新增 0.2.1 镜像。创建空间时可选择两个版本，已有空间保持原版本。本文的“适配/替换”仅指为新增 0.2.1 镜像实现同等功能，不包含旧空间、会话、归档或定时任务数据迁移。两种空间都必须支持请求及模型用量上报。

## 1. 评估口径与结论

当前“0.1.5”实际基于 `0.1.5-rc.2`，不是无定制的上游发行版。本次核对了仓库脚本及本地 `bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.8-arm64` 镜像内的插件清单。镜像内观因 profile 标记为 `guanyin-enterprise-v9`，它与产品标签 ent8 是不同的版本维度。

目标按上游固定标签 `dsh-v0.2.1-rc.2` 的源码和文档评估；它仍是候选发布版。以下“原生已有”表示源码或文档中确认存在，“建议替换”表示迁移方向，不表示观因集成已经通过运行测试。

建议使用 **0.2.1 官方基础组合 + 观因企业适配层 + 必要的差异插件 + 一种浏览器自动化后端**。优先以新版原生能力承接旧插件功能，保留企业身份、模型与 MCP 管理、用量归属、品牌和 License 约束。0.1.5 与 0.2.1 并存，新空间选择版本；不直接改写旧空间的数据卷。

## 2. 当前额外加载的 11 个插件

以下不计入官方 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`，也不代表包括所有传递依赖。版本以镜像内实际包为准。

| 插件 | 实际版本 | 当前用途与状态 | 0.2.1 建议 |
|---|---|---|---|
| `@guanyin/dsh-ui-policy` | 0.2.9 | 观因品牌、身份展示、隐藏入口、场景文案；服务端用量采集 | 必须保留能力并重构；品牌使用正式扩展位，用量重新适配事件 |
| `@js2hou/dsh-mcp-manager` | 0.1.5 | MCP 管理服务；已移除客户端声明，仅保留 Host 能力，供观因平台调用 | 保留管理协议或重写为新版适配器；不能因页面隐藏而删除服务端 |
| `@michengai/dsh-skills-manager` | 1.1.4 | 本地 Agent Skills 管理/加载扩展；侧栏管理入口受观因策略隐藏 | 先用原生技能发现与调用；另核对导入、编辑、删除等管理需求，缺项再做集中管理适配 |
| `dsh-at-file` | 0.7.0 | 输入区 `@` 搜索并引用工作区路径，不直接注入整个文件内容 | 优先由原生 file-reference 替代；对照目录、排序、大仓库和引用语义 |
| `dsh-better-sidebar` | 0.18.0 | 右侧文件、编辑、终端、Git、网页等工具面板 | 优先退役；原生右侧停靠面板承接，逐项补齐必要差异，不能假定 Git/文件操作完全等价 |
| `@michengai/dsh-codex-ui` | 1.1.17 | Codex 风格左侧栏、空间/会话树、全局搜索及轮次导航 | 优先退役；用新版原生空间/会话界面，重挂观因品牌与身份区 |
| `@michengai/dsh-automation` | 0.1.50 | 自动化任务及独立会话执行 | 新版优先使用原生 Schedule；独立执行语义、暂停/立即执行等操作需逐项核对，避免功能缩水或双重调度 |
| `@michengai/dsh-archive-manager` | 1.0.5 | 会话归档管理 | 新版优先用原生归档筛选/恢复，核对批量操作等差异；旧空间保留现有插件 |
| `@changfenhuang/dsh-genui` | 0.11.0 | `dsh-ui` 交互式输出：图表、布局、表单、测验、Mermaid、3D 等，交互可回传模型 | 保留差异能力；需要新版兼容实现，不能当作普通 Markdown 渲染直接删除 |
| `dsh-context` | 0.56.1 | 上下文组成、变化及用量观察面板/命令；部分技术信息区隐藏 | 保留评估；原生 Token 数或压缩命令不等于完整组成与变化分析 |
| `dsh-mermaid-web` | 0.1.0 | 渲染完成的 Mermaid 代码块 | 先做渲染验证；若新版聊天原生覆盖或 GenUI 能统一覆盖普通代码块，再删除，避免重复渲染 |

清单来源：[profile-package.json](../deploy/dsh-0.1.5-core/profile-package.json)、镜像内 `/opt/dsh-seed/profiles/web/package.json` 及各插件 `package.json`。

### 加载方式与兼容性问题

当前插件不是用户每次进入空间时在线下载：构建阶段安装本地 tgz，将插件写入 `dsh.profile.bundles`，随镜像 seed 初始化到空间，`patchReload` 为 `live`。MCP 包通过构建脚本删除 `dsh.client` 声明，实现 Host-only。

旧插件声明不能证明支持 0.2.1：

- Codex UI 的多项依赖限制在 `<0.2.0`；归档、自动化、Skills 管理器的兼容版本列表主要止于 0.1.x。
- GenUI 与 better-sidebar 声明依赖 `dsh-invariants`，上游 0.2.1 已移除该运行时包和相关导出；需要检查实际导入并迁移，不能通过忽略 peerDependencies 来当作兼容。
- `dsh-context` 的宽松最低版本和 `dsh-at-file` 的 `*` 依赖也不代表已经适配新版 API。
- 升级时需检查 `engines.dsh`、实际导入、Host 服务、客户端 Slot 和存储协议；安装成功只是第一步。

上游依据：[0.2.1-rc.1 兼容性变更](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)。

## 3. 现有个性化与企业集成

| 范围 | 当前已经实现 | 新版必须保持/重新验证 |
|---|---|---|
| 身份 | 平台签发短期 HMAC 身份；代理验证签名、签发方、受众和时效；同源 identity 接口 | 用户、租户、空间、角色和管理员代入显示正确，HTTP 与 WebSocket 归属一致 |
| 登录与代理 | 3080 代理到内部 DSH 3081，处理 DSH Web token、Cookie 和 WebSocket；区分空间 token 指纹 | 新版认证握手、反向代理路径、重连、多空间并开；不能直接照搬旧协议假设 |
| 返回控制台 | 侧栏身份卡返回同源 `/console?from=dsh` | 保留用户上下文，不能跳去社区版 |
| 模型 | 平台模型同步至 `guanyin-*` provider，使用 `GUANYIN_MODEL_*` 凭据，保留非托管模型配置 | 增删、改密钥、默认模型、新会话与已有会话行为 |
| 无 API Key | 无鉴权模型可不建 Secret、不设 apiKeyEnv，并清掉旧托管凭据 | 普通聊天、工具调用、流式响应及 DSH 访问都通过真实模型验证 |
| 流兼容 | 对无鉴权 `openai-completions`，未显式配置时默认 `supportsFinishReason=false` | 缺 finish_reason 的正常结束可用；同时测试空响应、工具 JSON、主动取消和网络中断；连接测试为非流式，不能替代流式测试 |
| 推理档位 | 可同步 `reasoningEfforts` 可用档位映射 | 目前尚未做平台“默认 high”设置；它是独立需求，升级不会自动补齐默认 reasoningEffort 的同步 |
| MCP | 平台空间管理页统一配置，内部代理调用 MCP 管理服务 | 服务增删改、启停、同步、重启恢复和空间隔离 |
| API Run | 代理允许的 DSH RPC、事件流和调用人归属记录 | 新版会话创建、选模型、prompt、cancel、skills/list 和事件协议 |
| 用量 | Host 拦截模型流，读取最终累计值，关联调用人；本地持久队列，每约 15 秒批量上报，失败重试 | 真实值/未知值、缓存输入口径、失败与重试不重复计费、不同调用入口归属；重新核对新版事件字段 |
| 平台审计 | 控制平面保留最近一年审计及用量明细 | 原生界面 Token 计数不能替代企业跨用户、租户、空间的统计 |
| 持久化 | seed + release marker 管理 profile，保留空间会话/工作目录/凭据 | 当前 entrypoint 的已知 profile 迁移是 0.1.5 内部升级，不是 0.1.5→0.2.1 数据迁移方案 |
| 文档运行时 | 核心镜像保留 Python 文档解析运行时 | 按需使用的 Python、Office/渲染依赖提前纳入离线物料，不能依赖首次使用再联网下载 |
| License | 控制平面用固定配置公钥验证授权，限制平台/API/代理入口 | 保留固定公钥与签发端匹配，升级镜像不能重生成密钥；DSH 本身不是独立 License 验证器 |

关键实现：[web-proxy.mjs](../deploy/dsh-0.1.5-core/web-proxy.mjs)、[model-sync.mjs](../deploy/dsh-0.1.5-core/model-sync.mjs)、[usage.js](../deploy/dsh-0.1.5-core/guanyin-ui-policy/lib/usage.js)、[patch-settings-client.mjs](../deploy/dsh-enterprise/patch-settings-client.mjs)、[entrypoint.sh](../deploy/dsh-enterprise/entrypoint.sh)、[server.mjs](../control-plane/server.mjs)。

另有一处旧版设置持久化补丁：将默认仅 loopback 可持久化的行为，扩展到观因 identity 校验通过的远程 Web。0.2.1 已有远程设置修复，应先验证原生行为，再决定是否保留补丁；不能直接套用旧版打包字符串。

平台的“空间设置 / 空间成员 / 空间模型 / MCP”四子菜单属于观因控制台定制，不属于 DSH 插件，升级 DSH 时仍应保留。

## 4. 当前隐藏、禁用和未安装的模块

这三种状态需要分开，隐藏菜单不等于卸载服务或禁止后台调用。

| 类型 | 当前处理 |
|---|---|
| 隐藏侧栏入口 | 扩展管理、专家、技能、插件、连接器、IM 助理及对应英文；移除 Codex UI 扩展分组 |
| 隐藏设置入口 | DSH 内 MCP 设置，管理入口统一到观因空间管理 |
| 隐藏技术/外链区 | 关于页相关外链，设置中的 GitHub/npm 链接，上下文面板的部分插件技术信息区 |
| 隐藏更新操作 | 检查更新、重新检查等入口，由观因统一发布版本 |
| 隐藏官方模型入口 | 从配置列表和可添加列表过滤 `deepseek-official`，移除官方 API Key onboarding |
| 禁用模块 | 企业定制 patch 将 `web-search-deepseek` 设为 disabled |
| 明确未安装 | `dsh-univer-office`、`dsh-agency-agents`、`dsh-bridge-browser` |

未安装 browser bridge 不代表没有网页预览，better-sidebar 有网页查看能力；网页预览也不代表模型具有浏览器自动化。未安装 agency 插件不代表 DSH 没有原生子代理。

0.2.1 需要把这些约束映射到新的组件/注册项，尽量通过 profile 禁用不需要的 UI，而非只按按钮文字删除 DOM。仍需保留的后台能力，例如 MCP 与 Skills 加载，不应随着管理菜单一起被移除。

来源：[client.js](../deploy/dsh-0.1.5-core/guanyin-ui-policy/lib/client.js)、[customize-profile.mjs](../deploy/dsh-enterprise/customize-profile.mjs)、[build-policy.json](../deploy/dsh-0.1.5-core/guanyin-ui-policy/build-policy.json)、[核心 Dockerfile](../deploy/dsh-0.1.5-core/Dockerfile)。

## 5. 品牌优化与迁移方式

当前已有：

- 侧栏“观因”名称与 Logo；首页大 Logo；favicon。
- Logo 随已识别的深色主题标记变为白色轮廓，浅色保留原图。实现是 CSS 滤镜，不是分别加载两张主题图。
- 初始 HTML 标题、启动转圈文案改为“观因智能空间”；分析状态改为“观因分析中...”。
- 用户可见 DeepSeek Harness / DSH 文案替换为“观因工作空间”；构建检查避免文昌品牌混入企业插件。
- 登录身份、租户、空间和管理员代入信息卡及返回控制台交互。
- 首页四类场景调整为“智能运维、办公提效、应用构建、代码审查”，并替换场景说明。

当前局限：大量挂载依赖 `.dcu-*` 类名与 MutationObserver，标题/启动文案/模型入口还依赖精确打包字符串。删除 Codex UI 后这些选择器会失效。通用文字遍历也应缩小到产品 UI，避免改动用户对话中的产品名称。

0.2.1 应编写新版观因品牌插件，使用 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`，不加载官方品牌占位插件；浏览器标题使用上游 `DSH_CLIENT_TITLE` 构建配置。启动壳、favicon、分析文案、场景区和身份区分别核对，不能认为替换侧栏 Logo 就完成品牌迁移。深浅主题优先提供清晰的两套资源或主题变量，并测试自动跟随系统及切换后的刷新恢复。

上游依据：[官方品牌替换契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-brand-official/README.md)。

## 6. 0.2.1 原生能力能够替代多少

| 已确认存在的原生能力 | 对旧插件的影响 | 不能跳过的差异 |
|---|---|---|
| 工作区/会话树、搜索、排序、归档及归档筛选 | Codex UI 和 archive-manager 可优先替换 | 会话轮次导航、批量归档及旧插件记录，需要单独核对 |
| 右侧停靠面板、文件树、文档/文件预览、终端、浏览器页 | better-sidebar 有较大重叠 | 原生文件树主要负责列举；搜索、文件操作、Git 操作不能一概视为覆盖 |
| 本地 `@file` 候选检索与路径引用 | at-file 可优先替换 | 忽略规则、排序、目录引用、文件读取语义和大目录体验 |
| Skills 发现、`/` 选择与调用 | Skills 加载可优先用原生 | 原生调用 UI 不等于完整的技能导入/编辑/删除后台 |
| 内置 Schedule 和任务页面 | automation 可优先替换 | 原生任务的会话语义与旧插件独立任务不同；官方“已有任务保留”不能解释为自动迁移第三方插件数据 |
| 新的品牌和内容扩展位 | 观因 UI 策略可以减少 DOM 补丁 | 每个隐藏模块和状态文案仍需重新映射 |

源码依据：[工作区与归档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-workspace/README.md)、[Web 默认组合](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/cordis.patch.yml)、[文件树及其限制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-sidebar-files/README.md)、[路径引用](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/context/file-reference-local/README.md)、[Skills 调用](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-skill/README.md)、[Schedule UI 及限制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-schedule/README.md)。

尚无充分证据认定新版原生完整替代 GenUI、上下文组成分析或普通聊天 Mermaid 插件。仓库网站有 Mermaid 展示代码，也不能据此认定聊天窗口已支持，应以实际对话渲染验证。

## 7. 新增浏览器能力的建议

### 选择一种自动化后端

首选 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`，明确加载共享 browser-use 服务和该 provider。先使用容器内 Chromium、`launch`、headless，面向企业内网网页操作。此能力在上游仍属实验性、显式启用；不能仅升级到 0.2.1 就声称已开启。

同一 browser-use 服务只允许一个 provider，不能同时装入 Playwright、Chrome DevTools 和 Stagehand 并启用。Chrome DevTools 可作为后续调试型方案。Stagehand 的 AI 操作需要单独配置其模型，尚未接通 DSH 的模型路由、凭据复用和会话用量统计，因此不建议作为第一版默认方案。[后端及会话契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/subsystems/browser-use.md)、[Stagehand 限制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/browser-use-stagehand-native/README.md)。

### 使用边界

- 右侧网页预览和 Agent 自动化分开验收；前者不提供后者的工具权限。
- K8s 中启动的是服务器浏览器，不会自动操作使用者电脑上的 Chrome；接管本机浏览器需要额外桥接与授权设计。
- 浏览器资源跟随活跃 Agent/Session，跨轮复用；销毁、重载、fork 的状态不能当作登录持久化承诺。若要保存登录态，需要单独定义隔离和生命周期。
- attach 模式操作外部浏览器，进程内独占不代表跨 Pod 全局独占；第一版不默认开放。
- 截图要验证图片附件存储和视觉模型路由；纯文本模型不保证理解截图。

依据：[Playwright provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/browser-use-playwright-mcp/README.md)。

### 离线与 K8s

将匹配版本的 Playwright MCP、Chromium、系统库、字体、内网 CA 和必需 npm 包预装进镜像，固定版本和校验值；运行时不得靠 npx 临时下载。amd64/arm64 分别构建并验证浏览器可执行文件。浏览器会增大镜像与资源占用，具体体积和并发上限以实测为准。

验证现有 non-root、drop capabilities、共享内存和沙箱配置能否启动 Chromium，不以默认关闭浏览器沙箱作为解决方案。测试访问内网站点、代理、自签证书、下载/上传、取消和空间销毁后的进程回收。只赋予当前空间的浏览器数据与下载目录，避免共享其他租户登录状态。

## 8. 新版插件如何加载和优化

建议采用两个独立版本的 profile，统一企业适配协议，并按能力显式组合：

1. 固定版本的官方 base/Web 组合与必需 Host 服务。
2. 观因身份、模型/MCP 同步、API Run 和用量上报适配层。
3. 原生文件/会话/归档/Skills/Schedule UI；在 profile 中关闭不公开的入口。
4. 使用声明感知注册的观因品牌、身份和业务场景 UI，避免依赖加载先后碰运气。
5. 通过兼容性检查的 GenUI、上下文、Mermaid 差异插件；未通过的不得混入正式镜像。
6. 浏览器共享服务和一种 provider，在创建/恢复会话前激活，避免旧活跃会话拿不到浏览器工具。

这是能力组合顺序，不是可以直接复制到 0.2.1 的已验证配置。需按新版注入关系生成 profile 并检查依赖树；不能把 0.1.5 的整个 node_modules 或 bundles 原样搬过去。

构建优化：

- 记录完整 core/plugin/观因适配层版本、架构、源码 commit、镜像 digest；锁定所有离线物料。
- 不用 `--legacy-peer-deps` 掩盖旧插件依赖冲突；避免插件带入第二套旧版 DSH Host/Client。
- 用原生能力替换后，连同其不再需要的传递依赖移除，再比较镜像分层和运行时体积。
- 若上下文与 Mermaid 是纯展示扩展，尽量不增加额外模型工具或系统提示；GenUI 等需要模型指导的扩展单独衡量上下文开销。
- 保持 MCP 业务管理与浏览器 provider 生命周期分开，避免把受会话管理的浏览器 MCP 当作普通共享 MCP 重复注册。

## 9. 多版本空间还需要修改的平台部分

当前数据库虽然记录空间 version/image，但控制平面仍是单版本实现：

- overview 只返回一个 `DSH_VERSION/DSH_IMAGE`。
- 创建接口拒绝其他版本，并写入全局默认版本。
- provision 使用全局 `DSH_IMAGE`，不是空间记录的 image。
- 启动协调逻辑跳过不是当前 `DSH_VERSION` 的空间。

因此，仅增加前端下拉选项不够。需要版本目录，至少包含 coreVersion、企业适配版本、架构、image digest、可用状态和浏览器能力；创建、启动、休眠后恢复、重建和同步都按空间所选版本处理。模型/MCP/RPC 通过版本适配器调用，不能只在创建时保存版本号。

0.1.5 镜像继续保留，创建空间时同样可选；0.2.1 为独立新增选项。每个空间固定使用创建时的版本与镜像，启动、重启、休眠恢复和同步均遵循此记录。不同空间使用独立 PVC，不将 0.2.1 挂到旧空间数据卷；本次不设计旧空间版本切换或数据迁移。

### 每个空间的请求与用量上报

此项是两个版本共同的企业必需能力，不因新版已有 Token 展示而省略。上报协议统一，DSH 内部采集适配按版本分别实现；0.1.5 保持现有镜像与功能。

当前已确认的实现：

- 平台记录进入空间的 `dsh_enter` 审计，并对经过平台代理的 DSH HTTP POST 记录 `dsh_operation`（用户、空间、路径、状态码及耗时）。这不等于已经记录每个 HTTP 请求或每条 WebSocket 消息。
- 每次模型流调用生成独立事件 ID，记录会话、模型、用户归属、结果、耗时和 Token；由空间持久化队列批量上报 `/internal/usage/<instanceId>`，收到确认后删除，失败重试。
- 接收端验证对应空间的扩展 token，以服务器查到的空间记录确定空间和租户，避免信任客户端自报的空间归属。

双版本需要遵守的设计与验收口径：

| 事件层次 | 应记录的内容 | 验收重点 |
|---|---|---|
| 空间访问/业务操作 | 实际用户、租户、空间、入口来源、时间、操作及结果；补充空间版本维度 | 0.1.5/0.2.1 可并行查询；管理员代入仍可追溯实际操作者 |
| 对话/API 请求 | 请求关联 ID、会话、调用入口、状态、耗时，以及关联的模型调用 | 页面聊天、OpenAPI、定时任务和子代理分别验证；WebSocket 业务请求不能只靠 HTTP POST 审计覆盖 |
| 模型调用/用量 | 独立事件 ID、请求关联、模型、输入/输出/缓存 Token、真实/未知标记、成功/失败/取消 | 一次业务请求可能调用模型多次；上报重试不能重复累计，模型真实重试则保留实际调用记录 |
| 浏览器工具 | 归属当前空间、会话和请求的执行结果/耗时 | 浏览器工具调用不冒充模型调用；其引发的模型调用继续走统一用量采集 |

对话请求关联、来源分类和版本维度属于待实现/待核对的统一协议要求，不能宣称当前字段已经齐全。未知用量保持未知，不能因模型没有 API Key 或没返回 usage 就漏掉调用记录、或填成零 Token。后台定时任务/子代理没有实时登录用户时，应标记真实来源和可追溯归属，不能直接沿用会话最后一位发言者。

继续保留一年明细；不上传对话正文、API Key 或浏览器 Cookie。静态资源、健康检查和上报请求自身不得计入模型调用次数。故障验收需覆盖控制平面短暂不可达、空间重启后补报、重复批次、多空间并发和升级后事件字段变化；如补充字段，接收端须继续兼容未改动的 0.1.5 上报。

## 10. 实施顺序与验收

| 阶段 | 产出 | 通过条件 |
|---|---|---|
| A：固化基线 | 0.1.5 实际插件/镜像/源码和离线物料清单 | 统一源码与镜像插件版本；可从固定物料重建 |
| B：干净启动 | 0.2.1 原生测试镜像及独立测试空间 | 不依赖旧插件可以启动、聊天、重启和继续会话 |
| C：企业等价 | 身份、品牌、隐藏策略、模型/MCP、请求和用量上报与平台代理适配 | 深浅主题和刷新无品牌闪回；无 Key/有 Key 模型、工具流、统计归属、断线补报及去重均通过 |
| D：插件精简 | 旧插件逐项原生替换，保留必要差异 | 归档、搜索、@file、Skills、定时任务、图表和上下文无关键回归；任务不重复运行 |
| E：浏览器 | 显式启用 Playwright 的浏览器镜像 | 内网浏览、表单、截图、上传下载、取消、隔离与资源回收通过 |
| F：版本并存 | 新建空间可选 0.1.5/0.2.1，架构物料齐全 | 两种空间并行启动/休眠/恢复/同步正确，License 和固定公钥不受影响 |
| G：离线交付 | 对应架构离线包和清单 | 断网环境完整安装、创建空间及使用全部交付能力，无首次下载依赖 |

当前发现的构建基线差异：仓库观因插件源码及 tgz 文件名仍是 0.2.7，而镜像实际安装为 0.2.9；核心 Dockerfile 引用的 `deploy/dsh-0.1.5-core/plugins` 目录在当前工作区缺失。因此不能宣称仅凭当前仓库即可重现现有完整基础镜像，应先补齐物料来源及版本校验。

本次已完成：现有插件/脚本/平台入口核对、固定上游标签文档和组合配置对照，以及双版本请求上报设计口径。尚未完成且没有宣称完成：0.2.1 企业镜像构建、插件运行兼容验证、双版本请求上报验收、浏览器端到端验证与离线包验证。旧空间数据迁移不在范围内。
