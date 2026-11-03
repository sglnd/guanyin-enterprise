# MCP 网关 V1

现有 MCP 管理页面增加工具白名单、每空间每服务并发（默认 8）、每分钟请求数（默认 120，固定窗口）。空白工具列表默认拒绝所有工具；升级前登记的服务也默认拒绝，需要管理员显式填写白名单。空间绑定接口仅平台管理员、MCP 管理员可写。MCP 管理员和平台管理员可写空间授权；空间负责人、运维者只有查看权限。

控制面将空间配置的下游 URL/headers 替换为网关 URL/Bearer 令牌。空间令牌由独立用途 HMAC 从已有空间内部 Secret 派生，不是内部管理令牌本身；数据库只存 SHA-256。上游认证仍保存在既有 mcp_servers.headers，V1 沿用原存储格式，不声称已实现应用层加密；生产须限制数据库访问并配置存储加密。空间不能通过该调用令牌调用控制面管理接口。

## 运行

```sh
docker build -f mcp-gateway/Dockerfile -t guanyin/mcp-gateway:0.1.2 .
# 先升级控制面，让 initialize 建表；再部署网关。
kubectl apply -f deploy/mcp-gateway.yaml
```

控制面 MCP_GATEWAY_URL 默认指向企业命名空间内的网关 Service :8080，其他命名空间部署必须显式覆盖。默认单副本/Recreate：内存会话重启丢失，客户端必须重新初始化。不能直接调多副本；全局额度、会话路由尚未实现。

网关用 PostgreSQL LISTEN/NOTIFY 刷新整份只读一致性快照，5 秒定期核对，刷新超时 5 秒。通知非持久，定时刷新补偿；快照超过 30 秒拒绝新请求，/readyz 返回 503。配置保存不代表网关已确认生效，V1 界面尚不提供逐副本确认；正常变更通常通知后生效，数据库故障时以 30 秒快照期限作为拒绝上界。已转发的调用不回滚。

每次鉴权/授权只访问内存。数据库连接池只用于刷新和异步审计。审计队列 4096，100 条或每秒提交；写入失败、队列满会记录服务日志并丢失事件，V1 为尽力审计。调用记录页面显示最近 200 条；部署方需配置归档/清理 mcp_gateway_calls，避免无限增长。

协议范围：沿用 DSH Streamable HTTP 的 initialize、notifications/initialized、notifications/cancelled、ping、tools/list、tools/call，以及带所属会话的 GET/DELETE。支持 JSON/SSE 工具发现过滤和工具结果流式转发。对 server/discover 返回 HTTP 400 + JSON-RPC -32601，支持新版双协议客户端自动回退到旧版握手；不宣称支持完整 2026-07-28 协议。拒绝批量 RPC、resources/prompts 等未实现方法；不是所有 MCP 功能的透明代理。不支持 stdio 启动。单请求 1MiB、工具列表 4MiB、调用总超时 120 秒、上游响应头超时 30 秒；不自动重试，不跟随下游重定向。会话按空间和服务隔离，有效期 24 小时、全局上限 10000。

## 强制网络出口

网关 :8081 提供带空间身份的 HTTP 正向代理和 HTTPS CONNECT。配置入口为“空间管理 → 网络访问”，只有平台管理员可保存；规则保存在 PostgreSQL 的 space_network_policies，通过通知和快照刷新生效，无 Redis。

每条规则填写完整 origin，例如 `http://192.168.10.20:8080`、`https://oa.company.com:8443`。精确匹配协议、域名/IP、端口，HTTP 默认 80，HTTPS 默认 443；不接受页面路径、通配符、账号密码。支持明确授权的内网地址；回环、链路本地、未指定和多播目标始终拒绝。DNS 解析后的实际连接绑定到已检查 IP，防止解析检查与连接地址不一致。

HTTP 转发会移除代理身份头，不自动跟随重定向；浏览器的后续跳转和子资源请求需独立匹配白名单。HTTPS 不解密，不做路径级授权；CONNECT 入口要求 TLS 握手，不作为任意明文 TCP 隧道。每空间代理并发 8、每分钟 120、连接最长 120 秒。

0.2.1 镜像增加显式 Playwright Chromium 代理配置（patch-browser-proxy.mjs），从 GUANYIN_BROWSER_PROXY_URL 读取空间身份，将代理配置写入模式 0600 的 /tmp 文件并通过 Playwright MCP 的 --config 参数传入；不把凭证放到命令行。保存网络设置会注入该环境变量并重启运行中的空间，休眠空间下次启动生效；存量空间需升级镜像后保存一次。当前不支持 0.1.5 浏览器代理配置。

HTTP_PROXY/HTTPS_PROXY 是否被其他客户端采用仍取决于客户端实现；只有 Pod 网络策略才能强制阻止绕过代理。未对业务空间自动应用全量出站限制，避免中断尚未迁移的模型、Git 和依赖下载。用户电脑上的网页 iframe 侧栏不属于容器浏览器，不受该代理控制。

上线顺序：
1. 确认 CNI 真正实现 NetworkPolicy（仅创建资源无效）；当前本地集群可见 kindnet，不能据此认为已有策略执行能力。
2. 部署网关，填写 MCP 工具白名单，核对控制面重同步后的空间 MCP 地址不再包含下游凭证。
3. 盘点模型、Git、依赖下载、文件服务等所需地址，配置出站代理或另行批准内部目标；验证真实调用。
4. 在测试空间验证 deploy/mcp-egress-policy.yaml 后推广。该清单默认阻断其他出口，必须按实际 DNS（包括 NodeLocal DNS）和内部服务调整。清理其他宽泛 allow 策略，策略之间是并集。
5. 验证允许连接成功、直连域名/IP 失败、换端口失败、无令牌/错令牌/跨空间会话/未授权工具失败、撤权后新调用失败。

不要在未完成模型迁移与 CNI 验证时直接应用全命名空间策略。Pod 不得有 hostNetwork、特权、NET_ADMIN 或修改集群策略的权限。网络策略不阻止纯本地工具和进程执行。下游若还需阻止其他平台直连，应单独限制其入站只允许网关。

## 验证

```sh
cd mcp-gateway
go test -race ./...
go vet ./...
```

本地部署与实际验证结果见 [本地验证记录](mcp-gateway-local-validation.md)。
