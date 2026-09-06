# Agent Note: 修复隔离恢复演练的 PostgreSQL 标准输入读取

Status: implemented

## Problem

在 sng 的真实隔离恢复演练中，`restore-drill.sh` 将自定义格式 PostgreSQL dump
通过标准输入重定向给 `pg_restore`，同时又额外传入了 `-`。目标环境的 `pg_restore`
将该参数解释为容器内文件路径而非标准输入，导致恢复在 PostgreSQL 数据阶段失败。
修复后继续演练时，用户传入的相对快照路径又被 Compose 解释为具名 volume，导致
MinIO 快照目录无法作为 bind mount 挂载。
继续演练还发现 sng 的历史快照早于邮箱验证迁移，`users` 表没有
`email_verified` 字段，演练管理员种子写入因此失败。
旧版 core 的登录接口还会在 JSON 响应中返回 token，而不是直接下发 Cookie；验收脚本
此前只接受 Cookie，因而把成功登录错误标记为失败。

## Decision

省略 `pg_restore` 的文件位置参数，仅保留宿主机快照到 `docker compose exec -T` 的
标准输入重定向；在通过快照目录安全校验后规范化为绝对路径，再用于 Compose bind
mount。补充 fake Docker 演练测试，断言恢复命令以 `-d <database>` 结束且不再传入
字面量 `-`，并覆盖相对快照路径及不依赖 `email_verified` 字段的管理员种子写入。
业务验收同时兼容 Cookie 与 JSON token，并在直连 core 时附带 Bearer token。

## Alternatives considered

- 保留 `-` 并针对特定 PostgreSQL 版本加兼容分支：增加环境差异，且不符合
  `pg_restore` 省略文件参数时读取标准输入的通用用法。
- 先将 dump 拷贝进 PostgreSQL 容器再传入容器路径：需要额外临时文件、清理与权限
  处理，扩大演练现场和失败恢复面。
- 要求调用者始终传绝对路径：容易遗漏，且脚本既支持相对快照目录就应在边界统一
  规范化，避免把可预防的运行时错误交给运维人员。
- 为旧 schema 单独查询字段并拼接 SQL：可以工作，但新 schema 已为已验证账户提供
  正确默认值，省略该可选字段即可满足新旧快照，分支更少且不增加 schema 探测失败面。
- 只在验收容器内保留 Cookie：直连 core 的认证约定是 Authorization，且历史登录
  响应不一定下发 Cookie，无法覆盖真实恢复出的旧版本服务。

## Consequences

隔离恢复演练可直接读取受保护快照，无需在容器内复制 dump，且从仓库目录运行时
可安全传入相对快照路径。未部署 Judge 的开源轻量环境可显式使用 `--skip-judge`，
完成恢复、数据核对、登录和题目读取验收；附件与双容器评测只在启用 Judge 时验收。
