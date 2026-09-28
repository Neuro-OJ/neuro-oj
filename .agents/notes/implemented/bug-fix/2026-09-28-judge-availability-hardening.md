# Agent Note: noj-judge 可用性加固（注入内存峰值、注入写超时、重投方向、崩溃后 claim 回收、优雅关闭窗口）

Status: implemented

## Problem

2026-09-28/29 的公开赛开赛前无人值守审计（面 1.1「评测机被卡」）对 `noj-judge`
做了一次**二次审计**（对 9-28 已合入的 VULN-01..22 做绕过尝试 + 漏网搜索），并由
另一名 verifier subagent 做对抗性证伪复核。确认出 5 处可用性缺陷：

1. **注入路径的堆内存被"条目 + tar"双份放大（NOJ-A1，Critical）**。
   `extract_zip_entries_from_file` 把 zip 全部条目读进 `Vec<ZipEntry>`（上限 1000 条目 /
   64MiB 单文件 / 512MiB 总解压），`build_tar_archive` 再在堆上构造**等长** tar，
   随后整块 `write_all`。即：512MiB 上限实际对应 ≈1GiB 峰值（tar 缓冲的几何翻倍
   还会在扩容瞬间再多占一份）。verifier 实测压缩比 **1030:1**（0.5MiB 上传 → 512MiB
   解压），而 core 侧 artifact 上限是**压缩体积** 2GiB 且两侧无任何不变量校验 →
   `artifact_max_size_mb` 默认 null 时，任何登录用户的一次 artifact 提交即可把 judge
   进程 RSS 推到 `JUDGE_MEM_LIMIT`（默认 2g）：单个任务略低于上限，而
   `JUDGE_MAX_CONCURRENT_JUDGES` 默认 2，两个写入窗口重叠即 OOM-kill **整个 worker**，
   该 worker 上**其他用户**的在飞评测一起变成 SystemError。
   （审计初稿把后果写为"单次提交必杀"，verifier 证伪了这一点并修正为"并发叠加"；
   同时纠正了初稿"WORK_DIR 是 tmpfs"的错误——它其实是命名卷 `judge-cache`。）

2. **批量注入的写路径完全没有超时（NOJ-A2，High）**。9-28 的 VULN-16 只给**帧转发**
   写加了 3s 上限（`dual/pipe.rs`），而 `sandbox/container.rs` 里这条**更大**（512MiB 级）
   的注入写是同一根因下的未加固点。它发生在任何评测总超时（启动 30s / 题目
   `time_limit_ms` / 调用级 `call_timeout_ms`）**之前**——那些时限都在 `run_dual_loop`
   内消费。bollard 的 120s 连接超时只包住"读到响应头"，对 hijack 后的流不生效。
   对端停止读取 stdin（内核管道缓冲约 64KB 写满）即永久挂起 → 该任务永久占住一个
   全局 semaphore permit，`max_concurrent_judges` 次后本 worker **停止消费队列**。

3. **活跃用户任务重投的方向反了（NOJ-A7）**。入队是 core 的 `LPUSH`（队头=最新），
   消费是 judge 的 `RPOPLPUSH`（从**右端**取最旧）→ FIFO。而 `REQUEUE_SCRIPT` 用
   `RPUSH`——与消费端**同端**，重投的消息立刻又成为下一个弹出候选。"同一用户已有
   评测在跑就让给别的用户"的退避意图完全失效，退化成每 100ms 一轮"取回-比较-重投"
   的空转（每轮还新建一条 Redis 连接）。

4. **崩溃后 per-user claim 无人回收，把一次崩溃放大成 1 小时不可用（NOJ-D2，中）**。
   跨 worker 公平调度的 claim 在 `ActiveUserGuard::drop` 里释放，但 worker 被
   OOM-kill / SIGKILL 时 Drop 来不及执行，claim 会一直存活到 `JUDGE_USER_CLAIM_TTL_MS`
   （默认 3600s）。这期间该用户的**所有**提交都被判为"已有活跃评测"而被无限重投
   （叠加第 3 条的连接 churn）。而崩溃往往由**别的**用户触发（见第 1 条），受害者无辜。

