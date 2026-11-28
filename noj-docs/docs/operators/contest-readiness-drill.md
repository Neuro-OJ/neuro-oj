# 公开线上模拟赛压测与复盘演练 SOP

本文档面向大型公开赛与模拟赛前的 SRE 及赛事技术团队，定义从**压测基线验收、赛前检查、赛时应急处置（削峰 / 扩 Judge / 回滚）到赛后复盘**的标准操作程序（SOP）。

> 相关基线与工具：
> - 容量基线方法见 [公测容量基线](./capacity-baseline.md)；
> - 监控指标与告警规则定义在仓库 `deploy/monitoring/noj-alerts.yml` 与 `deploy/monitoring/noj-slo-alerts.yml`；
> - 压测与混沌演练套件位于 `noj-tests/stress/`（`contest-load-test.ts` 与 `chaos-drain-verify.ts`）；
> - 生产生命周期、备份与回滚由宿主机 `noj-cli` 执行（详见 [生产部署指南](./production-deploy.md) 与 [Judge Worker 运维](./judge-workers.md)）。

---

## 一、压测指标基线与告警对齐

公开赛前必须在隔离演练环境使用 `noj-tests/stress/contest-load-test.ts` 与 `chaos-drain-verify.ts` 完成波峰模拟压测与排空恢复验证，并核对如下基线与 `deploy/monitoring/noj-alerts.yml` 告警阈值：

| 观测维度 | 基线验收指标 | 对应告警规则（`noj-alerts.yml` / `noj-slo-alerts.yml`） | 触发告警说明 |
| --- | --- | --- | --- |
| **端到端评测延迟（OI / AI 混合）** | P50 ≤ 3s，P95 ≤ 15s，P99 ≤ 30s | `NojSloSubmissionE2eLatencyFast` / `Slow` | 5s 桶 SLO 错误预算快速消耗 |
| **API 可用性与延迟** | 5xx 错误率 < 0.5%，API P95 < 500ms | `NojApiErrorRateRecentWarning` (≥5%) / `Critical` (≥20%) / `NojApiLatencyHigh` (≥1s) | Core 接口错误或数据库慢查询 |
| **pending 队列积压** | 波峰结束后 5 分钟内消化归零 | `NojQueueBacklogWarning` (`≥100`) / `NojQueueBacklogCritical` (`≥500`) | 评测算力不足或队列消费阻塞 |
| **结果回写积压** | `noj_queue_result_processing_jobs < 10` | `NojResultQueueBacklog` (`≥10`) / `NojResultConsumerDown` | 结果消费者停摆或 DB 写入失败 |
| **在途滞留时长** | 最老 judging 任务 < 180s | `NojStaleJudging` (`≥600s`) | 容器卡死、沙箱异常或 Worker 失联 |
| **Judge Worker 在线率** | 全部注册节点心跳正常 | `NojJudgeWorkersDown` / `NojJudgeHeartbeatMissing` | Worker 崩溃或 Redis 失联 |
| **优先级公平性（4:2:1）** | `high` 平均排队显著优于 `low`，且 `low` 完成率 ≥ 95% | —（`contest-load-test.ts` 断言） | 验证竞赛提交不被普通/重测流量拖垮且不饿死 |
| **背压与限流响应** | 过载时返回 HTTP 429 / 503 而非 OOM | —（压测器统计 `rateLimited429` / `backpressure503`） | 确认核心节点具备优雅降级能力 |
| **排空与重投幂等** | `pending=0`、`processing=0`、`waiting=0`、`dead=0`，无重复结果 | —（`chaos-drain-verify.ts` 断言） | Worker 中断或排空后状态完全收敛 |
| **磁盘与工作目录** | 宿主机根分区剩余 ≥ 20%，工作目录 < 8 GiB | `NojHostDiskLow` (<10%) / `NojJudgeWorkDirPressure` (≥8 GiB) | 预防磁盘写满导致评测容器创建失败 |
| **备份新鲜度** | 赛前 < 2 小时完成完整快照并校验通过 | `NojBackupStale` (>25h) / `NojBackupVeryStale` (>49h) | 确保随时具备 RPO 可控的回滚锚点 |

### 赛前压测执行示例

```bash
cd noj-tests

# 1. 离线干跑校验压测器与统计逻辑
deno run -A stress/stress_test.ts

# 2. 指向隔离预发布/压测环境执行模拟赛波峰压测（AI 40% + OI 60%，100 并发用户，500 波峰提交）
deno run -A stress/contest-load-test.ts \
  --live \
  --base-url https://staging.example.com \
  --admin-token "$NOJ_STRESS_ADMIN_TOKEN" \
  --contest-id "$DRILL_CONTEST_ID" \
  --ai-problem-id "$AI_PROBLEM_ID" \
  --oi-problem-id "$OI_PROBLEM_ID" \
  --users 100 \
  --peak-submissions 500 \
  --ai-ratio 0.4 \
  --burst-ms 5000 \
  --max-p95-ms 15000 \
  --max-p99-ms 30000 \
  --json

# 3. 验证 Worker 排空与中断重投幂等性（检查 Redis processing / waiting 状态清零）
deno run -A stress/chaos-drain-verify.ts \
  --live \
  --redis-url "$DRILL_REDIS_URL" \
  --queue-prefix "noj:judge:queue" \
  --json
```

