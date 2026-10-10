# 空间删除与管理列表分页

## 删除空间

仅平台管理员可在“空间管理”的空间卡片的“管理”弹窗底部删除空间。弹窗列明影响范围，必须输入完整空间名称确认。

删除行为：

- 撤销空间访问，清理 Deployment、Service、内部管理 Secret 和 MCP ConfigMap。
- **保留 data、home、workspace 三个 PVC**，不对 PVC 发出 DELETE 请求。
- 下线关联 API，停用关联 API 凭证；保留审计记录、API 执行历史和空间历史记录。
- 空间处于创建、启动或停止过程中，或仍有排队/执行中的 API 任务时，拒绝删除。
- 清理失败时保留“删除中”记录，可以在管理页面重试；重复清理会忽略已经不存在的 Kubernetes 资源。
- 完成删除后，空间从用户列表和管理列表消失。保留 PVC 不代表平台提供一键恢复；PVC 的后续清理由存储管理员另行处理。

接口：

```http
DELETE /api/admin/instances/{id}
Content-Type: application/json

{"confirmName":"空间完整名称","deleteData":false}
```

接口拒绝 `deleteData: true`，当前功能不提供永久删除 PVC 的选项。

## 分页查询

“空间管理”默认每页 20 个空间，可选 50/100；“用户与租户”默认每页 20 个用户，可选 10/50/100。搜索或筛选变化时回到第一页，结果减少后自动收敛到有效页码。页脚显示筛选后的总条数。空间顶部统计仍显示所有未删除空间的汇总。

```http
GET /api/admin/instances?page=1&pageSize=20&q=运维&status=all
GET /api/admin/users?page=1&pageSize=20&q=张&tenantId=all&role=member&status=true
```

- 两个接口均仅平台管理员可访问。
- 空间搜索匹配名称、租户、核心版本，以及成员姓名/用户名；状态支持 running/stopped/error/starting/provisioning/stopping/deleting/all。
- 用户搜索匹配姓名、用户名和租户；角色支持 platform_admin/tenant_admin/member/all；状态支持 true/false/all。
- `page` 是正整数；`pageSize` 为 1–100；查询条件使用参数化 SQL，搜索中的 `%`、`_` 按字面匹配。
- 返回结构包含 `page`、`pageSize`、`total`，以及 `instances` 或 `users`。空间接口另含全局 `summary`。
- 管理页请求 `/api/admin/overview?metadataOnly=true`，获取统计和租户元数据，避免先下载全部用户。空间成员候选只在打开空间管理时按该租户分页读取。
- 空间运行状态按当前页刷新；未访问页的状态沿用数据库最近一次记录。

## 更新注意事项

这次仅修改控制面，不需要更新 DSH 镜像。

1. 更新控制面前，应用仓库部署清单中的 `guanyin-instance-manager` Role 变更，增加 Deployment、Service、Secret、ConfigMap 的删除权限。PVC 权限不包含 delete。
2. 不要为了更新 Role 而覆盖生产的 Gateway、trustedHosts 或存储定制配置。
3. 控制面启动时自动增加 `instances.deleted_at` 和分页索引，兼容现有记录。不存在删除历史空间或 PVC 的启动迁移。
4. 更新后刷新浏览器加载新的管理页面。

## 验证

```sh
cd control-plane
npm run check
npm test
# 仅对隔离的临时测试数据库执行：
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/test_db npm test
```

数据库集成测试创建自己的测试租户、空间、用户和接口记录；不要把生产数据库作为 TEST_DATABASE_URL。

## 用户与租户管理

- 用户编辑弹窗底部提供删除操作，需输入完整用户名确认。平台管理员不可删除；仍为空间负责人的用户需先移交负责人或删除空间。
- 删除用户会撤销登录会话、空间成员授权，停用该用户创建的接口凭证。空间、PVC、审计及接口历史保留。用户从列表和候选项隐藏；历史用户名不释放。
- 租户列表的“管理”可修改名称与编码；修改不会迁移用户或空间。默认租户编码固定，名称可修改，重启不会覆盖修改。
- 租户管理弹窗底部提供删除，需输入完整租户名称。仍有用户或未删除空间（包括删除中）时拒绝删除；默认租户不可删除。已删除用户和空间的历史记录不阻止删除租户，租户编码保留。
- 用户和租户采用逻辑删除，保留外键及审计历史。控制面自动增加 `users.deleted_at`、`tenants.deleted_at`，不清理 PVC。
- 所有修改和删除接口仅平台管理员可访问，并记录审计。

```http
DELETE /api/admin/users/{id}
{"confirmName":"完整用户名"}

PATCH /api/admin/tenants/{id}
{"name":"租户名称","code":"tenant-code"}

DELETE /api/admin/tenants/{id}
{"confirmName":"完整租户名称"}
```

空间成员分配支持按用户名、姓名搜索，服务端分页，每页 20 位；仅查询当前空间租户的启用用户，排除平台管理员。查询和翻页会清空用户选择，避免误操作；已有成员仍可选中后更新角色。
