# 观因企业版双空间版本离线交付

控制台版本：`0.7.2-enterprise.6`，平台：`linux/amd64`（x86_64）。

## 镜像与空间选择

- 控制台：`guanyin/control-plane:0.7.2-enterprise.6-amd64`。
- 默认空间：`bankops/guanyin-enterprise-dsh:0.2.1-rc.3-gy.ent.7-amd64`，显示 `0.2.1-rc3`。
- 保留空间：`bankops/guanyin-enterprise-dsh:gy.ent.8-sync1-amd64`，显示 `0.1.5-rc2`。
- 数据库：`guanyin/postgres:17.6-alpine-amd64`。

两种空间均使用平台模型、MCP 管理及用量上报。包含无 API Key 模型兼容修正。
0.2.1 包含浏览器、技能、连接器查看、文件处理、中文与观因品牌适配。
浏览器、中文字体、Python 文件解析库和 Node 依赖均在镜像内，不需要离线节点在线安装。
外部模型或外部 MCP 地址仍须由部署方配置为离线网络内可达的服务。

审计只保留用户登录、每次提交的聊天文字和删除会话，保留一年。
不新增上下文、AI 回复或执行详情记录。删除会话不联动删除平台审计。
休眠空间可从入口唤醒，唤醒会重置空闲计时。

## 首次部署

1. 确认已有 amd64 Kubernetes 集群、StorageClass 和入口服务。本包是应用离线包，
   不包含 Kubernetes 安装器、CNI/CSI、Ingress 控制器或客户的模型权重。
2. 解压后校验 `SHA256SUMS`，在所有可调度节点执行 `import-images.sh images.tar.gz`。
3. 按 `部署说明.md` 创建数据库与初始管理员 Secret，设置实际域名和存储参数。
4. 应用 `kubernetes.yaml`。镜像使用 `IfNotPresent`，导入完成后无需访问外网仓库。
5. 使用已有签发系统生成的有效 License 激活；固定验签公钥不变。
6. 管理员配置模型与 MCP；创建空间时选择所需版本，等待运行中后进入。

## 升级与恢复

本包不含任何客户会话、数据库备份、API Key、密码、私钥或已激活的 License。
升级前备份现有数据库与空间 PVC，保留生产 Secret、域名、存储设置和固定公钥。
已有空间的镜像绑定保持不变；保留所有已有空间实际引用的旧镜像，不删除旧 PVC。
新增版本目录仅影响新建空间，不能把 0.1.5 的数据卷直接作为 0.2.1 数据卷复用。

本包附带 `image-list.txt`、`release.json`、`platform.txt` 和校验清单，
以这些文件为交付镜像、版本和平台的最终依据。
