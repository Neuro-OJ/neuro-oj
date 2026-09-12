# Agent Note: 搜索索引事件测试的隔离缺陷（诊断与部分修复）

Status: implemented

## Problem

全量分片测试（`scripts/test-parallel.ts`）稳定出现 2 个假失败：
`submission search event: 创建提交发布 upsert` 与
`system search event: 创建公告发布 upsert`（929 passed / 2 failed），
而**单文件运行必过**。诊断链条（全部来自真实日志）：

1. `src/domains/submission/tests/` 下多个文件用
   `Deno.env.set("REDIS_URL", fake.url)` 把**生产路径**指向 `startFakeRedis()`
   （`Deno.listen({ port: 0 })` → 随机端口）以实现注入；
2. `REDIS_URL` 是**进程级**环境变量，而同一分片内的测试文件**并行**执行 →
   伪造窗口内其他文件（搜索索引事件断言）也读到该假端口；
3. `getRedis()` 是懒连接单例，被测试里的 `resetRedisForTest()` 置空后按当前 env 重建
   → 绑定到不存在的端口，日志出现 `connect ECONNREFUSED 127.0.0.1:39185` →
   `Connection is closed.`；
4. `publishSearchIndexEvent` 此时静默丢弃事件（只记日志），断言在 5s 内轮询不到 →
   假失败。

另有独立竞态：8 个 `search-events.test.ts` 在测试开头
`await getRedis().del(SEARCH_INDEX_QUEUE)`，同一分片内互相清空对方正在等待观测的事件。

## Decision

1. 新增 `createRedisClientForUrl(url)`（connection.ts）：按显式 URL 建立与共享客户端
   同配置的连接，供测试使用，**不再污染进程级 env**；`consumer.test.ts` 的 4 处
   env 注入改为使用它。
2. `publishSearchIndexEvent` 在共享连接非 `ready` 时先调用幂等的 `connectRedis()`
   （仅在非 ready 路径附加等待），消除"连接未就绪 → 事件静默丢失"这一类失败。
3. 移除 8 个文件里互相删除 `noj:search:index` 的 `del`（断言按本次生成的唯一
   `entityId` 匹配，无需清空队列），并把测试辅助的轮询窗口从 2s 放宽到 5s。
4. **未完成部分如实登记**：`producer.test.ts`(6) / `self-test-consumer.test.ts`(2) /
   `submissions.test.ts`(3) / `legacy-judge-queue.test.ts`(1) /
   `revokedTokens.test.ts`(1) 仍以进程级 env 注入，仍需改为显式 seam 或串行执行。

## Alternatives considered

- 一次性把所有 fake-Redis 测试改成注入式：需要给 `getRedis()`/`pushJudgeTask`/
  消费者工厂加 URL 参数（生产 API 改动），风险与工作量都不小，本次先做低风险部分。
- 把轮询窗口继续放大：治标不治本（连接绑错端口的窗口可能超过任何窗口）。
- 让这些测试用 `--jobs 1` 串行：Deno 的 `--jobs` 是全局的，会让整个分片失去并行收益。
- 给 `getRedis()` 记住首次 URL、忽略后续 env 变更：会让"故意指向 fake Redis"的
  测试失效，等于把问题搬回测试侧。

## Consequences

失败概率下降（env 污染源减少、竞态删除移除、事件不再因未就绪而静默丢弃），
但**全量分片仍可能偶发这 2 个失败**（剩余污染源未清）。判断依据：失败信息指向
`ECONNREFUSED <随机端口>`，且被污染的文件均不在本次改动范围内（可用 `jj diff` 核对）。
