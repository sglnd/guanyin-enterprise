# 平台自动维护空间基础网络

## 职责

控制面每 30 秒协调空间命名空间中的 guanyin-managed-space-egress NetworkPolicy，缺失则创建，spec 偏离则恢复。先确认策略存在，再向支持的空间注入代理环境并添加 guanyin.io/egress=managed 标签，避免先启动未保护的受管 Pod。新建 0.2.1 空间在创建 Pod 前完成同样准备。Service/Deployment 的原有身份选择器不依赖该标签。

策略仅允许：
- 空间 → 指定系统命名空间、app=guanyin-control-plane 的 Pod，控制面实际监听端口。
- 空间 → 指定网关命名空间、app=guanyin-mcp-gateway 的 Pod，8080/8081。
- 空间 → CoreDNS 标签及已识别的 DNS IP，TCP/UDP 53。

不依赖重建后变化的业务 Pod IP。DNS IP 默认从控制面 Pod 的 /etc/resolv.conf 获取，也可通过 DSH_DNS_IPS 指定逗号分隔 IP，支持 NodeLocal DNS。跨命名空间选择同时要求命名空间和应用标签匹配。

## 安装与启用

部署清单和 production/rbac-instance-manager.yaml 已增加仅空间命名空间内的 NetworkPolicy CRUD 权限。控制面镜像包含 egress-policy.mjs。部署默认不改变存量流量，安装管理员验证 CNI 和出口后统一启用：

```
DSH_EGRESS_MODE=proxy
DSH_NETWORK_POLICY_VERIFIED=true
GUANYIN_SYSTEM_NAMESPACE=guanyin-enterprise-system
```

默认 DSH_EGRESS_MODE=disabled，DSH_NETWORK_POLICY_VERIFIED=false。未确认 CNI 时不自动迁移，界面显示未确认，受管模式的新空间创建会被拒绝。这个部署确认是对实际请求测试的确认，不代表平台能够实时监测 CNI 数据面健康。普通空间用户不需要编辑 K8s 规则。

当前自动迁移支持已升级代理能力的 0.2.1 镜像。存量 0.1.5 不会被悄悄断网，界面提示需升级，不能宣称它已受到隔离。启用前应升级到 browser-network 镜像或包含 patch-browser-proxy.mjs 的同等版本。

其他 NetworkPolicy 的放行规则是并集；发现另一个匹配该 Pod 的出站允许策略时，控制面报告冲突，不自动删除管理员策略，不显示隔离确认。hostNetwork、hostPID、hostIPC、hostPath 或特权网络容器拒绝自动迁移。空间不挂载服务账号令牌，保留现有非特权配置。

## 应用出口

平台自动注入空间专属代理凭证引用，以及 HTTP_PROXY/HTTPS_PROXY、对应小写变量、NODE_USE_ENV_PROXY=1、Git 的 http.proxy 配置和 Chromium 显式代理。NO_PROXY 仅包含回环和必要的控制面/网关主机名，不绕过整个 .svc 域，其他内部业务服务也需经代理。

已经绑定且启用的平台模型地址由网关从 space_model_configs/model_providers 派生为该空间的自动代理授权，管理员不必重复填写模型地址。数据库变更通知和周期快照更新授权；人工配置的模型地址不会因此自动获准。Git HTTP/HTTPS 等额外目标使用“空间管理 → 网络访问”白名单。SSH Git、任意 TCP/UDP 出口不支持，会被阻断。

Node 客户端显式覆盖代理 dispatcher 的行为仍可能导致请求失败，但不能绕过网络层直连；其他不支持代理的客户端需适配。代理连接总时限目前为 120 秒，长时模型任务可能需要后续独立优化。

Node/Undici 会通过 CONNECT 请求 HTTP 目标。网关对此逐条解析 HTTP 请求并校验 Host，只允许获准 origin，拒绝嵌套 CONNECT、协议升级及目标 Host 切换。HTTPS 仍为 TLS 隧道，不解密。

## 状态与恢复

空间网络页显示协调状态和部署迁移状态；策略不存在、权限不足、冲突、版本不支持或 rollout 未完成时，不宣称已确认隔离。基础规则无需用户填写。

删策略到被重新创建之间存在协调间隔，不保证零窗口；这不替代限制集群管理员权限。停用协调开关不会自动删除已有策略或解除已有空间限制，避免停用过程中意外放开流量。回滚应先恢复所需访问路径，再由管理员有意移除 Pod 的受管标签或策略；保留正常服务身份标签和 PVC。

## 本地实际验证

已在 docker-desktop 的企业 0.2.1 空间启用，0.1.5 空间保留待升级状态。控制面 managed-egress-20261102-v4，网关 managed-egress-20261102-v2。

实际通过：DNS、控制面、MCP 网关；自动授权的临时模型 HTTP 请求和流式响应；Git HTTP clone；未批准代理目标拒绝；已批准业务目标的直接 IP 连接仍被 NetworkPolicy 阻断。手工删除基础策略后，控制面自动重建成功。

临时模型绑定、Git 服务及克隆目录已清理，空间休眠恢复原值。测试没有调用付费模型。当前空间没有绑定的模型，因此额外出站默认按已有网页白名单控制。

回归：控制面 62 项测试，58 通过、4 项需独立数据库而跳过；Go race 和 go vet 通过。涵盖策略创建顺序、重建、偏差恢复、权限失败不迁移、代理幂等、DNS/NodeLocal DNS、冲突检测、HTTP CONNECT Host 固定。
