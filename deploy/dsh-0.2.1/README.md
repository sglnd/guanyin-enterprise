# 观因企业版 DSH 0.2.1 空间镜像

独立于 `deploy/dsh-0.1.5-core` 和现有 ent8 镜像。面向新建空间，不转换旧空间的数据卷。

## 构建

```sh
docker build --platform linux/arm64 -f deploy/dsh-0.2.1/Dockerfile \
  -t bankops/guanyin-enterprise-dsh:0.2.1-rc.3-gy.ent.7-arm64 .
```

依赖锁在 `runtime/package-lock.json`；基础 Node 镜像和 Debian 源可通过 `NODE_IMAGE`、`DEBIAN_MIRROR` 构建参数指定。ARM 本地可使用现有 Debian/Node 24 镜像作为引导基础，构建会移除旧 DSH 代码并在末阶段重新封装文件系统，避免携带旧空间镜像层；不同架构的基础镜像必须匹配。

DSH 固定 `0.2.1-rc.3`，GenUI `0.14.0`、Context `0.75.1`。归档、工作区/会话侧栏、文件引用、文件预览/终端和定时任务使用新版原生能力。浏览器由显式加载的 Playwright MCP provider 提供，Chromium 和字体预装，不在启动时下载浏览器。

新版工作区通过原生初始化接口在服务就绪后建立，默认目录固定 `/workspace`，避免插件加载阶段等待工作区服务造成冷启动阻塞。无 Key 模型另外适配新版 pi-ai 的认证检查：仅对观因受管且明确无凭证的模型省略认证头；已有真实 Key 的模型保持原有认证。

`Dockerfile.overlay` 用于在已构建的同版 0.2.1 runtime 上迭代企业插件，必须显式指定 `RUNTIME_IMAGE`。它不用于把 0.1.5 镜像直接变成 0.2.1；完整依赖安装和运行时替换由主 Dockerfile 完成。

## 控制平面双版本配置

保留现有 `DSH_VERSION`、`DSH_IMAGE`，增加环境变量，例如：

```json
DSH_ADDITIONAL_VERSIONS=[{"id":"0.2.1-rc.3-gy.ent.7","label":"0.2.1 · 观因企业版","image":"bankops/guanyin-enterprise-dsh:0.2.1-rc.3-gy.ent.7-arm64","enabled":true}]
```

上述配置需在镜像构建验证并导入集群使用的 registry 后启用。生产推荐使用 image digest。创建接口按目录校验版本；启动和恢复优先使用空间数据库中已保存的 image，目录后续调整不会将已有 0.1.5 空间切到新镜像。

## 企业集成接口

- 3080 对接现有平台，DSH 在容器内 3081 监听。
- `DSH_EXT_TOKEN`：空间内部管理认证，以及平台签发身份验证。普通 HTTP/WebSocket 访问仍经过观因平台的登录和 License 校验。
- `DSH_TRUSTED_HOSTS`：沿用平台允许的访问域名列表。
- `/__guanyin/identity`、`/__guanyin/brand/*`：身份与品牌资源。
- `/__guanyin/models/sync`：沿用模型同步协议，支持有 Key、无 Key 和流式结束兼容。
- `/__guanyin/mcp-manager/{list,add,remove}`：保留平台管理协议，独立实现新版的受管 MCP patch。
- `/__guanyin/dsh-rpc/*`、`/__guanyin/dsh-stream`：API Run 会话接口与事件流。
- `GUANYIN_USAGE_URL`：沿用空间级批量上报协议，队列位于持久化数据卷内。新增请求 ID 和来源字段；接收端兼容原版 0.1.5 事件，空间版本由平台记录确定。

不在镜像中生成 License 密钥。企业固定公钥仍由控制平面配置；签发端无需因新增空间版本而换密钥。

### Web 登录与设置修复（gy.ent.2）

本地社区版和企业版运行在相同 hostname 的不同端口时，浏览器仍共享 Cookie。企业控制平面现在独立使用 `guanyin_ent_session` 和 `guanyin_ent_instance`，升级后须重新登录一次。未登录的 DSH `/api/*` 返回 401 JSON，避免登录页 HTML 被当作 RPC JSON 解析。

