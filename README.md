# 观因（Guanyin Platform）

观因是一个面向内部团队的 DSH 多租户控制平面。它负责用户、租户、共享空间、访问关系、生命周期和审计管理；DSH 本身作为独立版本化镜像运行，不在本仓库构建。

## 项目边界

- 本仓库：观因控制平面、Web 控制台、PostgreSQL 数据模型和 Kubernetes 部署。
- DSH 仓库：构建和发布 `bankops/deepseek-harness-agent` 镜像。
- 一个 DSH 空间对应一个 Deployment、Service、Secret 和两块持久卷。
- 用户与空间是多对多关系，成员角色分为负责人、运维者和成员。
- 空间可独立配置永不休眠或空闲一段时间后缩容到 0。

## 目录

```text
control-plane/       Node.js 控制面、网关和 Web 控制台
deploy/              Kubernetes 本地参考部署
assets/branding/     观因品牌和 Logo 资源
docs/                生产就绪与运维文档
```

## 本地构建与部署

当前本机示例使用 ARM64 DSH 镜像 `bankops/deepseek-harness-agent:0.2.9-arm64`。

```bash
docker build -f control-plane/Dockerfile -t guanyin/control-plane:0.5.4 .
docker save guanyin/control-plane:0.5.4 |
  docker exec -i desktop-control-plane ctr -n k8s.io images import -
docker save bankops/deepseek-harness-agent:0.2.9-arm64 |
  docker exec -i desktop-control-plane ctr -n k8s.io images import -

kubectl apply -f deploy/kubernetes.yaml
kubectl -n guanyin-system rollout status statefulset/guanyin-postgres
kubectl -n guanyin-system rollout status deployment/guanyin-control-plane
```

默认通过 `http://127.0.0.1:18080` 访问。manifest 中的数据库口令和管理员初始口令仅供本地开发，不能直接用于生产。

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