5. **优雅关闭窗口小于 drain 上限，生产上 drain 永远跑不到（NOJ-D3，中）**。
   `drain_timeout_secs()` = `max(30, SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT + 30)`（默认 90s），
   drain 之后还有一次 15s 有界的兜底容器清扫；而 `docker-compose.prod.yml` 的 judge
   服务**没有** `stop_grace_period`，Docker 默认 10s 即 SIGKILL。于是每次
   `restart` / 升级 / `noj-cli restart` 都退化为硬杀：在飞评测被中断（只能靠 sweeper
   10 分钟后重投）且兜底清扫来不及执行。
   （审计初稿把这一族问题归因于"不可取消点导致孤儿容器"，verifier 指出归因错了——
   兜底清扫存在且有界，真正缺的是给它时间。）

verifier 同时**证伪**了 1 条 finding（NOJ-A3：`FuturesUnordered` 长度被 semaphore
permit 数封顶，不会无界增长）与 3 条 finding 的后果表述（A4 无可达来源、A8 有重启
自重愈、A10 后果是"结果被覆盖为 error 终态"而非"丢失"），假阳性率 1/10。

## Decision

只修"能被单个参赛者触发且影响他人"或"把一次故障放大成长时间不可用"的项，逐条带
before/after 证据：

1. **NOJ-A1：注入 tar 构造改为按值消费 + 精确增长**。
   新增 `build_tar_archive_consuming(Vec<ZipEntry>)`：逐条 `mem::take` 走数据、追加后
   立即释放，配合 `ChunkedVec`（按 `TAR_GROWTH_CHUNK` 精确 `reserve_exact`，不做几何
   翻倍），使峰值回落到 ≈max(tar 总量, 单条目最大值)。生产入口统一走
   `inject_zip_entries_to_container`（支持包与 artifact 两条路径都改），
   `dual::inject_support_package_to_evaluator` 改为按值传递条目。
   为让回归测试测的就是生产路径，tar 构造抽成 `build_injection_tar`。
   实测（24MiB 载荷）：**借用路径 60,820,125 B → 生产注入路径 30,404,441 B，降幅 50.0%**；
   把 `build_injection_tar` 改回借用版则该测试立即失败（反向验证）。

2. **NOJ-A2：注入路径每个阻塞调用都加本地超时**。
   `INJECT_CREATE_EXEC_TIMEOUT` / `INJECT_EXEC_START_TIMEOUT` = 10s、
   `INJECT_WRITE_TIMEOUT` = 60s（512MiB 通常数秒完成，10× 余量）、
   `INJECT_INSPECT_TIMEOUT` = 5s；新增 `write_all_with_timeout` 供写入与 `shutdown`
   共用。反向验证：把超时换成裸 `write_all` 后，回归测试 `timeout 30` 强杀（退出码
   124、无 `test result` 行）——即缺陷形态"永久挂起"。

3. **NOJ-A7：`REQUEUE_SCRIPT` 的 `RPUSH` 改 `LPUSH`**（放回队头 = 最后才被服务），
   并在脚本上方写明"方向必须与消费端相反"的约定。新增 `tests/requeue_redis.rs`
   以 **Redis 真实语义**断言"重投的任务不得被立刻重新消费"；改回 `RPUSH` 该用例失败。

4. **NOJ-D2：启动期回收本实例遗留 claim**（`user_claim::purge_instance_claims`）。
   用 `SCAN`（非 `KEYS`）遍历 `{prefix}:active_users:*`，只删 member 前缀为
   `{instance_id}:` 的成员；启动时本实例不可能有在跑评测，故安全且不误删其他实例的
   claim。`main.rs` 在建立 claim 连接后调用并记录清除条数（失败仅告警，TTL 仍兜底）。
   新增 Redis 集成用例断言"只清本实例、保留同伴实例"。

5. **NOJ-D3：prod compose 显式给足关闭窗口**。
   judge 服务新增 `stop_grace_period: ${JUDGE_STOP_GRACE_PERIOD:-120s}`（≥ drain 90s +
   兜底清扫 15s），并加入 `.env.prod.example`（含"若调大下载超时需同步调大"的说明）。

## Alternatives considered

- **NOJ-A1 改为真正流式（边读 zip 边写 tar 到 stdin）**：内存可再降到 ≈条目级别以下，
  且同时消掉 A2 的写放大。但它要重做错误语义（流中失败时容器内已有部分文件）、引入
  sync→async 桥接，属协议级改造；本轮先做"少花一半内存"的最小改动并把它列为独立设计项。