---

## 二、赛前检查单（T-24h / T-2h / T-30m）

### T-24h：镜像、配置、备份与回滚预演

1. **配置与镜像签名校验**
   ```bash
   noj-cli verify --dir /opt/neuro-oj
   noj-cli judge check --dir /srv/noj-judge
   ```
2. **创建并深校验赛前基准快照**
   ```bash
   noj-cli backup create --dir /opt/neuro-oj
   noj-cli backup list --dir /opt/neuro-oj
   noj-cli backup verify /opt/neuro-oj/backups/snapshot-<ts>.nojbackup --deep --payload-sha
   ```
   （如需端到端恢复验证，请在独立主机上 `install` 同版本后执行 `noj-cli backup restore <snapshot> --confirm`。）
3. **版本回滚零副作用预演（必须提前确认目标版本与门禁路径）**
   ```bash
   noj-cli rollback --dir /opt/neuro-oj \
     --to <上一稳定版本> \
     --restore-backup /opt/neuro-oj/backups/snapshot-<ts>.nojbackup \
     --dry-run
   ```
4. **沙箱与题包验收**：所有比赛正式题包通过 `noj-cli problem lint` 与 `noj-cli problem test` 验证；确认评测机使用独立 rootless Docker socket 且 `JUDGE_EVALUATOR_NETWORK` 禁止设为 `bridge`/`host`。

### T-2h：算力就绪与监控大盘检查

1. 核对所有 Judge Worker 节点状态与并发预算：
   ```bash
   noj-cli judge status --dir /srv/noj-judge
   ```
2. 确认 Prometheus / Alertmanager 正在正常采集 `noj-core` 与 `node_exporter`，`NojCoreScrapeDown`、`NojJudgeWorkersDown`、`NojDatabaseUnavailable`、`NojRedisUnavailable` 均无触发中告警。
3. 执行一次 Canary 提交（或低并发预热提交），确认 SDK 镜像与 `noj-oi-cpp` 镜像均已缓存在各 Worker 本地。

### T-30m：封盘与值守准备

1. 执行最终赛前快速增量前快照（确保异常回滚 RPO 最小化）：
   ```bash
   noj-cli backup create --dir /opt/neuro-oj
   ```
2. 确认无非赛事的后台批量重测（`low` 队列）或全量索引重建占用资源；开启值守群告警静默解除，确认值班人员拥有 `/opt/neuro-oj` 与 `/srv/noj-judge` 的 SSH 及 GPG 口令访问权限。

---

## 三、赛时异常处置 SOP

赛时发现异常时，严格按 **“先止血观测 → 再降级/扩容 → 最后决策回滚”** 的梯度处置，避免盲目重启导致在途评测状态撕裂。

### 场景 A：队列严重堆积（`NojQueueBacklogWarning` / `NojQueueBacklogCritical`）

1. **确认瓶颈归属**：
   - 查看状态与日志：`noj-cli status --dir /opt/neuro-oj`、`noj-cli logs core --tail 200`、`noj-cli judge logs --dir /srv/noj-judge --tail 200`。
   - 检查 Redis 队列与消费者：`NojResultConsumerDown` 或 `NojResultQueueBacklog` 触发时，优先排查 Core 与 PostgreSQL 写入锁/连接池。
2. **削峰与降级止血**：
   - 立即暂停管理员触发的非必要批量重测与赛后重测，确保 `high`（进行中竞赛）优先占用 `4:2:1` 配额；
   - 若某道题目出现恶意死循环或超大评测包阻塞槽位，结合 `NojStaleJudging`（`>600s`）与管理后台下线/限流异常账号（参见 [竞赛代码相似度与风控](./contest-similarity.md)）。
3. **动态扩展 Judge Worker / 调整并发**：
   - **优先方案（无状态水平扩容）**：在新评测节点使用 `noj-cli judge install` 加入同一 `REDIS_URL` 与 `JUDGE_QUEUE`，立即分担消费压力；
   - **调整既有节点本地并发**：先执行 `noj-cli judge stop --dir /srv/noj-judge` 优雅排空在途任务，更新 `.env.judge` 与 `docker-compose.judge.yml` 中的 `JUDGE_MAX_CONCURRENT_JUDGES` 后，再执行 `noj-cli judge start --dir /srv/noj-judge`（或 `noj-cli judge upgrade --dir /srv/noj-judge`）。

