# Agent Note: 最新协调版本的完整备份与独立生产栈恢复

Status: implemented

## Problem

主线集成后的迁移 0116／0117、域模型别名及输入模式需要新的完整恢复证据。
之前的旧主题栈恢复不能证明最新 core、UI、Gateway 和 CLI 可以共同保留历史并
继续创建真实评测。

## Decision

从独立 MAIN 验收项目只读采集 PostgreSQL、Redis 和 MinIO 到新备份项目；源
项目及原开发／旧验收项目均不修改数据、停服或重建。使用正式编译 CLI 执行 加密
`backup create`、`backup verify --deep`、`backup restore --confirm`，
恢复到第二个独立项目和独立持久卷。恢复配置保持 production／disabled 邮件，
不为注册测试临时启用生产注册。

正式快照：

- 路径
  `/tmp/noj-main117-backup-20261013/backups/snapshot-20261013-133045.nojbackup`。
- 550985 字节；SHA-256 为
  `602752725a9f06db40cc5f2f1b80c3b67de89f4e0b1828247047e0b64846a3d7`。
- create／deep verify／restore 均退出 0；sidecar 的 `sha256sum -c` 通过。
- 恢复的原环境文件与备份源环境文件摘要相同，文件权限 0600。

恢复后逐项比对：28 组持久表的完整行数及排序 JSON 摘要、63 个对象的字节数与
SHA-256、87 个日预算计数均相同。包括账号、域角色、题目／不可变版本／绑定、 69
个原普通提交与 88 个尝试、班级／作业／进度／反馈／批注／求助、模型别名、
Provider、用量、额度与调用账本。

在验证原记录相同后执行真实新 LLM 提交；Judge 从恢复后的支持包执行并经
Gateway／Mock 完成 10000 分。目标域 Provider／实际模型与原别名一致，用量 8
tokens，域和实例调用计数各增加 1、token 各增加 8；其他域的原预算不变。
没有直接写入成绩或账本。

恢复栈采用含教学写频率限制的正式 core
`sha256:3e4f6307daa6da7ba01491e145224f053d236067c1202efc0abdc4507f101ee9`。 core
业务源码与之后 #641 合并结果相同，迁移／初始化再次通过。 最终 UI 使用 #641
协调构建的
`noj-upgrade-ui@sha256:a175d6d1ca58cec16540dd556b5d12d1107706f8d2dbd86614bb3c2fa26d4616`，
Gateway 为 `53d305b8ab34`，Judge 为 `75f92c0d61d9`，SDK 使用同组正式镜像。

最后以最新正式 CLI 二进制和普通域负责人账号运行 HTTP `problem push`，从
目录校验／打包、导入目标域草稿，再携带其 revision 发布 V1；返回来源题号和
同域编辑地址。最新 UI 的真实 Chromium 会话重新读取恢复前的旧提交、来源题号 与
100.0 分。该流程不依赖开发注册或全站管理员身份。

## Alternatives considered

- 仅恢复数据库：不能证明对象、Redis 预算和密钥配置共同可用。
- 复用旧主题栈验收：版本、迁移与模型契约不同，不采用。
- 使用测试数据库写入假成绩：不能证明恢复后 Judge／Gateway 与存储的实际运行。
- 用新建账号测试生产 disabled 邮件配置：该配置应拒绝注册，使用已恢复账号。

## Consequences

本次使用独立主机端口和持久卷，原数据仍保留；备份与临时凭据不提交仓库。 运行
Judge 使用验收主机 Docker daemon，不宣称已验证生产 rootless Judge 部署。 LLM
上游为具有实际 HTTP 调用和用量的 Mock，不代表付费 API 或真实邮件供应商。

关键日志：`/tmp/noj-main117-cli-backup-{create,deep-verify,restore}.log`、
`/tmp/noj-root-main117-restored-final-check.log`、
`/tmp/noj-root-main117-final-clients.log`。前者对应正式
CLI，后两者分别记录原数据／ 对象／预算比对与新调用、最终客户端。最终 UI 采用
image manifest digest；首次 误把 config digest 作为 image 引用时 Compose
拒绝拉取，未替换运行容器；纠正
引用后真正启动并完成客户端验证，不把失败操作计入成功。
