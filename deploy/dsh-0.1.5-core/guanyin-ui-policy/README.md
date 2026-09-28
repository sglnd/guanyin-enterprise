# Guanyin DSH UI Policy

这个目录是观因对 DSH 界面适配的唯一维护入口。后续升级 DSH、替换插件或继续做品牌改造时，先在这里修改和验证，避免把 UI 规则散落到镜像脚本和控制平面中。

## 文件职责

- `lib/client.js`：运行时界面规则，包括观因品牌、统一顶栏、登录人信息，以及隐藏 Codex UI 扩展管理、专家、技能、插件、连接器、IM 助理、配套管理模块和外部操作入口。
- `build-policy.json`：构建期界面发布规则。`hostOnlyPackages` 中的插件只加载 DSH 宿主能力，不向浏览器发布自己的管理页面。
- `cordis.patch.yml`：把 UI Policy 客户端加载到 Web profile。
- `package.json`：UI Policy 插件声明。

## 当前策略

1. MCP 由观因平台统一管理。`@js2hou/dsh-mcp-manager` 保留宿主 RPC 和 HMR 能力，但不发布“设置 → MCP”页面。
2. Codex UI 不显示扩展管理及其专家、技能、插件、连接器和 IM 助理入口。
3. 插件设置页不显示 GitHub、npm、问题反馈和检查更新等外部操作。
4. 品牌文案、Logo、浏览器图标等后续 DSH 侧改造也应加入本目录，不直接散写到 `Dockerfile` 或控制平面。
5. 登录身份从同源 `/__guanyin/identity` 读取。该接口只接受控制平面用空间密钥签发的短期身份，不读取或暴露观因登录 Cookie。

## 适配新 DSH 版本

1. 检查 `lib/client.js` 使用的选择器和文案是否仍然有效。
2. 检查 `build-policy.json` 中的宿主插件是否仍提供相同 RPC。
3. 重新打包 `@guanyin/dsh-ui-policy`，构建 DSH 镜像。
4. 验证被隐藏入口不存在，同时确认宿主能力仍可调用。
