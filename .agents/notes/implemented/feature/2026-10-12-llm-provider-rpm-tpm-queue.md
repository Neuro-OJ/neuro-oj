# Agent Note: LLM Provider 支持 RPM / TPM 上限与超限排队

Status: implemented

## Problem

上游 LLM 服务（SiliconFlow、OpenAI 等）按账号限制每分钟请求数（RPM）与 token 数（TPM）。gateway 此前只有按用户 / IP 的分钟限流和日 / 月额度，没有 Provider 维度的速率控制：一场比赛或批量重测集中调用时，超出上游限额的请求直接被上游 429，评测结果取决于评测代码是否自己做重试。

## Decision

- `llm_providers` 新增 `rpm_limit` / `tpm_limit`（`integer NOT NULL DEFAULT 0`，0 = 不限；迁移 `0005_provider_rate_limits.sql`），Provider 新增 / 编辑接口、core 管理 API 与管理页表单同步支持。
- 新模块 `noj-llm-gateway/src/provider-throttle.ts`，在代理路由转发前、用户额度扣减前调用 `acquireProviderSlot`：
  - 60 秒滑动窗口：`rpm` ZSET（请求 ID）与 `tpm` ZSET（`<ID>|<tokens>`），时间取 Redis `TIME`，避免副本间时钟漂移；
  - 公平排队：`queue` ZSET 按自增票号排序，只有队首能占用额度（FIFO），大请求不会被持续插队饿死；
  - 失联清理：等待者轮询时刷新心跳，队首心跳超过 5 秒即被移出（副本崩溃不会永久堵塞队列）；
  - 检查、排队登记与占用在一个 Lua 脚本内原子完成；
  - TPM 按「prompt 估算 + max_tokens」预占，上游返回后按实际 `total_tokens` 修正；用户额度校验拒绝时归还窗口额度；
  - 窗口为空时单个请求即使超过 TPM 也放行，避免永久阻塞。
- 排队超时（`NOJ_LLM_PROVIDER_QUEUE_TIMEOUT_SECONDS`，默认 60，0 = 不排队）返回 OpenAI 兼容 429（`code: provider_queue_timeout`）+ `Retry-After`，记录 rejected 用量；客户端断开时立即退出队列。
- Redis 故障时 fail-open：节流只为保护上游，上游自身仍会 429。
- 新增指标 `noj_llm_provider_queue_wait_seconds`、`noj_llm_provider_queue_timeouts_total`（无业务标签）。
- 多副本约束：全部状态在 Redis，未新增进程内可变状态。
- Lua 语义测试需要真实 Redis（`NOJ_LLM_TEST_REDIS_URL`），CI 的 Gateway Check 任务新增 Redis service 使其真实执行；静态扫描新增 1 处 env 守卫跳过，已更新基线。

## Alternatives considered

- **超限直接返回 429，由评测代码重试**：实现最简单，但把上游限额细节暴露给出题人，且多个评测同时重试会形成惊群。
- **令牌桶 / 固定分钟窗口**：固定窗口在边界处可能放出 2 倍流量，触发上游 429；滑动日志窗口与上游计量方式更接近。
- **不排队、仅轮询重试（无 FIFO）**：实现更简单，但 TPM 场景下大请求会被小请求持续插队而饿死直到超时。
- **进程内队列**：违反多副本约束，多副本时总速率会成倍超限。

## Consequences

- 排队时间计入 `llm_usage.latency_ms`（反映评测代码实际感知的耗时）。
- TPM 预占依赖粗略的 prompt 估算（字符数 / 4），未传 `max_tokens` 时输出部分只能事后修正，短时间内可能略超上游 TPM；建议上限设为上游限额的 80%–90%。
- 本地验证（2026-10-12，SiliconFlow `Qwen/Qwen3-8B`，RPM=2）：并发 3 个请求，前两个约 0.7s 返回，第三个排队约 61s 后成功。
