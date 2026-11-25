# 知识库 pgvector 升级说明

此改造使用 PostgreSQL 17.6 + pgvector 0.8.7，不升级数据库主版本，不替换 PVC。控制台和 Worker 更新为同一镜像；DSH、MCP 网关无需为此改造重构镜像。现有普通生产包不能仅替换控制台后就启用知识库，必须先完成数据库扩展安装和迁移。

## 数据与检索

- `knowledge_chunks.embedding` 原 JSON 列保留，便于回滚核对；新增 `embedding_vector vector NOT NULL` 及生成列 `embedding_dims`。兼容触发器将新旧写入同步到 vector 列，不重复调用 embedding 模型。
- 初始化在事务及 schema 级 advisory lock 内执行；已有向量转成 float32，零向量、越界维度、非有限值等错误会使迁移回滚，不删除原文和旧索引。迁移前后的 JSON 值、记录数、发布版本应一致。
- 1～2000 维使用 cosine HNSW 部分表达式索引；2001～4000 维用单位化 halfvec HNSW 候选，再按原 float32 向量计算分数排序。4001～8192 维继续兼容，但只采用数据库内精确检索，没有 HNSW 加速，建议生产选择前两档。
- 索引按维度建立，BTREE 辅助按模型与维度过滤；查询同时约束授权库、模型、未删除文档和当前发布版本。启用 HNSW iterative scan，候选不足 8 条时在授权范围内精确补查；不会将向量下载到 Node.js 扫描。SQL 检索事务超时 15 秒。
- HNSW 是近似检索，不承诺与精确检索在任意数据上完全一致。共用维度索引的跨库过滤、旧版本比例及并发都会影响耗时/召回。生产需使用真实数据验证；大量租户或强过滤场景可后续分区。原“最多 2000 分块”限制已移除，不等于无限容量承诺。
- 模型身份相同但维度变化会明确报错；更换模型/服务版本仍需重新处理发布，不能只调整维度。
- 兼容 JSON 列暂时增加存储量。当前写入依赖该列，不可直接删除；应在回滚窗口结束后另做清理迁移。

## 构建与离线包

在仓库根目录执行，显式指定本次发布标识，生产 AMD64 示例：

```sh
GUANYIN_RELEASE=<正式发布标识> TARGET_PLATFORM=linux/amd64 \
  bash deploy/knowledge/build-pgvector-package.sh <输出目录>
```

该脚本完整构建控制台（含解析依赖）及数据库镜像，校验架构，导出两份镜像至 `images.tar.gz`，包含知识库 PVC、控制台挂载补丁、Worker、PostgreSQL 镜像补丁及 SHA256 清单。需要在离线环境部署前，于可联网构建环境完成。pgvector 源码版本和下载 SHA256 在 Dockerfile 固定。

若现有数据库为托管 PostgreSQL，应由数据库管理员提供 public schema 中的 pgvector >=0.8.0，无需替换托管数据库镜像。自建数据库镜像的 BASE_IMAGE 必须匹配现有 PostgreSQL 17.6 与 libc/目录布局；其他主版本不能直接挂载现有数据卷。

## 升级顺序

1. 确认部署命名空间、PostgreSQL 主版本、镜像架构、现有 PVC 和可用磁盘，校验升级包 SHA256，在实际运行节点导入镜像。记录原镜像和副本数。
2. 维护窗口暂停上传与任务。优雅停止知识 Worker，再停止控制台；保留数据库和全部 PVC。备份完整 PostgreSQL（推荐 custom format pg_dump）、知识原文 PVC、模型 Secret 和部署配置。确认备份可恢复。
3. PostgreSQL StatefulSet **只修改镜像**为带扩展的同版本镜像，保留所有存储与环境配置，等待数据库就绪。无需重新初始化数据库。
4. 以数据库管理员在原平台数据库执行 `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;`。核对 `pg_extension` 中 vector 的版本及 schema。
5. 使用新控制台镜像执行 `node knowledge-vector-migrate.mjs`（DATABASE_URL 指向原库），以单个维护 Pod/Job 串行执行。`--install-extension` 可选，会尝试安装扩展，要求管理员权限；普通应用账号不应被默认提权。迁移输出 JSON 记录数和索引名称，不输出原文/密钥。
6. 首次启用知识库须先准备 `knowledge/pvc.yaml`，按实际 StorageClass/容量调整，再合并 `knowledge/control-plane.patch.yaml`。已有知识库挂载保持不变。控制台与 Worker 的 DATABASE_URL 必须相同。
7. 更新控制台为新镜像并启动，待就绪后再启动同镜像的 Worker。知识库开启条件：`KNOWLEDGE_ENABLED=true`、`KNOWLEDGE_WORKER_MODE=external`、`KNOWLEDGE_ROOT=/data/knowledge`。Worker 需能读取模型 Secret；非默认空间命名空间须设置 `DSH_NAMESPACE`。
8. 核对旧文档/发布版本/授权未变，进行真实检索、新上传审核发布、权限隔离、撤权、跨模型维度检查，并观察数据库 CPU/IO、查询耗时、索引大小与召回。

生产原模板控制台为 2 副本、RollingUpdate；知识卷为 RWO，Worker 依赖控制台同节点。该组合不是已验证的跨节点 HA 配置。首次小规模上线应调整为单控制台、单 Worker、Recreate 并安排停机；保留多副本需先完成共享存储适配及多节点发布验证，不能直接套用验证配置。初始化虽然串行加锁，首次大表回填/索引构建仍应先由独立迁移完成，避免多实例同时启动等待。

索引自动创建使用普通 CREATE INDEX，首次迁移和首次引入新维度可能持锁影响写入，应放在低峰或维护窗口；后续大规模表可改独立维护流程并使用 CONCURRENTLY。不要在生产直接执行本地 ARM64 标签或整套旧版 kubernetes.yaml 覆盖现有部署。

## 回滚

优先回退控制台和 Worker 镜像；必要时关闭知识库功能。保留扩展、vector 列、同步触发器和知识 PVC，旧 JSON 数据继续存在。**有 vector 类型数据时，不得直接回退到不带 pgvector 的数据库镜像，也不要 DROP EXTENSION CASCADE。** 若必须恢复升级前数据库，应停止写入，使用备份完整恢复到独立实例验证，再安排切换；恢复快照会丢失快照后的写入。

参考：[pgvector 官方说明](https://github.com/pgvector/pgvector)，包括向量类型、维度限制、HNSW、过滤与 iterative scan。
