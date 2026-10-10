# 观因企业版（Guanyin Enterprise）

观因是一个面向内部团队的 DSH 多租户控制平面。它负责用户、租户、共享空间、访问关系、生命周期和审计管理；DSH 本身作为独立版本化镜像运行，不在本仓库构建。

本仓库基于社区版 `guanyin-platform`，增加离线企业 License 登录门禁。未配置、无效或过期的 License 只能访问授权更新页面，不能登录或调用平台、工作空间及 OpenAPI 能力。

## 企业 License

1. 使用内部 `sglnd/guanyin-license-issuer` 生成 Ed25519 密钥对并离线签发客户 License。
2. 将签发公钥配置到 Kubernetes ConfigMap 的 `licensePublicKey`，私钥不得进入本仓库、镜像或客户集群。
3. 部署后打开登录页，填写与签发时完全一致的客户名称并粘贴 License。
4. 校验通过后显示原登录表单；授权配置保存在 PostgreSQL，Pod 重启后仍然有效。

更换或续期时，License 失效后登录页会自动重新显示授权更新表单。

## 与社区版本地并行部署

企业版本地清单使用独立资源，不复用社区版的数据库、PVC 或工作空间：

| 版本 | 控制面命名空间 | 工作空间命名空间 | 本地端口 |
| --- | --- | --- | --- |
| 社区版 | `guanyin-system` | `guanyin-instances` | `18080` |
| 企业版 | `guanyin-enterprise-system` | `guanyin-enterprise-instances` | `18081` |

企业版访问地址为 `http://127.0.0.1:18081`。首次部署使用全新的 PostgreSQL 和 PVC，需要重新录入 License、创建用户及空间。

## 企业版 DSH 镜像

企业版使用独立的工作空间镜像 `bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-arm64`。它从社区 DSH 镜像派生，不覆盖社区镜像，并强制覆盖为观因 UI，同时针对私有化环境移除 DeepSeek 官方模型引导、官方 DeepSeek 提供方入口和 DeepSeek 网页搜索提供方。

```bash
docker build -f deploy/dsh-enterprise/Dockerfile \
  -t bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-arm64 .
```

## 项目边界

- 本仓库：观因控制平面、Web 控制台、PostgreSQL 数据模型和 Kubernetes 部署。
- DSH 仓库：构建和发布 `bankops/deepseek-harness-agent` 镜像。
- 一个 DSH 空间对应一个 Deployment、Service、Secret 和三块持久卷，分别保存 DSH 数据、用户主目录和工作区文件。
- 用户与空间是多对多关系，成员角色分为负责人、运维者和成员。
- 空间可独立配置永不休眠或空闲一段时间后缩容到 0。
- MCP 管理员可登记 Streamable HTTP MCP；平台管理员、空间负责人和运维者可将已启用 MCP 接入空间，控制面以 ConfigMap/Secret 注入 DSH 并刷新对应空间。

## 目录

```text
control-plane/       Node.js 控制面、网关和 Web 控制台
deploy/              Kubernetes 本地参考部署
assets/branding/     观因品牌和 Logo 资源
docs/                生产就绪与运维文档
```

## 本地构建与部署

当前本机示例使用企业版控制面 `0.7.2-enterprise.2` 和 ARM64 工作空间镜像 `bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-arm64`。

```bash
docker build -f control-plane/Dockerfile -t guanyin/control-plane:0.7.2-enterprise.2 .
docker save guanyin/control-plane:0.7.2-enterprise.2 |
  docker exec -i desktop-control-plane ctr -n k8s.io images import -
docker save bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-arm64 |
  docker exec -i desktop-control-plane ctr -n k8s.io images import -

kubectl apply -f deploy/kubernetes.yaml
kubectl -n guanyin-enterprise-system rollout status statefulset/guanyin-enterprise-postgres
kubectl -n guanyin-enterprise-system rollout status deployment/guanyin-enterprise-control-plane
```

默认通过 `http://127.0.0.1:18081` 访问。manifest 中的数据库口令和管理员初始口令仅供本地开发，不能直接用于生产。

## 检查

```bash
cd control-plane
npm ci
npm run check
node --check store.mjs
node --check public/app.js
```

## 生产部署

当前 Kubernetes manifest 是本地参考环境。详细的本地运行说明见 [本地部署与功能边界](docs/local-deployment.md)。生产部署前需要配置私有镜像仓库、TLS、外部 Secret、CSI 存储、NetworkPolicy、集群外备份、监控告警和恢复演练，详见 [生产就绪清单](docs/production-readiness.md)。
