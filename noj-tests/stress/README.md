# Neuro OJ 高并发模拟赛压测与混沌演练套件

本目录提供面向公测与线上模拟赛场景的压测、背压观测与 Worker
排空/重投一致性校验工具。

## 工具清单

| 脚本                    | 职责                                                                                               | 离线 Dry-Run     | 真实环境模式               |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ---------------- | -------------------------- |
| `contest-load-test.ts`  | 模拟赛波峰并发提交、AI/OI 混合题型、4:2:1 优先级调度、P50/P95/P99 与 429/503 背压统计              | 默认 `--dry-run` | `--live --base-url <url>`  |
| `chaos-drain-verify.ts` | Worker 优雅排空与非正常中断重投恢复一致性校验（Redis `processing` / `waiting` 状态核对与幂等断言） | 默认 `--dry-run` | `--live --redis-url <url>` |
| `stress_test.ts`        | 验证压测器指标计算（P95/P99、吞吐、公平性、异常阈值）与干跑链路                                    | 全离线执行       | —                          |

## 常用参数

### `contest-load-test.ts`

- `--dry-run` / `--live`：切换离线仿真与真实 HTTP 压测（默认 `--dry-run`）
- `--base-url <url>`：目标 `noj-core` 地址（默认读 `E2E_BASE_URL` 或
  `http://localhost:8099`）
- `--admin-token <jwt>`：`--live` 模式控制面/管理员鉴权 Token
- `--user-tokens <t1,t2,...>`：`--live` 模式多虚拟用户独立 JWT 列表（逗号分隔）
- `--user-credentials-file <path>`：`--live` 模式多用户凭据 JSON
  文件（`[{ token } | { login, password }]`）
- `--auto-register`：自动通过公开注册（或管理员开号 API）为每个虚拟用户获取独立
  Token
- `--allow-shared-user`：显式允许 `--users > 1`
  时复用单账号（否则拒绝假多用户并发）
- `--contest-id <id>`：`--live` 模式竞赛 ID（走竞赛入口产生 `high` 优先级任务）
- `--ai-problem-id <id>` / `--oi-problem-id <id>`：AI 题与 OI 题 ID
- `--users <n>`：并发虚拟用户数（默认 `20`）
- `--peak-submissions <n>`：波峰提交总量（默认 `70`）
- `--ai-ratio <0..1>`：AI 题型占比（默认 `0.5`）
- `--burst-ms <ms>`：波峰投递时间窗口毫秒数（默认 `200`）
- `--max-p95-ms <ms>` / `--max-p99-ms <ms>` /
  `--max-error-rate <0..1>`：验收告警阈值
- `--json`：输出机器可读 JSON 报告

### `chaos-drain-verify.ts`

- `--dry-run` / `--live`：切换离线仿真与真实 Redis 队列检查
- `--redis-url <url>`：`--live` 模式 Redis 地址
- `--queue-prefix <pfx>`：Redis 队列键前缀（默认 `noj:judge:queue`）
- `--tasks <n>`：仿真阶段注入任务数量（默认 `12`）
- `--json`：输出 JSON 结果

## 执行示例

### 1. 离线自检与 CI 可重复验证（零容器依赖）

```bash
cd noj-tests

# 类型检查与自检套件
deno check stress/*.ts
deno run -A stress/stress_test.ts

# 干跑高并发压测与混沌排空演练
deno run -A stress/contest-load-test.ts --dry-run --users 50 --peak-submissions 140 --ai-ratio 0.5 --json
deno run -A stress/chaos-drain-verify.ts --dry-run --tasks 20 --json
```

### 2. 指向真实测试环境压测与队列核对

```bash
cd noj-tests

# 对接真实隔离测试栈执行模拟赛压测
deno run -A stress/contest-load-test.ts \
  --live \
  --base-url http://localhost:8099 \
  --admin-token "$NOJ_STRESS_ADMIN_TOKEN" \
  --contest-id "$CONTEST_ID" \
  --ai-problem-id "$AI_PROBLEM_ID" \
  --oi-problem-id "$OI_PROBLEM_ID" \
  --users 50 \
  --peak-submissions 200 \
  --ai-ratio 0.4 \
  --max-p95-ms 15000 \
  --json

# 排空演练后核对 Redis processing / waiting 是否归零
deno run -A stress/chaos-drain-verify.ts \
  --live \
  --redis-url "redis://:password@127.0.0.1:6379/0" \
  --queue-prefix "noj:judge:queue" \
  --json
```