- **NOJ-A1 只在 judge 侧调小解压上限**：会误伤合法的多文件支持包（现有
  `MAX_TOTAL_SIZE=512MiB` 是题目侧约定），且没有解决"条目 + tar"双份驻留这个根因。
- **给 judge 加统一的 inflight 输入内存预算令牌**：方向正确（judge 只对容器设了限额，
  对自己没有内部预算），但属新增机制，超出本次修复预算；已记入待人工裁决清单。
- **NOJ-A2 超时后直接杀评测**：与 9-28 对 VULN-16 的取舍一致——不区分"对端已死"与
  "临时拥塞"会放大误判，因此仍是"超时即失败返回、按协议异常收尾"。
- **NOJ-D2 改为把 claim 与任务心跳绑定**：更精确（能在运行期回收），但要改 claim 数据
  结构与心跳协议；启动期前缀回收已覆盖"崩溃/强杀/断电"这一主要来源，成本极低。
- **NOJ-A7 改为给重投加显式退避计数**：治标（仍是同端重弹，只是弹得慢些）；改方向
  才是恢复"放回队尾"的本意，一行改动。
- **NOJ-D3 改为把 drain 上限压到 10s 以内**：会让长支持包下载被硬切断，牺牲正确性换
  关闭速度；不如给足窗口。

## Consequences

- 注入路径峰值内存减半，默认并发（2）下从"贴着 `JUDGE_MEM_LIMIT` 2g"回到约 1.0GiB，
  单人单次提交不再能 OOM 掉 worker；但**并未**解决 D1（core 侧按压缩体积限额、judge 侧
  按解压体积限额，两者无不变量校验）——已在待人工清单中要求：要么 core 按题目声明解压
  后上限，要么 judge 加 inflight 输入预算。
- 注入阶段任何阻塞都有上限：`create_exec`/`start_exec`/写/shutdown/inspect 各自失败
  返回并让任务走异常收尾，槽位不再可能被永久占住。
- 公平调度的"让给其他用户"恢复为真正的退避：被重投的任务回到队尾，不再每 100ms 空转
  重弹（也顺带减少每轮新建 Redis 连接的 churn）。
- worker 崩溃后其遗留 claim 在**下次启动**即被回收，不再是该用户最长 1 小时的不可评测
  窗口；多副本（`--scale judge=N`）下各副本若**未**显式设置唯一 `JUDGE_INSTANCE_ID`，
  仍会共享实例 ID（NOJ-A10 未修：此时启动清扫会互删在跑容器）。该约束已在
  `noj-judge/AGENTS.md` 标注，本轮未改变——生产单副本默认拓扑不受影响。
- 生产 `docker compose down/restart` 现在会给 judge 最多 120s 完成 drain 与兜底清扫；
  若把 `SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT` 调大（如 300s），必须同步调大
  `JUDGE_STOP_GRACE_PERIOD`（否则回到"10s 硬杀"的老行为）。
- 未修并明确记录的低危项：NOJ-A6（self_test 恢复路径漏 `user_id` → 空串共享同一 claim
  key，导致吞吐退化；有 4 次/60s/用户 的创建限流托底，未证"饿死"）、NOJ-A8
  （`create_container` 客户端超时窗口内的孤儿容器，靠下次启动标签清扫自愈）、
  NOJ-A9（死信列表无上限，仅卫生项）。
- `noj-judge/src/lib.rs` 新增 `pub mod mq;`（与既有"把仅二进制模块暴露给集成测试"的
  用途一致），使重投方向可以在集成测试里用真实 Redis 验证。

## 覆盖声明（诚实记录）

本轮无人值守窗口（2026-09-28 22:00 → 09-29 07:00）**只完成了面 1.1**：其审计、对抗性
复核、5 项修复与成对证据齐备。面 1.2（沙箱与容器逃逸）、1.3（生产拓扑隔离）、1.4（core
数据泄露）、1.5（core 赛时公平性）与第二阶段六面**均未开始**。原因是会话在夜间被挂起，
恢复时已越过 07:00 硬停——详见
`dev-docs/unattended/2026-09-28/final-report.md`。