### 场景 B：Core / 数据库故障或升级后回归缺陷（触发 `NojApiErrorRateRecentCritical` / `NojCoreScrapeDown`）

当近期发布引入严重缺陷、无法通过热修复或扩缩容恢复时，立即启动 **一键回滚**：

1. **评估是否需要连带回滚数据快照**：
   - `noj-cli rollback` 内置**跨版本迁移安全门禁**：若检测到 `upgrade-state.json` 已开始数据库迁移（`migration_started=true`）或版本号跨越主/次版本（如 `v0.11.0 -> v0.10.6`），默认**安全拒绝**单纯回切镜像，防止旧版应用写入破坏新版库表。
2. **决策分支**：
   - **分支 1：确定存在不可逆库表变更，或已发生数据污染（推荐带快照回滚）**
     ```bash
     # 先用 --dry-run 核对将要执行的停机、回切与快照恢复计划
     noj-cli rollback --dir /opt/neuro-oj \
       --to <目标版本> \
       --restore-backup /opt/neuro-oj/backups/snapshot-<ts>.nojbackup \
       --dry-run

     # 确认无误后正式执行：前置校验 → 排空服务 → 停机 → 回切配置与文件 → 恢复数据 → 启动并退出维护
     noj-cli rollback --dir /opt/neuro-oj \
       --to <目标版本> \
       --restore-backup /opt/neuro-oj/backups/snapshot-<ts>.nojbackup
     ```
   - **分支 2：确认本次变更向后兼容数据库 schema（纯代码回退，不丢赛时新增提交）**
     ```bash
     noj-cli rollback --dir /opt/neuro-oj \
       --to <目标版本> \
       --force-app-only
     ```
3. **回滚后验证**：
   - 执行 `noj-cli status --dir /opt/neuro-oj` 与 `noj-cli maintain status` 确认服务全部 `Up` 且已退出维护模式；
   - 若因异常中断导致服务停留在维护模式，执行 `noj-cli maintain exit` 恢复写请求；
   - 配合 `chaos-drain-verify.ts --live` 核对 Redis `processing` / `waiting` 状态正常收敛，随后同步回滚独立 Judge Worker 版本（编辑 `.env.judge` 或使用对应版本镜像重启）。

### 场景 C：磁盘压力告警（`NojJudgeWorkDirPressure` / `NojHostDiskLow`）

1. 检查占用来源：`noj-cli status --dir /opt/neuro-oj` 查看安装分区与 Docker 数据分区余量；
2. 清理过期容器缓存与旧备份：`noj-cli backup prune --dir /opt/neuro-oj --keep 5 --confirm`（先不加 `--confirm` 预演确认待删列表），并在 Judge 节点清理悬空镜像与退出残留容器。

---

## 四、赛后复盘模板

每场公开线上赛或大型模拟赛结束后 24 小时内，由值守负责人填写以下复盘记录并归档：

```markdown
# 赛事技术复盘：<比赛名称 / 日期>

## 1. 基本信息
- **部署版本**：`NOJ_VERSION=<tag>` / Judge `<tag>`
- **参赛规模**：注册人数 `<N>` / 峰值并发 `<M>` / 总提交量 `<K>`（AI `<x>` / OI `<y>`）
- **演练与压测基线对比**：`contest-load-test` 预估 P95 `<ms>` vs 赛时实测 P95 `<ms>`

## 2. SLO 与告警触发汇总
| 指标 / 告警名 | 赛前目标 | 赛时峰值 / 触发次数 | 持续时长 | 处置措施 |
| --- | --- | --- | --- | --- |
| API 可用性 (`NojSloApiAvailability*`) | ≥ 99.5% | | | |
| 端到端评测延迟 P95 / P99 | ≤ 15s / 30s | | | |
| 队列积压 (`NojQueueBacklog*`) | < 100 | | | |
| Judge 在线与资源水位 | 0 掉线 / CPU < 85% | | | |

## 3. 异常时间线（如无异常写“全程零故障”）
- `HH:MM`：现象与触发告警
- `HH:MM`：定位根因与采取措施（削峰 / 扩容 / `noj-cli rollback`）
- `HH:MM`：恢复与业务校验完成

## 4. 赛后一致性核对
- [ ] `noj-cli maintain status` 确认非维护态，队列全部归零
- [ ] `chaos-drain-verify.ts --live` 确认 Redis `pending=0`、`processing=0`、`waiting=0`
- [ ] 完成赛后全量备份 `noj-cli backup create` 与校验 `backup verify --deep`
- [ ] 榜单冻结/解封与代码相似度复核已按 [竞赛代码相似度SOP](./contest-similarity.md) 收口

## 5. 改进项（Action Items）
| 编号 | 问题描述 | 改进方案 | 负责人 | 截止时间 |
| --- | --- | --- | --- | --- |
| AI-1 | | | | |
```
