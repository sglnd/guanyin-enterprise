# 观因生产就绪清单

## 适用规模与拓扑

本方案面向单套 200 人以内、同时在线实例数显著低于注册用户数的内部系统。推荐生产拓扑：

- 3 个 Kubernetes 节点，控制面 2 副本分散调度。
- 每个 DSH 实例一个 Pod，停机后缩容为 0，持久数据保留在 PVC。
- PostgreSQL 可在首版使用单实例，但必须配合异地备份和恢复演练；若要求数据库无单点，改用托管 PostgreSQL 或 PostgreSQL Operator。
- 入口使用生产 LoadBalancer/Ingress，公网或办公网只暴露 HTTPS，DSH Service 不对集群外暴露。

## 上线前必须完成

- [ ] 将 manifest 中的明文口令替换为 External Secrets/Sealed Secrets 或云 KMS 注入，并修改初始管理员口令。
- [ ] 从私有仓库按不可变 digest 拉取控制面和 DSH 镜像，生产不得使用 `imagePullPolicy: Never`。
- [ ] 配置可跨节点重挂载且有快照能力的 CSI StorageClass，按工作空间规模设置 PVC 容量和配额。
- [ ] 配置 HTTPS 证书、正式域名和 `DSH_TRUSTED_HOSTS`，确认 Cookie 只经 TLS 传输。
- [ ] 增加 NetworkPolicy：只允许网关访问 DSH Web 端口，只允许控制面访问 PostgreSQL，按需限制 DSH 出站。
- [ ] 把 PostgreSQL 备份复制到集群外的对象存储，加密并设置保留策略。当前同集群备份 PVC 不能覆盖集群级故障。
- [ ] 恢复演练通过：在空数据库中恢复最新备份，核对租户、用户、实例关系和登录。
- [ ] 接入监控告警：控制面 5xx/延迟、Pod 重启、PostgreSQL 容量/连接数、PVC 容量、备份失败、DSH 启动超时。
- [ ] 执行容量验证：按预期峰值同时唤醒 DSH，记录节点 CPU/内存/存储 IOPS 和 P95 启动时间。
- [ ] 执行故障演练：删除一个控制面 Pod、重启一个工作节点、中断 PostgreSQL，确认预期降级和恢复。

## 建议的验收指标

| 目标 | 首版建议 |
| --- | --- |
| 控制台可用性 | 单个控制面 Pod 失效时登录和管理 API 持续可用 |
| 数据 RPO | 不高于 24 小时；若不能接受，增加 WAL 归档/托管数据库 |
| 数据 RTO | 演练并固化在 2 小时内，再根据业务要求收紧 |
| 实例隔离 | 用户无法通过 API、HTTP 或 WebSocket 访问他人实例 |
| 停机保留 | Pod 数为 0，PVC 名称和 UID 不变，唤醒后工作空间数据完整 |
| 发布 | 控制面滚动发布期间至少 1 个副本可用，可回滚到上一镜像 digest |

## 上线决策

所有“上线前必须完成”项通过后，才可将环境标记为生产。本地 Kubernetes 验证只证明应用链路和资源模型可行，不代替存储、网络、备份、监控与故障演练的生产验收。
