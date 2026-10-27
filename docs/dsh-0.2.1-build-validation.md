# 观因 0.2.1 双版本空间构建验证

验证日期：2026-10-25。本次新增空间镜像，不迁移或替换 0.1.5 空间。

## 构建产物

- 架构：linux/arm64。
- 标签：`bankops/guanyin-enterprise-dsh:0.2.1-rc.2-gy.ent.1-arm64`。
- 本地镜像 ID：`sha256:c3f6478a10dd92ecaad0f437ac24f7035cb51869894a74d209a343251c169c10`。
- 本地 registry manifest digest：`sha256:e599f1c28180952ed07ca7e10d185436d240b7ddc59d32f5b831d9e44de61564`。
- 控制平面：`host.docker.internal:5001/guanyin-control-plane:spaces-021-20261024`。

仅导入本机 registry，未发布 Docker Hub，未生成新的 AMD64 镜像或离线包。上游核心实际固定为 **0.2.1-rc.2**，不能把它表述为已验证的正式版 0.2.1。

## 已完成的适配

创建空间按版本目录选择镜像，并将镜像保存到空间记录。重启优先使用已保存的镜像，禁用某个版本的新建入口也不影响已有空间恢复。原有 `DSH_VERSION` 和 `DSH_IMAGE` 保留。

企业插件保留观因品牌、深浅主题 Logo、身份显示、平台返回入口、模型同步、受管 MCP 管理和用量上报。License 与固定公钥仍由平台验证和配置，本次不生成或替换密钥。

浏览器使用本地 Chromium 与 Playwright MCP。新版原生能力覆盖工作区/会话管理、归档、文件引用、文件预览、终端和定时任务；继续使用新版 GenUI 与 Context。官方账号登录、插件市场、官方日志上传和 DeepSeek 专属入口通过配置隐藏。

用量接收端兼容原有事件，新增请求 ID、来源及平台确定的空间版本。模型调用事件继续使用持久化队列、批量重试和去重；审计记录增加空间版本，保留一年策略。

## 验证证据

- 独立 PostgreSQL 数据库执行控制平面测试：51 项通过，0 失败、0 跳过。
- 最终镜像在全新持久卷、无源代码挂载、非 root、移除 capabilities 下冷启动通过。
- 容器重启后完整链路再次通过：模型同步、MCP 列表、原生工作区 `/workspace` 初始化、浏览器打开真实测试网页、模型无 Authorization、同一请求下两次模型调用准确上报用户和 Token。
- 重启验证请求：`05ad005e-af04-4a8b-b78e-005b82b9c3aa`；会话：`session-f8556200-d568-49bc-8215-b3e61e3e0fd7`。
- 终端 PTY 可执行；对旧版数据目录拒绝启动且不改写原有标记。
- 实际浏览器检查深浅主题 Logo、观因标题、Mermaid 和 GenUI。截图保存在 `dist/dsh021-validation/`。
- 本地控制平面两个副本完成滚动更新，健康检查通过；新版本目录使用 digest 固定镜像。
- K8s 直接从本地 registry 拉取该 digest，非 root、RuntimeDefault seccomp、移除 capabilities，使用与正式平台相同的回环地址探针，达到 `1/1 Ready`，0 次重启。首次拉取约 5 分 54 秒；节点缓存镜像后，重建验证 Pod 约 13 秒已就绪。临时验证 Pod 的初版 TCP 探针错误检查 Pod IP，已改为正式平台的容器内回环地址检查；正式平台探针无须修改。

首次重启测试与大镜像导入并行时发生启动/浏览器等待超时；导入结束后复测整条链路通过。集成脚本改用有界时间窗口，认证最多 120 秒，浏览器与用量最多 180 秒。

测试使用本地模拟 OpenAI completions 模型和测试网页。真实生产模型、复杂外部网站、其他模型协议及 AMD64 尚需各自验收，不能将本次验证扩大为全部协议兼容性保证。

构建及环境配置见 [镜像说明](../deploy/dsh-0.2.1/README.md)。代码尚未提交或推送 Git。

## 2026-10-25 实际新建空间的持久卷检查

用户新建 `0.2.1` 空间时，Pod 停在 Pending，三个 PVC 均未绑定。根因是本机 Docker Desktop 集群的存储辅助镜像 `kindest/local-path-helper:v20260131-7181c60a` 经 `registry-mirror:1273` 拉取返回 500，卷创建连续超时。此前 K8s 冒烟使用 emptyDir，没有覆盖动态 PVC 创建。

修复：拉取同版本 ARM64 helper，导入本地 registry；修改 `local-path-storage/local-path-config` 的 helperPod 镜像为 `host.docker.internal:5001/kindest/local-path-helper@sha256:6e75273baa8e2b3f1475d953e14680b497e9d73e614ce297025d8403c7b15331`，重新加载 provisioner。原配置备份在本机 `/tmp/guanyin-local-path-config-before.json`。此设置属于本机集群，不应直接用于其他部署环境。

实际空间 `dsh-0-2-1-43b9f4` 的三个 PVC 随后全部 Bound，Pod 达到 1/1 Running、0 次重启。未删除或重新创建用户空间、PVC，也未更换 DSH 镜像。因卷创建超过首次模型/MCP 初始化的等待期限，另外滚动更新控制平面以补跑其现有启动同步流程。
