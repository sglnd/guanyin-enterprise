# 0.2.1 Web 兼容性修复（2026-10-25）

修复镜像：`bankops/guanyin-enterprise-dsh:0.2.1-rc.2-gy.ent.2-arm64`。
本地 registry digest：`sha256:6f9793347e3e8223407695ada23db50a0edda6b06a2894e35258024e1649dbc6`。
控制平面：`host.docker.internal:5001/guanyin-control-plane:spaces-021-fix-20261025`。

## 问题与修改

社区版与企业版在相同 hostname 的不同端口运行时，旧版同名平台 Cookie 会相互覆盖。浏览器重载企业空间实际跳到登录页；预设 RPC 则将重定向后的登录页 HTML 当成 JSON，报 `Unexpected token '<'`。文件上传同样依赖登录状态。

企业版独立使用 `guanyin_ent_session`、`guanyin_ent_instance`；过滤转发到 DSH 的两套平台 Cookie。原来的登录不自动采用，升级后重新登录一次。未登录的 DSH `/api/*` 返回明确的 401 JSON，不重定向为 HTML。

原生 DSH 认证 Cookie 同样可能受其他空间/端口影响。新版代理在核验每空间签名身份后，按实际 Host 获取当前空间 Cookie，并用于普通 RPC、二进制上传及 WebSocket。缓存与 token、Host 关联，错误或过期后重新换取，未降低签名和原生接口鉴权。

设置数量减少有两种原因：新版原生界面承接了旧版主题、侧栏、文件引用、归档等插件功能；同时，企业隐藏插件管理页时，误使原生功能设置及 Context 偏好无可访问入口。本次新增“高级设置”，复用终端、Agent 循环、子智能体及上下文表单的原生保存协议，不开放插件安装。

对话“上下文”和首页“上下文洞察”属于同一个 dsh-context 插件：前者分析当前会话，后者汇总空间内多个会话。不会向模型重复注入内容。它们也不替代控制平面按用户、空间及租户保存的企业用量统计。

## 已验证

- 独立数据库测试：52 项通过，0 失败、0 跳过。
- 最终镜像全新容器、非 root、移除 capabilities 验证：错误浏览器 Cookie 下，Agent 预设正常、中文 DOCX 和 2MB 文件上传成功；无效签名仍返回 401，设置服务可写。
- 浏览器页面：四种 Agent 预设正常显示，无解析错误；高级设置的终端、Agent 循环、子智能体及上下文配置表单正常加载。
- 浏览器自动化、免 Key 模型及同请求两次调用的用户/Token 上报通过。
- 携带错误 Cookie 的已签名 WebSocket 握手通过。
- 本地控制平面实际对旧平台 Cookie 返回 401 JSON。

用户现有空间 `bf5d2a20-790d-4c1f-8008-930fbe917d21` 的 Deployment、持久化镜像记录和版本目录已更新；会话与 PVC 保留。0.1.5 镜像保留。用户选择稍后重新登录验证原空间，以上上传与页面检查使用独立合成测试数据，未使用客户 DOCX 或调用真实客户模型。

部署期间观察到本地 K8s 调度器与控制器因 lease 续约超时重启，随后 Docker Desktop 后端也重新启动，需以集群恢复后的 Pod 就绪状态判断本地是否可用。

集群恢复后，修复版原空间容器已达到 Ready，DSH 输出正常启动地址。观察到的 1 次容器重启发生在 Docker Desktop 后端重启期间。测试容器、测试数据库和模拟模型已停止。

## gy.ent.3：实际 Kubernetes 上传与终端修复

实际页面再次上传失败后，通过原空间保存合成文件，确认附件错误为 `EPERM: operation not permitted, chmod '/data/dsh'`。原数据 PVC 根目录为 root:root 0777，fsGroup 允许写入，却不能允许 uid 1000 修改目录权限。新建 0.2.1 空间增加 init container，仅将数据卷根目录设为 1000:1000、0700。现有测试空间同样补齐初始化，保留 PVC 和会话。

此外，复现浏览器带 `Accept-Encoding: gzip, deflate, br, zstd` 时 API 连接被上游中断、代理返回 `DSH upstream unavailable: socket hang up`。保持同一请求的其他头及正文，仅去掉压缩协商头即可成功。空间代理对 `/api/*` 的内部 HTTP 跳转设置 `Accept-Encoding: identity`，保留原有 Origin、Host 和身份校验。回归脚本补上浏览器压缩头与未读上传的错误响应检查。

终端镜像及入口设置 `LANG=C.UTF-8`、`LC_ALL=C.UTF-8`、`TERM=xterm-256color`，避免 Bash 在中文工作区提示符中显示 `M-...`。

### 最终验证（2026-10-25）

- 本地原 0.2.1 空间已更新 `0.2.1-rc.2-gy.ent.3-arm64`，镜像 digest `sha256:4c57ad28a3559af0c2fe2975767e0a477b210ed3949628ea278f72b0fbe783ac`。控制平面使用 `spaces-021-fix3-20261025`，版本目录与空间数据库记录均已更新。
- 实际浏览器上传合成 DOCX，显示 `DOCX 1.0KB` 且发送按钮可用；未发送给模型。截图 `dist/dsh021-validation/upload-terminal-ent3-fixed.png`。
- 同一页面新建 Bash 终端，中文路径 `~/测试工作` 及中文 printf 输出正常，`locale charmap` 为 `UTF-8`。
- 实际空间签名代理：携带 Chrome 压缩头和同源头的中文文件名 2MiB 上传返回 `ok:true`；不存在会话的早期上传拒绝返回完整 `ok:false` JSON，无连接重置。
- 控制平面测试 41 通过、4 项集成测试未配置数据库而跳过；语法及 `git diff --check` 通过。
