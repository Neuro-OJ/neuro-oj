# Agent Note: 教学写接口共享 Redis 宽松窗口

Status: implemented

## Problem

根写接口限流门禁发现作业和教学互动 router
缺少限流证据。这些接口包含复制、发布、补题等批量副作用及学生求助内容，不能只依靠读取权限或幂等键限制无限写请求。

## Decision

- 在现有 system hardening 服务增加公开
  `enforceEducationWriteRateLimit(slug, actorId)`，通过现有 system
  门面导出，复用 Redis 固定窗口、总开关、503 故障语义及标准 429 响应头。
- 同一域 slug 和账号共享 `education-write` 窗口，60 秒内允许 120
  次。作业创建、编辑、生命周期、复制和补题，以及反馈、求助、回复、状态处理与教学通知已读，共用这一宽松窗口。
- 仅在 assignments 和 interactions 的写路由逐条挂载轻量中间件。GET/HEAD
  不扣额度，不在两个 router 的通配路径中间件分别扣额，防止一次请求重复计数。
- 原业务服务继续检查域、班级、学生及资源授权；不增加第二次 Workspace
  身份加载，不改成绩计算或持久数据结构。
- 更新写操作限流矩阵，并补真实 Redis helper 与真实 Hono HTTP 429 回归。

## Alternatives considered

- 添加进程内计数或 Redis 失败时回退内存，会破坏多副本一致性，没有采用。
- 将教学写操作全部标记为低频管理豁免，会遗漏学生求助及批量副作用，没有采用。
- 在两个 router
  的共享路径各装一层计数，会让互动请求重复扣额，没有采用。计数直接挂在实际写端点。
- 为每种教学动作增加不同窗口，会增加规则和维护负担，没有采用。宽松的域内账号窗口足以满足这次门禁要求。

## Consequences

使用隔离 PostgreSQL schema、PGlite 及 Redis 6390
的独立数据库验证，未更改实际运行栈：

- 标准 system 域 helper 聚焦在 PostgreSQL 和 PGlite 下各 1 passed / 0
  failed。真实 Redis 第 121 次调用抛 429，返回 120 上限与有效
  Retry-After；不同域、不同账号独立计数。
- 标准 education 域聚焦在两库各 3 passed / 0 failed，覆盖新增写限流
  HTTP、现有教学互动和作业学情接口。
- HTTP 验证 GET/HEAD 不计数、一次反馈只扣一次、作业与互动共享窗口、429
  不新建作业、学生求助不受教师窗口影响、其他域路径仍保持原 404
  授权规则，以及超限学生回复返回 429。
- 受影响文件格式、lint、类型和域边界检查通过。写接口门禁中教育两 router
  的缺口已关闭；其他模块的豁免由主 agent 单独维护。

日志位于
`/tmp/noj-education-write-rate-{pg,pglite}-final.log`、`/tmp/noj-education-write-helper-pg.log`、`/tmp/noj-education-write-helper-pglite-final.log`
及 `/tmp/noj-education-rate-gate-types-final.log`，不提交临时日志。没有重跑全
core，相关最终全量回归由主 agent 统一记录。
