# 观因与 DSH 集成路线图

## 启动条件

- [x] `bankops/deepseek-harness-agent:0.1.5-rc.2-core-arm64` DSH 基础镜像构建完成，作为观因新空间默认核心。
- [x] 核心镜像移除 Univer Office 与 Browser Use，保留 Python 文档解析运行时。
- [ ] 记录基础镜像 digest，确保后续观因派生镜像可重复构建。

基础镜像完成后，开始构建观因定制 DSH 镜像。控制平面版本、DSH Core 版本和观因集成层版本分别管理，不共用同一个版本号。

建议首个派生镜像：

```text
bankops/guanyin-dsh:0.1.5-rc.2-gy.1-arm64
```

## 第一阶段：观因身份插件

- [x] 在集中维护的 `@guanyin/dsh-ui-policy` 中实现身份展示层。
- [x] 观因签发 60 秒短期身份 JWT，不向 DSH 转发观因登录 Cookie或第三方凭证。
- [x] 身份包含用户、租户、空间、空间角色和管理员代入状态。
- [x] DSH 边车验证 HMAC 签名、有效期、签发方和受众。
- [x] 提供同源 `/__guanyin/identity` 接口，仅返回安全展示字段。
- [x] 在 DSH 顶栏显示登录人、租户、空间角色和管理员代入状态。
- [x] HTTP 与 WebSocket 由同一网关签发机制注入身份；内部 API Run 通道继续使用空间服务身份。
- [x] 外部请求携带的身份 Header 由观因网关删除并重新生成。

## 第二阶段：观因品牌插件

- [x] 在 `@guanyin/dsh-ui-policy` 中实现品牌层，避免再增加分散插件。
- [x] 替换用户可见的 DeepSeek Harness / DSH 产品名称并使用观因 Logo。
- [x] 替换浏览器标题、favicon，并为 DSH 页面增加统一观因顶栏。
- [x] 普通用户界面隐藏底层 DSH Core 品牌；真实版本仍保留在镜像标签和平台管理数据中。
- [x] 保留发行物中的 MIT 许可证与第三方软件声明。
- [x] 不修改 `@deepseek-ai/*` 内部包名和协议名称，减少对上游源码的侵入。

## 第三阶段：统一 UI 设计体系

目标是让观因控制台和 DSH 工作空间看起来属于同一个产品，而不是两个被代理到一起的系统。

- [ ] 建立共享设计令牌：颜色、字体、字号、间距、圆角、阴影、边框和动效。
- [ ] 统一顶部导航、侧栏、用户区、按钮、表单、卡片、弹窗、状态标签和错误提示。
- [ ] 统一登录人信息、租户、空间名称和空间角色的展示位置。
- [ ] 统一桌面端与移动端断点和交互行为。
- [ ] 为观因控制台和 DSH 建立关键页面截图基线与视觉回归检查。
- [ ] 每次升级 DSH 后检查品牌字符串、布局挂载点和关键交互是否仍兼容。

### Stitch 协作方式

当前 Codex 环境没有可直接连接的 Stitch 插件。可采用以下输入方式推进设计：

1. 在已登录的浏览器会话中打开 Stitch 项目，允许 Codex查看并协作操作。
2. 从 Stitch 导出页面代码、设计资源或截图，提交到工作区作为实现依据。
3. 将 Stitch 产出的设计令牌整理为版本化的 CSS variables / JSON，由观因控制台和 DSH 品牌插件共同消费。

设计稿只是输入，最终以代码中的共享设计令牌、组件规范、响应式验证和截图回归为准。

## 版本与兼容性

每个观因 DSH 镜像至少记录：

```text
DSH Core Version
Guanyin Identity Plugin Version
Guanyin Branding Plugin Version
Guanyin Integration Contract Version
Target Architecture
Source Commit
Image Digest
```

每次 DSH Core 升级必须验证：

- 插件可以正常加载。
- 登录人和管理员代入身份正确。
- HTTP、SSE 与 WebSocket 正常。
- 页面不存在非预期的用户可见 DeepSeek Harness 品牌。
- 观因控制台与 DSH 的关键页面视觉回归通过。
- 原有会话、工具、插件、Skill 和 MCP 能力没有回归。
