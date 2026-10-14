# Agent Note: 家庭独立 Judge 节点接入生产主站

Status: implemented

## Problem

生产主站与家庭评测机位于不同网络。主站内网地址依赖开发电脑的
VPN，不能作为长期运行的 Judge 连接地址；现有题目包预签名 URL 使用主站 Docker
内部的 `minio` 主机名。 仅启动 Worker
无法证明队列消费、支持包下载和成绩回传链路可用。

## Decision

- 前后端、数据库、Redis、对象存储和 LLM Gateway 保留在主站。家庭节点运行与主站
  评测协议一致的 `v0.10.5` Worker，启用 AI 和 WASM 资源池。
- 通过网站 HTTPS 路径 `/judge-tunnel/` 建立 Chisel 加密通道，客户端同时验证 TLS
  证书和固定服务端指纹。专用账号仅允许连接 Redis、MinIO、LLM Gateway
  三个固定目标。 主站服务监听回环地址，节点侧监听回环与专用 Docker
  管理网桥；Redis 不开放到公网或家庭
  LAN。认证信息和私钥由服务器受限文件管理，不进入仓库。
- Worker 的编排容器使用主机 Docker，但只挂载专用 rootless Docker socket
  与评测缓存。 选手程序和 Evaluator 在独立普通账号的 rootless daemon
  中执行。主站应用 daemon 的 socket 不传入 Worker 或评测沙箱。
- 管理网络与评测网络分离。Worker 通过管理网络访问队列与对象存储，`minio`
  主机名映射到 本地固定转发端点，保留原预签名 URL 的 Host 与签名语义。rootless
  评测网络的 LLM 转发器仅接受健康检查与模型调用路径，保持客户端断开传播和
  `Retry-After`。
- 节点固定独立资源组，AI 并发为 2，WASM 活跃提交为 4、编译为 2、运行槽为
  8，调度内存 预算为 8192 MiB。Worker 使用非 root
  UID、只读根文件系统、能力清空、禁止提权及有限 日志轮转，评测缓存容量为 2048
  MiB。
- 保留 `noj-cli judge check` 作为配置、socket、Redis
  与架构检查入口。节点附加的管理 网络、DNS 映射与优雅关闭窗口通过 Compose
  覆盖文件保存；实际启停使用 `noj-judge-worker.service`，防止直接使用基础
  Compose 时丢失覆盖配置。
- rootless daemon 的账号启用 linger，隧道、Worker 和恢复 timer 均启用开机自启。
  运行时预热后移除开发电脑的 Docker 下载代理，评测链路不依赖开发电脑在线。
- `v0.10.5` 的长期队列连接在网络恢复后可能继续报错。节点恢复 timer
  仅在观察到至少 3 条 Worker 自身的队列错误、上游 Redis
  已恢复且本资源组没有活跃评测时执行优雅重启。
  恢复节流文件仅属于该节点的运维进程，不承载业务状态或跨副本协调；成绩、租约与资源池
  共享状态继续保存在主站 Redis/数据库中。

## Alternatives considered

- 通过开发电脑 VPN
  或转发接入：电脑休眠、代理关闭或网络切换会影响评测，不作为生产链路。
- 将 Redis、MinIO 或 Docker API 映射到公网：扩大基础设施暴露范围，不采用。
- 为跨节点下载修改全站 S3
  地址：会影响现有节点，采用本地解析与固定转发保留签名语义。
- 把主站的 Docker socket 共享给新节点或沙箱：破坏评测与应用的权限边界，不采用。
- 使用 Worker
  进程存活或端口开放作为验收：不能证明实际评测，使用网站提交与正式成绩回传。

## Consequences

新节点独立承担实际评测，主站仍保留原 Worker
镜像和配置作为回退资源。版本升级需要协调 Core 与 Judge 协议，并保留节点 Compose
覆盖文件及已验证的 Evaluator SDK 修复。

部署验收以网站实际提交为依据：TodoMVC 题的部署样例在家庭节点执行并形成有效
`graded` 尝试，获得 100 分；断开并恢复隧道后，恢复 timer
自动重建队列连接，随后再次 提交同样获得 100
分。完整验收、服务配置备份与回退步骤保存在主站运维目录。

节点整机重启后，Worker、认证通道和恢复 timer 自动启动；在主站备用 Worker
停止的条件下， 第三次网站提交继续获得 100 分，评测缓存与实例身份保持不变。

本次不修改数据库
schema、题目版本或评测协议，不提交真实凭据、机器私钥或用户提交内容。
