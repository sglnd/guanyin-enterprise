# 观因企业版知识库集成

同步来源为社区提交 9e9b7bc（知识库与 pgvector）。功能包括文件及文本导入、隔离解析、Wiki 整理与审核发布、文档版本、知识库授权与空间绑定、向量检索及原文引用工具。

知识库通过 KNOWLEDGE_ENABLED=true 显式开启。企业 License、强制改密、平台管理员、知识管理员及空间成员授权均在控制面执行。知识库内部 MCP 入口也经过企业 License 检查。模型沿用企业模型管理和每个提供方的认证模式，密钥从空间命名空间的 Secret 读取。

页面使用企业版现有 accent、surface、paper、ink 等颜色变量。观因品牌、登录与空间管理布局沿用企业版样式。

部署参考本目录 pgvector-deployment.md 与 deploy/knowledge 下的企业命名空间清单。需要 PostgreSQL 17 对应 pgvector 扩展、知识文件 PVC、控制面和后台 worker。默认开关关闭，源码同步不会自动迁移运行数据库。升级前备份数据库与持久卷，先在测试环境验证后启用。构建升级包时设置 GUANYIN_RELEASE，并使用 deploy/knowledge/build-pgvector-package.sh。

外部 worker 使用 guanyin-enterprise-instances 命名空间读取企业模型凭据。文档与向量默认保存在平台数据库和独立文件 PVC，不跨空间自动授权。