0.2.1 空间代理在验证平台的每空间 HMAC 身份后，按实际 Host 换取当前空间的原生认证 Cookie，同时用于 HTTP、上传和 WebSocket。该认证不会复用其他空间的浏览器 Cookie；无效签名仍拒绝访问。已有 0.1.5 镜像不改写。

设置页增加“高级设置”，承接新版放在插件管理页的终端、Agent 循环、子智能体及上下文偏好表单，保持原生保存协议，不开放插件安装。会话“上下文”和全局“上下文洞察”同属 dsh-context，分别提供单会话分析和跨会话汇总。

`regression-check.mjs` 仅对测试 fixture 与独立容器运行，验证错误浏览器 Cookie 下的预设、中文 DOCX 上传、2MB 二进制上传和无效身份拒绝。测试 DOCX 使用合成数据，不需客户文件。

## 本地集成验证

`test-fixture.mjs` 提供本地假模型、用量接收器、网页和签名网关，全部为测试数据，不调用客户模型：

```sh
node deploy/dsh-0.2.1/test-fixture.mjs
docker run --name guanyin021-smoke -p 127.0.0.1:19091:3080 \
  -e DSH_EXT_TOKEN=guanyin-021-local-smoke-only \
  -e GUANYIN_USAGE_URL=http://host.docker.internal:19092/usage \
  -e DSH_TRUSTED_HOSTS=127.0.0.1:18081,127.0.0.1:19093,localhost:19093 \
  --shm-size=256m bankops/guanyin-enterprise-dsh:0.2.1-rc.3-gy.ent.7-arm64
```

测试网关 `http://127.0.0.1:19093` 仅用于验证镜像。测试完成后移除测试容器、停止 fixture；真实部署应由平台创建独立持久卷并注入每空间密钥。

2026-10-25 本地 ARM 验证记录：控制平面在独立 PostgreSQL 数据库运行 51 项测试全部通过；最终镜像使用全新命名卷、无源码挂载，在移除 Linux capabilities 的配置下完成冷启动、模型同步、MCP 管理接口、浏览器访问和请求级用量上报。OpenAI completions 无 Key 请求实际未携带 Authorization。终端 PTY 和旧版本数据卷拒绝覆盖检查通过。深浅主题品牌、Mermaid 和 GenUI 已完成浏览器检查。以上使用本地模拟模型，不代表所有第三方模型协议和外部网站均已验证。

### 上传与终端修复（gy.ent.3）

Kubernetes 新建 0.2.1 空间通过 `prepare-data-owner` init container 将数据卷根目录设置为 uid/gid 1000、0700。附件存储会 chmod DSH_HOME，因此仅使用 fsGroup 不能满足要求。初始化只处理数据卷根目录，应用仍以非 root 身份运行。已有空间更新时也必须补上此 init container；仅更新镜像不足以修复 root 所有的旧卷。

镜像为 PTY 设置 C.UTF-8 locale。HTTP bridge 在拒绝未读完的上传时先发送完整错误响应，再关闭请求，避免代理将业务错误表现为 502。

## rc3 integration

See `docs/dsh-rc3-adaptation.md` for the patch inventory and plugin evaluation. The overlay Dockerfile requires an existing rc3 runtime; use the full Dockerfile to change upstream runtime versions. `plugin-check.mjs` runs only with the disposable local fixture.

### rc3 技能页面精简（0.2.1-rc.3-gy.ent.7）

技能页隐藏 GitHub、问题反馈和发现技能入口，技能来源使用观因名称及随主题变化的 Logo。所有设置分类统一隐藏“打开配置文件”按钮。适配集中在企业客户端，保留第三方技能管理的原生创建、导入和回收站能力。

### 会话删除与配置页（rc3 gy.ent.6）

会话操作菜单新增带二次确认的永久删除；普通和已归档会话均支持，运行中或存在关联依赖时拒绝。仅清理该会话的日志及索引，保留工作目录文件、共享附件、平台审计和用量记录。高级设置统一中文分类并隐藏项目介绍/外链。实现、升级边界与验证见 `docs/dsh-0.2.1-session-deletion.md`。
