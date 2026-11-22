# Agent Note: 统一等待器、Judge canary 与 Redis 故障注入

Status: implemented

## Problem

E2E 各文件自行实现"固定 sleep + 重试"：请求耗时不计入预算，卡住的请求无法取消，
超时错误缺少资源状态；Judge 可用性探测在多个用例里重复提交，失败后直接 `return`
让用例显示通过。生产环境 JWT 撤销测试连接一个不存在的 Redis 端口， 依赖 ioredis
重试，单次约 31 秒。

## Decision

- `noj-tests/fixtures/wait.ts`：`waitUntil(read, isDone, options)`
  首次立即读取， 退避 100/250/500/1000ms 后每秒；绝对截止时间；单次请求默认 ≤5s
  且不超过剩余 预算；请求、解析、等待都计入预算；401/403/404
  等确定性错误立即抛出，网络错误 与 5xx
  在预算内重试并保留最后错误；超时错误带资源 ID、最后状态、HTTP 状态、
  读取次数与实际耗时。`pollSubmission`、`waitForJobCompleted`、`waitForServer`
  迁移到该原语，保留原位置参数签名（重试次数 × 间隔 → 总预算）。
- 重评测等待要求 `latest_attempt` 也进入终态，避免旧 attempt 的 finished
  让调用方 提前成功；保留 `allowErrorResult`。
- noj-tests 启动器在运行前执行一次 Judge canary（独立题包导入 → 发布 → 提交 →
  等到真实 attempt 的 finished + graded），把提交/尝试/结果写入运行清单；子测试
  只读取并校验 runId、提交 ID 与结果，清单缺失或不匹配直接失败。
- `noj-core/tests/helpers/redis-resp.ts` 提供绑定 127.0.0.1 随机端口的 RESP
  服务： 分段解析命令，支持 ioredis 初始化所需的
  PING/INFO/CLIENT/SELECT/QUIT，收到目标 EXISTS 立即返回约定错误并记录 key。生产
  bypass 测试通过**默认客户端**指向该服务， 断言 EXISTS 实际到达且抛出
  `ServiceUnavailableError`。

## Alternatives considered

- 继续用固定 sleep：无法把请求耗时计入预算，也无法取消卡住的请求。
- 每个用例自行探测 Judge：重复提交且失败时容易退化成静默跳过。
- 给 `isJtiRevoked` 传 fake client：会绕开"默认客户端 + 生产环境保护"分支，
  测试证明不到真正要保护的条件。
- 连接关闭的端口等待重试：耗时不可控，且错误来自连接而不是 Redis 响应。

## Consequences

- 生产 bypass 用例从约 31 秒降到 6ms 级（日志实测 2ms），且保留了 EXISTS 证据。
- canary 每次隔离运行会新增一道带提交的题；E2E
  临时栈可接受，长期库需要清理策略。
- 子测试不再接受"Judge 不可用即跳过"：正式 task 中 Judge 不可用会让运行失败。
- 旧位置参数仍可用，但语义变成总预算；超长 intervalMs 的调用需要按预算重新评估。
