# 观因本地部署与功能边界

企业版聚焦完整主流程：平台管理员创建租户和用户、给用户分配固定版本的 DSH 实例、用户登录后进入自己的实例。本机 ARM 环境的新空间默认使用镜像 `bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.4-arm64`，包含观因企业品牌、License、短期登录身份与平台模型下发；现有空间保持其创建时锁定的镜像版本，升级时需单独切换镜像。

该核心镜像包含 `dsh-better-sidebar 0.18.0`，不包含 Univer Office 和 Browser Use 插件，不开放 Univer 的 `9081` 端口；文档读取使用镜像内的 Python 文档解析运行时。

## 已实现

- PostgreSQL 持久化租户、用户、实例和会话，会话令牌仅保存 SHA-256 摘要。
- 控制面默认 2 副本，含健康检查、滚动更新、拓扑分散和 PDB。
- 每个 DSH 实例一个 Deployment、Service、Secret 和三个 PVC，用户与实例在网关层校验。
- 三块空间 PVC 的容量可分别通过 `DSH_DATA_PVC_SIZE`、`DSH_HOME_PVC_SIZE` 和 `DSH_WORKSPACE_PVC_SIZE` 配置，默认均为 2Gi，只影响新建空间。
- “我的工作空间”显示当前用户被授权访问的空间；平台管理员在独立的“空间管理”中管理全部空间、成员关系与休眠策略。
- 管理员代入他人工作空间前必须确认，后端为当前会话签发限时访问授权，并持久化记录代入、启动和停止审计日志。
- 用户可手动停止、唤醒实例；默认空闲 60 分钟缩容到 0，PVC 保留。
- PostgreSQL 每日备份到独立 PVC，本地保留 14 份。
- MCP 管理采用最小功能集：平台管理员或附加的 MCP 管理员登记服务，空间负责人/运维者管理空间接入；公开配置写入 ConfigMap，包含请求头的 DSH patch 写入 Secret，变更只刷新对应空间。

## 本地部署

```bash
docker build -f control-plane/Dockerfile -t guanyin/control-plane:0.7.2-enterprise.1 .
docker save guanyin/control-plane:0.7.2-enterprise.1 | docker exec -i desktop-control-plane ctr -n k8s.io images import -
docker save bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.4-arm64 | docker exec -i desktop-control-plane ctr -n k8s.io images import -
kubectl apply -f deploy/kubernetes.yaml
kubectl -n guanyin-enterprise-system rollout status statefulset/guanyin-enterprise-postgres
kubectl -n guanyin-enterprise-system rollout status deployment/guanyin-enterprise-control-plane
```

本地环境可通过 `LoadBalancer` Service 或端口转发访问 `http://127.0.0.1:18081`。首次启动的本地管理员为 `admin / Guanyin@2026`。这个口令和 manifest 中的数据库口令仅用于本地验证，严禁原样部署到生产。

Docker Desktop Kubernetes 使用独立的 containerd 镜像仓库，本机 Docker 中已存在的镜像仍需执行一次 `docker save | ctr images import`。当前本机 DSH 镜像为 ARM64，不经过 QEMU 模拟；生产应发布 amd64/arm64 多架构 manifest，由节点自动选择正确架构。

## 生产边界

当前 manifest 是可重复的本地参考环境，不是可原样上线的生产配置。正式上线前必须完成 [生产就绪清单](production-readiness.md)，尤其是 TLS、外部 Secret、私有镜像仓库、CSI 存储、异地备份和恢复演练。

第一版仍未提供 OIDC/MFA、密码找回、配额编辑、Skill 管理、MCP 探活和版本迁移。这些不影响小规模内部试运行，但需按业务的安全与运维要求纳入后续版本。

## 2026-10-09 本地 DSH 更新

本地测试版本为 `bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.4-arm64`，配置档为 `guanyin-enterprise-v4`。可从已构建的企业版 ent.3 运行时增量构建：

```bash
docker build --platform linux/arm64 -f deploy/dsh-0.1.5-core/Dockerfile.update -t bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.4-arm64 .
```

该更新包含模型同步接口、设置客户端修复、原生文件列表入口隐藏，并强制恢复观因 UI、继续保留企业版的 DeepSeek 官方入口与网页搜索隐藏策略。原生文件预览和 better-sidebar 保留。受管企业版 v1/v2/v3 配置档启动时升级为 v4；会话与工作目录不删除。非受管旧配置档仍需单独迁移，不会强行覆盖。

本地 ARM64 镜像用于本机测试；生产 AMD64 需要另行构建对应架构并完成验证。
