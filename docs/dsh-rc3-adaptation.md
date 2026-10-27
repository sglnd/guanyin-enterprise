# 观因 DSH rc3 适配与维护边界

目标：上游固定 `0.2.1-rc.3`，保留 0.1.5 镜像；企业适配限于品牌、平台身份、模型/MCP 接入、用量归属与必要部署修复。不自建完整 Skill 或文件管理器。

## 扩展选择

- MCP：企业插件增加只读设置页，使用公开 Loader/Tools 注册表展示配置与工具。平台下发配置仍由平台管理。状态明确称为“工具已注册”，不能将工具数量伪装成实时连通性。不读取认证头、环境变量、命令参数，不把查询串或 URL 用户密码发给浏览器。
- Skill：候选 `@michengai/dsh-skills-manager@1.2.16`，官方包明确将 rc3 列入 peerDependencies；与 0.1.5 已有管理器同作者。较新 1.2.19 的预发布 peer 范围被 npm 拒绝，不使用 legacy-peer-deps 或维护插件 fork。通过宿主 `onlineUpdate: false` 关闭插件二进制自升级，技能内容仍可在空间管理。
- 文件：候选 `@weibaohui/dsh-file-share@0.3.4`，使用原生 `conversation.view` 扩展槽，Host 以会话 cwd 确定文件根目录，并调用 `connection.requestRejection`。包含上传、下载、ZIP、路径与符号链接边界检查。原生预览保留，不改写其内部实现。Office 预览性能另行测量，本次不承诺改善。

插件是否启用，以隔离容器中的运行与浏览器验证为准，包声明不等于兼容验证。

来源：
- https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3
- https://github.com/MichengAI/dsh-skills-manager
- https://github.com/weibaohui/dsh-file-share

## 必须管理的补丁

| 位置 | 原因 | 移除条件 |
| --- | --- | --- |
| `enterprise-plugin` | 品牌、只读连接器、平台 MCP、请求用量 | 上游提供等价扩展接口时仅替换实现 |
| `prepare-profile.mjs` | 启动壳文案、品牌、隐藏官方账号引导、Mermaid fence 元数据 | 对应能力有稳定配置/扩展槽时移除源码替换 |
| `patch-pi-no-auth.mjs` | 平台明确配置免 Key 的内网模型 | 上游 SDK 原生支持免 Key，且验证不发送伪凭证后移除 |
| `patch-workspace.mjs` | 挂载工作区作为默认目录 | 上游默认目录可直接配置后移除 |
| `patch-http-bridge.mjs` | 未读上传拒绝先发送响应再关闭连接 | 上游等价修复通过大文件早期拒绝回归后移除 |
| `web-proxy.mjs` API identity encoding | 已复现浏览器压缩协商导致 socket hang up | 上游压缩修复在实际代理链路验证后移除 |
| PVC owner init / UTF-8 env | 非 root 持久卷与中文 PTY | 部署职责，通常长期保留 |

升级时所有文本补丁必须精确命中，否则构建失败。禁止静默忽略补丁目标变化；禁止为通过安装强行忽略 peer 冲突。

## 现有空间

入口仅允许同一 `guanyin-enterprise-021-v1` profile 从 rc2 单向升级到 rc3。备份原 profile package 与版本标记，合并新增受管 bundle，保留用户 patch、会话、模型及 MCP。0.1.5、不明版本与降级一律拒绝。更新现有测试空间前另做私有备份；镜像标签和数据库记录与目录配置保持一致。

## 验证结果（2026-10-26）

隔离容器以非 root、cap-drop=ALL、no-new-privileges 运行。固定上游 DSH 包均为 rc3，未使用 legacy-peer-deps。以下已验证：

- 假模型免 Key 调用未带 Authorization，浏览器成功访问本地测试页，请求用量按调用人上报。
- 中文 DOCX 会话附件与 2MiB 二进制附件上传成功，错误浏览器 Cookie 不影响选定空间身份，无效签名拒绝。
- 异常会话的 2MiB 上传在关闭连接前流式排空、限制在原 bridge 上限以内，连续 12 次完整返回业务错误，无 502。修复仍归入已有 HTTP bridge 补丁。
- MCP 页面实际显示测试服务、平台来源、注册状态、echo 工具说明，认证信息不返回客户端。
- Skills Manager 在页面中新建测试技能成功，创建结果出现在原生 skills/list 中。在线插件更新被宿主锁定。
- File Share 在页面上传 DOCX 到 /workspace 并下载到电脑；原文件与下载文件 SHA-256 一致。API 验证中文文件名传输、ZIP 和目录越界拒绝。
- 独立 rc2 数据卷升级启动成功，原测试数据与 profile 备份保留；新 bundle 合并成功。
- 控制平面 41 项测试通过、4 项需独立数据库的集成测试跳过；新增适配测试 3 项通过。

截图位于 dist/dsh021-validation/rc3-connectors.png、rc3-skills.png、rc3-files.png、rc3-file-download.png。这里只使用合成文件、本地假模型与测试 MCP。

## 本地交付版本

