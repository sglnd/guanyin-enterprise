# 0.2.1 容器浏览器网络白名单

入口：平台管理员打开“空间管理 → 管理 → 网络访问”。每行一个完整地址，也支持空格、逗号、顿号分隔，例如：

```
https://oa.company.com:8443
http://192.168.10.20:8080
http://monitor.internal:3000
```

按协议、域名/IP、端口精确匹配；默认 HTTP 80、HTTPS 443。规则适用于该 origin 的所有路径，不支持路径级授权、通配符或 URL 内账号密码。页面跳转、接口和静态资源的其他 origin 需独立批准。空白规则拒绝所有通过代理的网页访问。只有平台管理员可修改，空间运行令牌不能修改规则。

规则存储在 PostgreSQL 的 space_network_policies，经 LISTEN/NOTIFY 和定期快照刷新到 Go 网关内存，不逐次查数据库，不使用 Redis。HTTP 正向代理及 HTTPS CONNECT 支持明确批准的私网地址和非标准端口。连接使用经过检查的 DNS 解析 IP；回环、链路本地、未指定和多播目标拒绝。代理身份头不会转发给 HTTP 上游；HTTPS 内容不解密。

保存会向空间注入 GUANYIN_BROWSER_PROXY_URL 并重启运行中的空间；休眠空间下次启动应用。0.2.1 镜像的 patch-browser-proxy.mjs 将代理 server/username/password 写入 0600 临时文件，通过 Playwright MCP --config 显式传入 Chromium，凭证不进入命令行。禁用 Chromium 隐式回环代理绕过。当前不支持 0.1.5 浏览器代理配置。

## 本地部署和验证

本地控制台：http://127.0.0.1:18081/console。

部署镜像：
- 控制面：host.docker.internal:5001/guanyin-control-plane:network-policy-20261102-v2
- 网关：host.docker.internal:5001/guanyin-mcp-gateway:network-policy-20261102
- 0.2.1 空间：host.docker.internal:5001/guanyin-enterprise-dsh:browser-network-20261102-v2

已验证：
- 页面接口能保存私网 HTTP/HTTPS 地址和自定义端口，拒绝带页面路径的规则。
- Go 代理集成测试通过：真实私网 HTTP、自定义端口 HTTPS、TLS 证书验证、跨空间拒绝、代理认证头不泄露、回环地址拒绝。
- 直接在 0.2.1 容器启动镜像预装 Chromium，读取运行中 provider 生成的代理配置：HTTP 8091 访问成功，HTTPS 8443 访问成功，未批准端口 8092 访问被拒绝。仅测试上下文接受临时自签名证书，未更改正式浏览器证书验证设置。
- 实际 HTTP 代理请求验证协议不匹配和端口不匹配均返回 403。
- 控制面 58 项测试：54 通过，4 个需独立数据库的测试跳过；Go race 检查、go vet、控制面语法检查通过。

测试地址已从空间规则中清除，测试 Pod/Service/ConfigMap 已删除，空间休眠恢复为 120 分钟。原始测试输出位于 Git 忽略的 tmp/network-validation/。

## 强制防绕过的边界

此功能控制容器 Chromium 的正常代理访问及其他携带空间身份的代理请求。**存量业务空间尚未自动启用全量 Pod 出站阻断**，也没有自动把模型、Git、依赖下载迁移到该代理；具备执行任意命令能力的用户仍可能直接发起网络请求。要强制禁止绕过，需要盘点并迁移所有必要出口后部署 NetworkPolicy。用户电脑上的网页 iframe 侧栏不受容器代理控制。

后续更新：本地 0.2.1 已启用平台自动维护的基础出站策略；先前“尚未启用”的描述为当时记录。当前范围、启用和回滚方法见 [受管出站网络](managed-egress.md)。
