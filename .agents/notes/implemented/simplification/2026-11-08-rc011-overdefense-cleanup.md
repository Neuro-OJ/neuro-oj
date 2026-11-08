# Agent Note: rc/v0.11 过度防御与死代码清理

Status: implemented

## Problem

rc/v0.11
全模块审查发现一批“没有实际威胁的防御”和死代码：运行时判定事务类型的兼容层、
同一份数据的重复校验、永远不会触发的判空与
catch、只有测试在用的导出、把测试门禁放进
生产代码（运行时读取自身源码），以及一处反向问题——登录限流在 DB 异常时静默降级到
`unknown:` 桶，攻击者可借 DB 抖动重置自己的限流桶。

## Decision

每一项先核实调用方与上游保证，再删除；核实不成立的保留。

- **core assets**：删除 `LegacyStorageExecutor` / `LegacyQuotaExecutor` 与
  `"transaction" in executor` 判定；需要事务的入口收窄为
  `DbTx | undefined`（不传时内部 开事务），只读 / 单语句函数保留
  `Executor`（根连接合法，避免调用方强转）。 合并 `releaseDomainStorageObjectTx`
  / `attachDomainStorageUpload` 别名； `registerReadyStorageObjectTx`
  取不到行锁时改为抛错（不变量被破坏），不再静默返回。
- **core problems**：删除 `normalizeBundleRoot`
  中重复的路径校验（入口已校验，去前缀不会 引入 `..`）；删除零调用的
  `deleteSupportPackage`、`deleteProblem` 与已被域入口取代的
  `/api/v1/problems/oi-author/*` 路由；题包导入补偿失败改为 `logger.warn`。
- **core 系统设置 / 事件总线**：`updateSetting` 只查一次定义；抽出
  `decodeRowValue`； `validateValueType` 改为穷尽检查；失效通知日志降为
  debug；删除只 `psubscribe` 时永不 触发的 `message` 监听。
- **core 登录**：Redis 包装收敛到 `withRateLimitRedis` 一处并保留
  `cause`；同一请求只解析 一次账号 key；`resolveLoginAccountKey` DB 异常改为抛
  `ServiceUnavailableError` （**有意的行为变更**，fail-closed）。`AppError` 支持
  `ErrorOptions` 以携带 `cause`。
- **core 教学**：删除 `interactionStaff` 未使用的能力参数。
- **noj-ui 代理**：删除不可达的 `toUrlPathname` catch 与只做日志再抛出的
  try/catch； core 的 `UserResponse` 恒含 `role`，删除代理层的 role 推算。
- **noj-cli**：`topLevelDispatchNames`（运行时读自身源码）移入
  `commands_test.ts`， `deno compile`
  后的二进制不再依赖源码文件；删除类型已保证的 `typeof spawn` 守卫与
  `void runner; void dockerBin;`。
- **noj-judge**：删除已被替代的 `command_for_case` /
  `command_for_testlib_checker`、 `uniform_status_result` 未使用的参数；不可达的
  `LogOutput::StdIn` 分支改为忽略。
- **noj-lmcc-extension**：删除零调用的 `submission()` /
  `problem()`；退出登录时清理当前 服务器与账号的模板草稿（`drafts.ts` 纯函数 +
  测试）。
- **noj-llm-gateway**：删除组合根中类型已保证的判空；Provider Key 解密失败记
  warn （只带 provider id）并显示 `****(decrypt_failed)`，与“Key 过短”区分。

## Alternatives considered

核实后保留、未改动的项：

- `loginThrottle` 的 `setTimeout` 兜底清理：`applyLoginBackoff` 只在同一 key
  再次请求时 惰性删除，不再出现的 key 只能靠它回收，删除会让 Map 无限增长。
- `problem.json` 的 OI 配置解析：两处做的是不同工作，不存在重复解析。
- judge testlib 分数处理：先做资源 / 异常归因再算部分分，不是重复映射。
- LMCC 响应解析两条分支：合并会改变非 2xx 的错误文案。
- LMCC 退出登录调用 `/auth/logout`：core 会吊销 jti，是有效调用。
- 审计日志分页：`parsePagination` 对非法参数抛
  400，现有实现回退默认值，语义不同，保留。
- 解压后按实际字节复核大小：声明大小可伪造，是有意义的防御。
- gateway 中 token `exp` 的多处检查：排队期间可能过期，属于有意的 TOCTOU 防护。

- `_setSubscriberReadyForTest` 的 `NOJ_ENV=test` 守卫：曾加入，CI 的
  `deno task test:logic` 不经测试启动器、不设
  `NOJ_ENV`，守卫使事件订阅者测试全部
  失败，已撤回。测试接缝依赖命名约定，不在运行时设防。

## Consequences

- 登录限流在 DB 不可用时返回 503，而不是放行到新的限流桶。
- `/api/v1/problems/oi-author/*` 不再存在（仓库内无调用方，前端走域入口）。
- assets
  需要事务的入口不再接受根连接；测试中把根连接当执行器的写法已改为显式开事务。
- 修复一个既有的测试隔离缺陷：`domain-community.test.ts` 与
  `legacy-moderation-scope.test.ts` 把实例模块政策 `instance_allowed_modules`
  的社区 关闭后不恢复；本批次删改测试使 CI 分片计划变化，二者与
  `default-community-permissions.test.ts`
  同分片后者即失败（“此模块已停用”）。两个 污染方改为 `finally` 中
  `resetSetting`，受害方在 `scopedApp()` 先重置该政策。
- 本批次不包含大文件拆分，拆分在后续批次进行。
