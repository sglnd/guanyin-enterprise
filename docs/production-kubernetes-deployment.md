# 观因 0.7.0 三节点 Kubernetes 离线部署

## 1. 交付内容与架构要求

运行时仅需要三张镜像：

- `guanyin/control-plane:0.7.0-amd64`
- `bankops/guanyin-dsh:0.1.5-rc.2-gy.1-amd64`
- `guanyin/postgres:17.6-alpine-amd64`

`image-list.txt` 和 `platform.txt` 记录交付包的实际镜像名称、镜像 ID 与 CPU 架构。每个离线包只能部署到 `platform.txt` 所列架构的节点。先在生产集群执行：

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture,RUNTIME:.status.nodeInfo.containerRuntime
```

三个节点的 `ARCH` 必须与 `platform.txt` 一致。架构不匹配时必须换用对应架构的完整交付包，不能通过修改镜像标签混用。

仓库的导出脚本支持通过 `CONTROL_PLANE_IMAGE`、`DSH_IMAGE` 和 `POSTGRES_IMAGE` 生成不同架构的独立交付包，并会同步改写包内 Kubernetes 清单中的镜像引用。
默认不带参数执行时只生成 amd64 交付目录；只有明确设置三张 ARM64 镜像时才会导出 ARM64 包。

## 2. 存储前置检查

本方案使用 PVC。部署前确认集群存在默认 StorageClass，支持 `ReadWriteOnce` 卷在 Pod 被重新调度后挂载到新节点：

```bash
kubectl get storageclass
kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'
```

如果没有默认 StorageClass，在 `kubernetes.yaml` 的 `guanyin-production-config` 中填写 `dshStorageClass`，并给 PostgreSQL 与备份 PVC 的 `spec.storageClassName` 填写同一 CSI StorageClass。不要使用仅绑定单节点、节点损坏后无法重挂载的本地盘方案。

每个空间会动态创建三个 PVC：`data` 保存 DSH 配置与会话，`home` 保存用户主目录，`workspace` 保存工作区文件。容量通过生产 ConfigMap 中的 `dshDataPvcSize`、`dshHomePvcSize` 和 `dshWorkspacePvcSize` 分别设置；只接受 `Mi`、`Gi` 或 `Ti` 的正整数容量，例如 `512Mi`、`5Gi`、`1Ti`。

## 3. 校验并导入离线镜像

在交付目录校验文件：

```bash
shasum -a 256 -c SHA256SUMS
cat platform.txt
cat image-list.txt
```

将整个交付目录复制到三个节点。在每个 containerd 节点分别执行：

```bash
CONTAINER_RUNTIME=containerd ./import-images.sh images.tar.gz
sudo ctr -n k8s.io images ls | grep -E 'guanyin|postgres:17.6-alpine'
```

若节点运行 Docker，使用 `CONTAINER_RUNTIME=docker`。镜像必须导入所有可能调度控制面或 DSH Pod 的节点，否则 Pod 会出现 `ImagePullBackOff`。

## 4. 创建生产 Secret

不要把密码写入 YAML 或 Git。以下命令只在管理员终端执行；数据库密码和初始管理员密码应使用密码管理器生成并保存：

```bash
kubectl create namespace guanyin-system --dry-run=client -o yaml | kubectl apply -f -

read -s -p '初始管理员密码: ' ADMIN_PASSWORD; echo
DB_PASSWORD="$(openssl rand -hex 32)"
DB_URL="postgres://guanyin:${DB_PASSWORD}@guanyin-postgres:5432/guanyin"

kubectl -n guanyin-system create secret generic guanyin-database \
  --from-literal=username=guanyin \
  --from-literal=password="$DB_PASSWORD" \
  --from-literal=database=guanyin \
  --from-literal=url="$DB_URL" \
  --from-literal=bootstrapAdminPassword="$ADMIN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
unset DB_PASSWORD ADMIN_PASSWORD DB_URL
```

生产中优先改用 External Secrets、Sealed Secrets 或企业 KMS。

## 5. 修改配置并部署

编辑 `kubernetes.yaml`：

1. 将 `licensePublicKey` 替换为内部签发系统生成的 Ed25519 公钥。不要把私钥或客户 License 写入 YAML。
2. 把 `trustedHosts` 改成真实域名，例如 `guanyin.example.com`；多个域名用英文逗号分隔。
3. 确认 DSH 镜像标签与节点架构一致。
4. 按存储规划设置 `dshStorageClass` 和三个 DSH PVC 容量参数。配置只影响新建空间；已有 PVC 不会自动调整。
5. 如果使用私有镜像仓库，将三处镜像名改成仓库地址，并配置 `imagePullSecrets`。

执行：

```bash
kubectl apply --dry-run=server -f kubernetes.yaml
kubectl apply -f kubernetes.yaml
kubectl -n guanyin-system rollout status statefulset/guanyin-postgres --timeout=5m
kubectl -n guanyin-system rollout status deployment/guanyin-control-plane --timeout=5m
kubectl get pods,pvc -n guanyin-system -o wide
```

生产清单默认将控制面暴露为 `ClusterIP:8080`。请通过现有 Ingress/Gateway 接入 HTTPS，并将后端指向 `guanyin-system/guanyin-control-plane:8080`。TLS 应在入口终止，且外部只能访问控制面，不能直接暴露 `guanyin-instances` 中的 DSH Service。

## 6. 验收

```bash
kubectl -n guanyin-system get deployment guanyin-control-plane
kubectl -n guanyin-system get statefulset guanyin-postgres
kubectl -n guanyin-system get pdb guanyin-control-plane
kubectl auth can-i create deployments.apps \
  --as=system:serviceaccount:guanyin-system:guanyin-control-plane \
  -n guanyin-instances
```

浏览器通过正式 HTTPS 域名登录，立即修改/妥善保管管理员凭证，然后创建一个测试空间。验收以下项目：

- 首次访问先显示企业授权页；错误客户名称、篡改或过期 License 均不能进入账号登录。
- 有效 License 审核通过后显示账号登录，刷新或重启控制面后授权仍然有效。

- 空间 Pod 进入 `Running/Ready`，并创建三个 PVC。
- 普通用户只能进入已授权空间，管理员代入访问有审计记录。
- 停止空间后 Deployment 缩容到 0，PVC 保留；再次启动后数据仍在。
- 删除任一控制面 Pod，登录和控制台仍可用。
- PostgreSQL 备份 CronJob 能生成 dump，并完成一次恢复演练。

## 7. 升级与回滚

升级时先备份数据库，再在三个节点导入新镜像，修改清单镜像标签后滚动更新控制面。DSH 空间在创建时记录镜像版本，已有空间不会自动迁移。

```bash
kubectl -n guanyin-system create job --from=cronjob/guanyin-postgres-backup guanyin-backup-before-upgrade
kubectl -n guanyin-system rollout status deployment/guanyin-control-plane
```

控制面回滚：

```bash
kubectl -n guanyin-system rollout history deployment/guanyin-control-plane
kubectl -n guanyin-system rollout undo deployment/guanyin-control-plane
```

同集群备份 PVC 不能覆盖集群级故障，必须再同步到集群外对象存储。正式上线还应完成 TLS、NetworkPolicy、监控告警、容量测试和恢复演练，详见项目中的 `docs/production-readiness.md`。