最终镜像：`0.2.1-rc.3-gy.ent.2-arm64`，digest `sha256:5e01280c683e2bbd7013b7a3d6db878d3796e168c758679bffe54c7b9677407e`。原本地 0.2.1 测试空间继续使用同一组 PVC；平台版本目录和该空间数据库 image/version 同步更新。0.1.5 创建默认值保留。

验收旧 profile 时发现，简单追加新 bundle 会让旧企业层位于 Skill bundle 之前，导致插件更新锁定配置未生效。现已通过公开 profile bundle 顺序将企业层置于最后，并保留自定义 bundle；在既有 rc3 标记的数据卷上修复也已验证。页面、接口均确认更新锁定，新增回归测试防止重复出现。

部署前私有备份保存于 `dist/private-rc3-backup/`，包含原部署配置和空间数据，目录未纳入 Git。回退需同步恢复 profile package 与版本标记，不能仅将镜像降回 rc2。

### 技能页面与设置入口（gy.ent.3）

- 由观因客户端适配层统一隐藏技能页的 GitHub、问题反馈、发现技能标签，以及所有设置分类共用的“打开配置文件”入口。
- 本地/项目技能来源名称显示为“观因”，来源图标通过 `currentColor` 蒙版适配深浅主题；真实技能目录、来源 ID 和插件 API 保持原样。
- 保留全局技能、项目技能、回收站、创建和导入操作。若热加载时发现技能标签已激活，自动回到全局技能。
- 升级检查点：rc3 的 `SettingsDocumentAction` 样式类 `.me01iq_action`，技能插件的 `.dssm-feedback-links`、`#dssm-tab-repositories`、`.dssm-source-title`、`.dssm-brand-icon > img[alt="DSH"]`。集中在 `installEnterpriseSettings`，未分叉插件源码。

本地验证：`0.2.1-rc.3-gy.ent.3-arm64` 已部署到现有 0.2.1 测试空间并就绪；设置各分类均未显示配置文件入口，技能页只显示全局/项目/回收站三个标签，创建技能弹窗的位置和来源开关的无障碍名称也已改为观因。深浅主题 Logo 均可见，测试后恢复原浅色设置。语法检查、diff 检查与 3 项兼容/连接器测试通过。截图保存在 `dist/dsh021-validation/rc3-skills-ent3.png`。

### 技能标签布局（rc3 gy.ent.4）

修正隐藏发现标签后仍按四列分配宽度和选中指示器宽度的问题。剩余全局技能、项目技能、回收站使用三等分网格，各标签独立显示选中背景，统一高度和间距；键盘左右键及 Home/End 只在这三个可见标签之间切换。

本地浏览器验证：三个标签宽度均为 183px，菜单高度 38px、标签高度 30px、间距 4px；点击与 Home/End/左右键切换通过。已部署到本地现有 0.2.1 测试空间。截图：`dist/dsh021-validation/rc3-skills-ent4-tabs.png`。语法与 diff 检查通过。

### 高级设置名称与上下文排版（rc3 gy.ent.5）

- 高级设置的技能配置标签通过现有 bundle key 映射为“技能”，不再直接显示 npm 包名。
- 通过上下文插件现有 `.lc-pi-hint` 标识隐藏整张插件信息卡片（含宣传链接、版本和插件设置入口），并将同排的上下文统计卡扩展为一整行；其他统计、趋势图、上下文浏览器及设置保存协议保留。
- 适配仍集中在企业客户端，不改上下文插件源码与配置数据。

本地验证通过：高级设置选项卡显示“技能”，配置表单仍正常渲染；上下文插件信息卡不可见，同排统计卡宽度与整行一致（1353px），未留下占位。已更新本地 `0.2.1-rc.3-gy.ent.5-arm64` 测试空间。语法、diff 检查通过；截图为 `dist/dsh021-validation/rc3-ent5-advanced-skills.png` 和 `rc3-ent5-context.png`。

### 会话删除与高级设置（rc3 gy.ent.6）

新增独立企业会话删除适配，菜单与确认弹窗使用原生扩展槽。普通/已归档会话可删除；运行任务、子智能体或被其他会话依赖的记录明确拒绝，保留归档能力。完整设计、依赖边界和验证见 `docs/dsh-0.2.1-session-deletion.md`。

高级设置统一使用子智能体、智能体循环、终端、技能、上下文分析等功能名称，配置区域去掉项目介绍和外链。原生设置保存协议保持不变。

### 日志下载菜单（rc3 gy.ent.7）

去掉会话标题栏日志下载菜单的“反馈”入口，保留“下载 Session 日志”及原生 ZIP 导出。补丁集中在 `patch-session-log-menu.mjs`，仅将导出菜单的可选反馈项关闭，不禁用消息评价或其他反馈能力。完整构建与 overlay 构建均应用该幂等补丁；如果上游目标不再唯一匹配，构建明确失败并要求复核。

本地空间已更新 ent.7 并就绪，浏览器刷新后确认标题栏菜单只有“下载 Session 日志”，不再出现“反馈”。补丁语法、幂等应用、构建目标匹配及 diff 检查通过。截图：`dist/dsh021-validation/rc3-ent7-log-menu.png`。
