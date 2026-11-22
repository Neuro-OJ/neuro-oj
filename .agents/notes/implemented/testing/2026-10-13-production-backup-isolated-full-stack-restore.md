# Agent Note: 正式备份格式与隔离完整栈恢复验收

Status: implemented

## Problem

产品升级需要真实验证账号、Domain、题目版本、提交、评测尝试、域
Provider、用量、Redis 预算及版本对象可以协调恢复。仅验证 PostgreSQL
转储，不能证明密钥、对象或后续评测仍然可用。

现有 E2E 主栈使用 local 存储，文件位于共享的 `/app/data/storage` 卷。正式 CLI
只支持 S3 生产配置，`prod-raw` 备份包含 PostgreSQL、Redis、MinIO
和加密环境文件，不包含开发 local 卷；E2E core 的 `/entrypoint.sh serve`
也不能代替正式镜像的 `/app/bin/noj` 入口。

## Decision

### 验收环境与数据准备

- 只读采集原 S3 验收库 `noj_upgrade_s3_e2e_20261013` 及源 MinIO
  对象，不改写源版本、资源 URL 或源数据库。其 10 个历史版本和 9
  个真实对象保留在克隆中。
- 创建独立 Compose 项目 `noj-backup-acceptance-20261013`，复制正式 Compose
  配置并显式更换本地镜像与独立项目名。只在临时 acceptance 层增加回环端口、Mock
  上游与 E2E Judge。
- core 使用正式 `noj-upgrade-server:20261013-final` 编译镜像，ID 为
  `5631f9921ed80436ba3b7cdf5676f6f7e9435545aba7558d3d6fb61c16498cde`，入口
  `/app/bin/noj-server`；UI 使用正式 `noj-upgrade-ui:20261013-final`，ID 为
  `d3ed0ac44934346ba4d1bbb02b6676a9aa2273f2ad957ba3129afd0225d67f1e`，入口
  `./noj-ui`。Gateway 使用当前标准 Dockerfile 构建的镜像，与 core 使用同一独立
  PostgreSQL。
- 通过真实 API 创建两所私有学校、独立普通负责人和学生，引用同一公开 LLM
  源题。为准备普通账号，只在隔离项目暂时使用既有 development/mock 邮件配置；生产
  `EMAIL_PROVIDER=disabled` 正确拒绝公开注册。准备完成后恢复 production/disabled
  配置并重启隔离 core，正式备份和恢复后的验证均使用该生产配置。
- 标准 `deno task test:domain cross-domain --no-lock --filter=e2e/llm-gateway`
  在该克隆中实际通过 7 项，产生两域的 4 次真实 LLM 调用及用量。调用经过
  Judge、Gateway 和独立项目内的 Mock，重测重新签
  token；不是写数据库伪造分数或用量。学校 A Provider
  被门禁停用的状态也保留在快照中。

### 标准 CLI 备份与恢复

使用模块文档允许的源码 CLI 开发入口执行正式 payload 操作：

```bash
cd noj-cli
deno run -A src/cli.ts backup create \
  --dir /tmp/noj-backup-acceptance-20261013 \
  --passphrase-file /tmp/noj-backup-acceptance-20261013/backup-passphrase
deno run -A src/cli.ts backup verify \
  /tmp/noj-backup-acceptance-20261013/backups/snapshot-20261013-113601.nojbackup \
  --deep --dir /tmp/noj-backup-acceptance-20261013 \
  --passphrase-file /tmp/noj-backup-acceptance-20261013/backup-passphrase
deno run -A src/cli.ts backup restore \
  /tmp/noj-backup-acceptance-20261013/backups/snapshot-20261013-113601.nojbackup \
  --dir /tmp/noj-restore-acceptance-20261013 \
  --passphrase-file /tmp/noj-restore-acceptance-20261013/backup-passphrase \
  --confirm
```

三个命令均实际退出 0。产物为 AES-256 加密的 `prod-raw` `.nojbackup`，大小 102214
字节，sidecar SHA-256 校验也通过。快照、sidecar 和恢复的环境文件权限均为 0600。

目的项目 `noj-restore-acceptance-20261013` 使用独立卷、独立网络及端口：core
8102、UI 3002、Gateway 8006、PostgreSQL 5435、MinIO 9005。原项目使用 core
8100、UI 3001、Gateway 8004、PostgreSQL 5434、MinIO 9004；原 E2E 源栈仍为 core
8099、UI 3000、PG 5433。恢复没有覆盖源栈。

首次目的项目启动遇到正式 Compose 固定 `172.28.0.0/16`
与备份项目冲突，保留失败记录，在临时目的 Compose 明确改为未占用的
`172.30.0.0/16` 后重跑成功，没有修改仓库生产网络规则。`--restore-env`
在首次运行已成功解密到独立新文件，重跑保留该文件、没有覆盖它；其 SHA-256
与快照源 `.env.prod`
完全一致：`095d0e144d1a978b0741c743f3bee97c2e3d9dcea2f223e3052abdaab09a2d47`。

### 恢复后的真实证据

在目的正式 core/Gateway/UI 健康后、任何新提交之前，校验完整行的排序 JSON
摘要和行数：

