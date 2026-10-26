# Agent Note: P3 显式身份与 access 事务合同首批迁移

Status: implemented

## Problem

用户身份可以缺省为
root，事务参数使用根连接与事务的联合类型；成员、邀请和账户注销的
跨模块副作用由隐含上下文或调用约定维持，无法明确验证权限与事务边界。单独把数据库函数
改成接受联合句柄，也不能防止 Drizzle 事务再次被误识别为根连接而开启嵌套事务。

## Decision

引入 access-owned Actor 合同与真实 Drizzle callback 推导的
DbRoot/DbTx。用户写入要求
UserActor，系统身份由独立可信组合入口创建；真实生产入口的类型负例纳入正式
`deno task check:contracts`，并串入 `check:types`。HTTP
认证适配器负责取得用户身份， 业务服务不再通过空字符串或角色字符串猜测用户。

成员和课堂邀请的本地锁与多表写入要求 DbTx，application
持有外层事务并绑定必要教学
副作用。课堂邀请使用教师的课堂管理能力校验，不能错误套用通用域邀请权限。成员、域与
邀请使用统一锁序，账户注销按顺序锁定管理员集合并在锁内重新核对最后管理员约束。

主代理补充真实 PostgreSQL
约束失败注入：在域成员写入后的课堂成员步骤失败，域成员与
邀请使用次数必须一同回滚，移除故障后同一邀请能够成功重试。该负例证明跨模块原子性，
同时写入成功的正例本身不足以证明事务边界。

## Alternatives considered

- 继续允许缺省身份或 root sentinel：无法区分用户请求与可信系统命令。
- 为事务传递定义新的 RootDb | Tx 别名：仍允许根连接冒充需要原子的 helper。
- 使用独立 fake
  函数证明类型合同：无法发现真实生产接口被意外放宽，改为检查实际入口。
- 只检查课堂与域成员都创建成功：无法证明第二步失败时第一步回滚，因此补真实约束失败。
- 通过可选 callback 缺省省略教学清理：会静默改变产品语义，必要步骤由 application
  绑定。

## Consequences

这是 P3 的首批合同与用例交付，并非整个 access 或 P3 验收完成。旧
identity/workspace 生产入口和 Executor
兼容别名仍待后续迁移；账户注销的完整应用编排也须进一步收敛， 避免 access
反向依赖 application。跨模块结构、持久恢复和其他模块继续按批准计划推进。

主代理独立验证：正式 `deno task check:contracts` 通过；账户注销正式定向回归 3
passed / 0
failed（含真实双连接管理员互删）；课堂邀请与真实跨模块失败回滚正式定向 回归 2
passed / 0 failed。日志分别为 `/tmp/noj-p3-access-contracts-review.log`、
`/tmp/noj-p3-access-concurrency-review.log`、`/tmp/noj-p3-access-rollback-review.log`。
新增回滚测试的 fmt/lint/type check
通过。仅使用本轮专用隔离资源，未操作既有服务。
