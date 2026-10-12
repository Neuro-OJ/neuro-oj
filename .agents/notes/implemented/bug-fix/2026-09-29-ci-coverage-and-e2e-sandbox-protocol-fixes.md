# Agent Note: CI 覆盖率门禁、E2E 沙箱下载协议与测试并发事务隔离修复

Status: implemented

## Problem

在全量提交前五批审计修复后，GitHub Actions CI/E2E 门禁发现以下断言与测试环境缺陷：
1. **网关覆盖率门禁失败（TS2322）**：`noj-llm-gateway` 的 `FakeRedis.get()` 签名缺失 `key` 可选入参，导致 `deno task test:coverage` 执行类型检查时抛出类型不兼容错误，阻断全局覆盖率收集报告。
2. **E2E 容器内支持包下载被拒（SE-01 误伤）**：Batch 2 中在 `noj-judge` 禁用了 `noj-download://local` 协议以防范生产环境直接读取宿主机文件，但在 `docker-compose.e2e.yml` 与 `env.e2e.template` 中未传递放行开关 `JUDGE_ALLOW_LOCAL_DOWNLOAD=true`，导致沙箱 E2E 批量评测因协议被拒而报 `verdict=error`。
3. **单连接测试中嵌套事务并行执行（AR-03 测试）**：`testWithDb` 在单一数据库连接中开启测试事务，并使用 SQL SAVEPOINT 模拟事务。`Promise.all` 并行发起两笔 HTTP 请求会导致同一连接上的 SAVEPOINT 产生交叉交错破坏 LIFO 语义，导致 PostgreSQL 中止事务块并抛出 23505 冲突。
4. **全站榜单物化视图与回退逻辑对齐（DL-03 / 决策 3）**：PostgreSQL 物化视图 `user_rankings` 中的 `total_submissions` 统计全站提交总数，仅在 `solved_count` 中按比赛有效性过滤；`readRankingsInline` 此前误将过滤条件放于外层 `WHERE` 导致分母计算不一致。
5. **E2E 审计日志非管理员测试 Token 失效（AR-05）**：`audit_log.test.ts` 前序步骤执行了 `banUser` 测试，触发了会话版本号递增；后续测试复用旧 `userToken` 导致接口返回 401 而非 403。
6. **重测结果被误判为重复结果丢弃（JA-02 / CR-01）**：JA-02 在发起重测时保留历史成绩（不预先物理删除 `evaluationResults`）以防 Redis 故障丢失历史；但 `submissions-result.ts` 此前包含 `if (existingResult && incomingSeq === sub.rejudge_seq) return null;`，导致重测评测机回传结果时误认为“已落库的重复消息”而丢弃，提交永久挂在 `judging` 导致 E2E Cross Domain / Submission 重测用例超时 120s。
7. **废弃脚本闸门测试在具控制终端环境下挂起**：`test-deprecation-gate.sh` 模拟非 TTY 测试时，因本地子进程继承了主控终端 `/dev/tty`，触发交互等待导致超时。
8. **重测时新签发 eval_token 被前次吊销标记拦截（AR-08 / 决策 7）**：决策 7 在评测完成时于 Redis 写入 `llm:token:revoked:${subId}`；重测时为该提交重新签发了新 token，但在网关校验时因前次的 Redis 键尚未过期而被误拒 401（`token_revoked`），导致 E2E 7.3 重测用例失败。

## Decision

1. **补齐 FakeRedis 签名**：
   - 将 `FakeRedis.get()` 签名调整为 `get(_key?: string): Promise<string | null>`，满足 `RedisClient` 接口契约，覆盖率收集恢复正常（83% 行覆盖率）。
2. **E2E 环境明确放行本地协议**：
   - 在 `docker-compose.e2e.yml` 与 `env.e2e.template` 中为 `noj-judge` 注入 `JUDGE_ALLOW_LOCAL_DOWNLOAD: "true"`，使 E2E 容器挂载目录评测正常运行，生产环境继续严格禁止。
3. **消除测试内跨 SAVEPOINT 交错**：
   - 将 `admin-problems.test.ts` 内针对单测试连接的 `Promise.all` 拆为串行执行，确保 SAVEPOINT 正确推进并验证题号递增分配与唯一性。
4. **统一排行榜统计口径**：
   - 将 `readRankingsInline` 与 `getMyRanking` 的比赛门控条件移入 `solved_count`、`acceptance_rate` 的 `FILTER` 及 `HAVING` 子句，与 `user_rankings` 物化视图的 SQL 结构严格对称。
5. **E2E 封禁测试后会话刷新**：
   - 在 `audit_log.test.ts` 中受测用户被封禁与解封后，重新登录获取携带最新 `session_version` 的有效 Token，正确断言非管理员访问返回 403。
6. **允许重测结果替换历史成绩**：
   - 移除 `submissions-result.ts` 中错误的短路检查；重复消费与过时防线由 `incomingSeq < sub.rejudge_seq` 和状态机终态收紧（仅允许 `pending/judging/error` 转终态）全面兜底；重测结果正常替换旧有的 `evaluationResults`。并新增单元回归测试。
7. **测试环境显式覆盖 TTY 路径**：
   - 在 `test-deprecation-gate.sh` 模拟非 TTY 用例中注入 `NOJ_DEPLOY_TTY_PATH=/dev/nonexistent`，确保无论在 CI 容器还是本地交互终端中均一致触发非 TTY 退出码 2。
8. **重测发起时清空历史 eval_token 吊销标记**：
   - 在 `rejudgeSubmission` 与 `rejudgeProblemSubmissions` 中，发起重测前调用 `redis.del(\`llm:token:revoked:${subId}\`)`，使重新签发的 `eval_token` 在网关处正常放行，形成重测与吊销生命周期的完整闭环。

## Alternatives considered

- 在生产环境中允许 `noj-download://local`：违反不可逾越的沙箱与宿主机隔离红线，必须保留环境开关。
- 重建物化视图迁移：已有迁移已定稿，且生产口径本就保持独立提交计数，修改内联回退逻辑使其与生产视图完全一致是风险最低的最优解。
- 重测发起时物理删除 `evaluationResults`：违背 JA-02 安全设计原则，若队列推送异常会导致用户前次真实成绩直接丢失。

## Consequences

- CI Coverage Check、Core catalog、Core query 与 E2E 沙箱测试、Cross Domain 及 Submission 重测全线恢复绿灯。
- 保证本地测试（PGlite）与线上生产（PostgreSQL 物化视图）排行榜计算逻辑严格统一。
- 重测机制完全自洽，评测机任务与核心结果落库形成闭环。