| 数据                 | 恢复数量 | 验证                                       |
| -------------------- | -------: | ------------------------------------------ |
| 账号                 |        7 | 整表一致                                   |
| Domain               |        5 | 整表一致                                   |
| 成员与域角色         |  15 / 17 | 整表一致                                   |
| 源题与绑定           |   9 / 12 | 整表一致                                   |
| 不可变题目版本       |       11 | 整表一致，含原 10 个历史版本               |
| 版本对象引用         |       10 | 整表一致                                   |
| 提交与评测尝试       |    3 / 4 | 整表一致，提交 ID、尝试 ID、版本与成绩保留 |
| 加密 Provider        |        2 | 整表一致，包含停用状态与 revision          |
| 持久用量             |        4 | 整表一致，含两域模型和原尝试关联           |
| 域默认 Provider/模型 |        2 | 整表一致                                   |
| 持久配额             |        4 | 整表一致                                   |
| 原调用账本           |        4 | 原尝试对应的完整行一致；新调用另增一条     |

10 个真实 MinIO 对象与解包出的 payload 逐文件字节比较通过。原 9 个 S3
对象的文件及 SHA-256 保留；额外对象来自真实 LLM 新版本。没有把 `mc mirror`
的退出码或文件名清单当成字节证明。

Chromium 实际打开恢复后的正式
UI，使用恢复的学生账号在登录表单登录，读取原域的历史提交。页面显示来源题号、使用域、V1、100.0
分、评测沿革及原代码；历史 API 同时验证原提交和尝试 ID。随后该学生在恢复的学校 B
创建新正式提交，真实 Judge → Gateway → 本项目 Mock 完成 10000 分，持久用量为 8
tokens，Provider 及 `school-b-mv6lrmvi` 模型保持本域归属。这同时证明恢复的
Provider 密文能用恢复的环境密钥解密并实际调用。

Redis 原日预算为全实例 4 calls / 32 tokens、学校 A 2 / 16、学校 B 2 /
16；恢复后新增学校 B 调用变为全实例 5 / 40、A 仍 2 / 16、B 3 /
24。持久调用账本从 4 条变为 5 条，原 4 条完整行仍一致。

源与恢复项目、原 E2E 栈最终健康检查通过。成功的 CLI 数据恢复日志起止时间为
19:39:21.148–19:39:48.434，约 27.3 秒；正式服务启动约 24.7 秒。19:43:10.968
完成最终业务验证，从成功恢复开始约 3 分 50 秒，包含临时验证脚本
DTO/选择器修正，不作为性能基准或首次尝试成功率。快照标记创建时间为 19:36:01。

### 证据位置及开发快照边界

本机临时目录保留配置、快照、解包内容及验收脚本，没有加入仓库提交：

- `/tmp/noj-backup-acceptance-20261013`：源克隆、正式快照、对象、`expected.json`
  与 `check-restored-stack.ts`。
- `/tmp/noj-restore-acceptance-20261013`：目的配置和恢复的加密环境文件。
- `/tmp/noj-client-backup-prod-llm-prepared.log`：7/0 真实 LLM 门禁。
- `/tmp/noj-client-backup-create-official.log`、`/tmp/noj-client-backup-verify-deep-official.log`、`/tmp/noj-client-backup-restore-official-second.log`：正式
  CLI 三阶段结果。
- `/tmp/noj-client-backup-restored-production-verify-final.log`、`/tmp/noj-client-backup-object-byte-comparison.log`、`/tmp/noj-client-backup-restored-ui-history.png`：数据库、对象、Web
  与新调用证据。

另只读采集旧 local 开发库 `noj_upgrade_e2e_20261013`、完整 Redis RDB、local
存储卷和其测试环境密钥，单独生成 1119254 字节 AES-256 加密
`development-local-snapshot.tar.zst.gpg`。该源库有 413 用户、186 提交、13
Provider、21 条真实用量，采集前在途评测和三优先级队列均为空。Redis RDB 包含该
Redis 实例的全部逻辑库，开发栈使用 DB1；不能把它描述为只含 DB1 的导出。本次
local 补充快照没有另起完整恢复栈，其可读恢复不能用上述 S3 验收结果代替。

## Alternatives considered

- 仅恢复 PostgreSQL：不能发现版本字节缺失、Provider 密钥不匹配或 Redis
  预算重置。
- 将开发 local URL 改写成 S3：改变原历史依据，也掩盖正式备份格式的适用边界。
- 直接复用 E2E core 入口作为正式镜像：无法验证编译入口、生产配置检查和正式 UI
  二进制。
- 只用 Mock HTTP 绕过
  Judge，或直接写正式分数：无法证明恢复后的可信评测链路与计量。

## Consequences

正式 S3 `.nojbackup` 格式的实际采集、深度校验、隔离恢复、完整栈启动、历史 Web
读取及新 LLM 评测形成闭环。验收发现并独立修复 Compose 项目上下文遗漏和 mc
宿主身份两个实际备份缺陷。

本机没有专用 rootless Docker daemon，本轮使用明确标记的 E2E Judge 访问主机沙箱
daemon；不宣称生产 rootless Judge
部署验收。源栈和源数据保持原样，隔离验收项目保留供复核。真实外部邮件、异机硬件恢复、开发
local 栈完整恢复与最终 main
集成后的新版镜像仍需各自验证，不能从本轮结果推定通过。
