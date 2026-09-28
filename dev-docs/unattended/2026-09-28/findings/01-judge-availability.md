# 面 1.1 — noj-judge 可用性（评测机被卡）审计报告

> 审计面：noj-judge 可用性（评测机被卡） ｜ 类型：II 二次审计 ｜ 派发时间：2026-09-28 22:02 ｜ 返回时间：2026-09-28 22:07
> 审计员：subagent（只读：仅 rg/read，未执行写操作、未运行 docker/cargo）
> Lead 复核：见 `../verification/01-judge-availability.md`
> 审计基线：`4356fe181`（noj-judge v0.10.2-alpha.1）

## Findings

| id | 严重度 | 位置 file:line | 触发路径 / 最小 PoC（含构造输入） | 影响面 | 与上一轮关系 | 复核建议 |
|---|---|---|---|---|---|---|
| NOJ-A1 | **Critical** | `noj-judge/src/dual/mod.rs:187-218`、`noj-judge/src/sandbox/container.rs:95-99`、`:152-169`、`:176-210` | 参赛者提交 artifact zip：`extract_zip_entries_from_file()` 把**全部解压内容**读进 `Vec<ZipEntry>`（上限 1000 条目/64MiB 单文件/512MiB 总解压，`container.rs:18-22`），紧接着 `build_tar_archive()` 再在堆上构造**等长 tar**，随后整块 `write_all`。最小 PoC：≈900KB 的 zip（1000 条目，每条约 900KB 的 `b'\0'` 高压缩比内容）→ 解压 900MiB → 同一任务堆占用 ≈1.8GiB | 单个参赛者**单次提交**即可触发（artifact 上传仅 2GB 硬上限，`noj-core/.../artifact-submissions.ts:150-205`）。judge 容器 `mem_limit` 默认 2g（`docker-compose.prod.yml:180`）、`WORK_DIR: /tmp/noj-judge` 位于容器 tmpfs（`docker-compose.prod.yml:242-243`）→ OOM-kill **整个 worker 进程**：本 worker 上**所有用户**的在飞评测被中断（单副本部署即全局中断），在飞容器成为孤儿，任务滞留 processing 直到 core sweeper 重投（≥10 分钟） | **新发现**（上一轮 VULN-19 未修；下载链路已改流式落盘 `download.rs:9`，但**解压+注入链路仍是"全量驻留堆"**，且被 tar 二次放大） | ① 实测：提交上述 zip，`docker stats` 观察 judge 容器内存与 OOM 计数；② 修复方向：judge 侧对支持包/artifact 解压设更小硬上限（如 128MiB）**或**改为单遍流式（边读 zip 条目边写 tar，不落 `Vec<ZipEntry>`+`Vec<u8>` 双份） |
| NOJ-A2 | **High**（"挂起"环节需实测确认） | `noj-judge/src/sandbox/container.rs:208`（`input.write_all(&tar_buf).await`）、`:205`（`docker.start_exec(...).await`） | 同一批量注入路径的 `write_all` **无任何超时**，且不在任何 `tokio::time::timeout` 内（`inject_files_to_container` 全文无 timeout；`dual/mod.rs:331-417` 的 evaluation 块也无任务级超时）。PoC 方向：artifact 解压后总大小 ≈600MiB，容器 `/workspace` tmpfs 仅 512M（`dual/container.rs:32-37`）→ 容器内 `tar xf -` 写满后停读/退出，judge 侧对端不再消费 stdin；若该 await 挂起，则**总超时、启动 30s 时限、调用级超时全部不生效**（都在 `run_dual_loop` 内，此时尚未进入），槽位被永久占用 | 单个参赛者单次提交（构造输入同 A1，尺寸调至 512MiB 量级）；后果：该 worker 每个被卡任务永久吃掉 1 个全局 semaphore permit（`main.rs:164,270,386`），`max_concurrent_judges` 次提交后本 worker **停止消费队列**（`main.rs:270` 阻塞在 `acquire_owned()`），无自身 watchdog 可恢复 → 队列整体停摆 | **已修仍可绕过（同类不同点）**：上一轮 VULN-16 只加固了**帧转发**写（`dual/pipe.rs:88-118`，`PIPE_WRITE_TIMEOUT=3s`），bulk 注入写是同一根因下的**未加固点**（payload 由参赛者控制，可达 512MiB） | ① 用 E2E 复现：注入 >512MiB artifact，观察 `write_all` 是否挂在 timeout 之外；② 修复：给注入写加超时 + 给 `evaluate_with_cpu_limit` 整体加任务级硬超时兜底 |
| NOJ-A3 | **Medium** | `noj-judge/src/main.rs:438-442`（`tasks.next().now_or_never()`）、`:264-279`、`:375-386` | `FuturesUnordered` 只在「成功拿到 permit 且成功走完一次拉取」后才被轮询；并发满员时主循环阻塞在 `semaphore.acquire_owned()`，已完成任务的 `JoinHandle` 只增不减（panic 日志几乎永不打印）。叠加：**全流程无任务级超时/watchdog**——所有时限都依赖「已进入 `run_dual_loop`」，容器准备/注入阶段任一 await 挂起都无兜底 | 与 A2 同一后果链（permit 永久持有 → worker 停摆）；本项自身为可观测性/内存卫生缺陷 | **新发现**（A2/VULN-16 的放大条件） | 把 `tasks` 回收移到 select 独立分支或每轮无条件排空；给每个评测任务套 `tokio::time::timeout(总上限 + 余量)` 兜底 |
| NOJ-A4 | **Medium** | `noj-judge/src/runner.rs:73`、`:103`（`return Err(e)`）、`noj-judge/src/sandbox/download.rs:311-321` | 支持包获取/校验失败时**整任务早退**为 SystemError；而 core 侧 checksum 是**可选参数**：`buildStorageUrl(..., checksumSha256?)`（`noj-core/.../storage/types.ts:214-224`）、`buildS3DownloadUrl(presigned, checksumSha256?)`（`:328-333`）、`buildLocalDownloadUrl(path, checksumSha256?)`（`:310-315`）均为 optional，judge 侧却把「缺失/为空」当硬失败。构造输入：任何 `download_url` 中**不含** `checksum_sha256` 的任务 → 该题**每次提交**都是 SystemError（0 分） | 需前置条件（checksum 未写入的存量/异常数据）；一旦命中是**该题全体参赛者**失分（可用性事故，非攻击者得利） | **新发现（VULN-18 的副作用）**：修掉"静默放行"同时引入"无 checksum 即全题失败"，该不变量两侧不对称 | ① 核实：现有 upload 调用点均传 checksum（`local.ts:141,208`；`s3.ts:107,217` 已确认），当前数据应安全；② 建议：judge 侧对「URL 未携带 checksum」单独告警并保留大小/格式校验路径，或 storage 层把 checksum 改为必填 |
| NOJ-A5 | **Medium** | `noj-judge/src/drain.rs:13`、`:101-103` | 受处理的依赖库不可取消：`join_all(tasks)` 在 `ABORT_JOIN_TIMEOUT_SECS=5s` 后放弃等待。若任务停在不可取消点（A2 的 `write_all` 即典型：`AsyncWrite` 流式写入在 `select!` 中不会被 abort 立即抢占；`Docker::connect_with_unix(..,120,..)` 的 client timeout 对 hijack/流式连接不生效）→ drain 超时并被 SIGKILL 强杀 | 关闭/重启阶段（SIGTERM→drain→强杀）不确定；优雅关闭退化为硬退出，in-flight 结果不推送（不 ACK，靠 sweeper 重投），并在 `POST_DRAIN` 兜底清扫之前被强杀 → 孤儿容器。**不能由参赛者触发** | **审过但上一轮未列为 finding**：VULN-15 的 15s 有界清扫覆盖了容器，未覆盖"任务是否真的停止" | 实测 `drain_tasks`（需 Docker）：连发 SIGTERM 观察是否有容器残留 |
| NOJ-A6 | **Low-Medium** | `noj-judge/src/main.rs:311-312`（`user_claim::claim_member`）、`noj-judge/src/user_claim.rs:67-112`；空 `user_id` 来源：`noj-core/src/domains/submission/mq/sweeper.ts:284`（`user_id: row.user_id ?? ""`） | 同一 `user_id` 的任務串行化（设计如此）。**特例**：`user_id` 为空串时，**所有**空 user_id 任务共享同一把 claim key（`{prefix}:active_users:`）。PoC：一条 `user_id:""` 的坏/恢复任务进入评测 → 占用后其余空 user_id 任务被无限重投（`main.rs:337-350`） | 触发需 `user_id` 缺失（sweeper 恢复路径会产生 `""`）；后果是这些任务互相饿死（长期不评测），并放大 A7 的重投流量 | **新发现** | judge 侧对空 `user_id` 直接判坏消息走死信；core sweeper 侧禁止写入空 user_id |
| NOJ-A7 | **Low-Medium** | `noj-judge/src/main.rs:337-350`、`noj-judge/src/mq.rs:158-179` | 公平调度用「放回**同一队列队尾** + 100ms 睡眠」退避。PoC：参赛者洪水式提交同一用户大量 submission，其中 1 个在跑 → worker 每 100ms "取回-比较-重投"一条，`requeue_task`/`ack_task` 每次新建连接（`mq.rs:159-162`、`:185`，无复用/池）→ Redis 连接抖动面扩大；同时持续占用 1 个 semaphore permit | 单个参赛者可控（其自身提交即可）；后果是放大 Redis 与 worker 调度开销、挤占他人槽位入场机会；不构成整体停摆 | **新发现**（跨 worker claim 已修，但退避/重投路径未做预算） | ① requeue 路径加指数退避/权威计数；② `requeue_task`/`ack_task` 复用 `MultiplexedConnection` |
| NOJ-A8 | **Low** | `noj-judge/src/dual/container.rs:272-288`、`noj-judge/src/sandbox/cleanup.rs:108-114` | Docker API 调用被客户端超时**中止但服务端已生效**：`create_container` 30s 超时后不持有容器 ID → 该容器永不被本任务 `destroy()`；`start_container` 5s 超时路径会 `remove_container_force`（已覆盖）；`list_containers`（`cleanup.rs:108`）无本地超时 | 需 Docker daemon 变慢/异常（公开赛洪峰下现实存在）；`sleep infinity` 孤儿容器累积，只有 judge **重启**时才被实例标签清扫 | **新发现**（VULN-15 固定了"重启后能清"，未处理"重启前持续泄漏"） | 心跳已有孤儿计数（`metrics.rs:152-169`），建议加阈值告警；`create_container` 超时路径按实例标签尽力反查清理 |
| NOJ-A9 | **Low** | `noj-judge/src/mq.rs:52-61`、`:378-392` | 坏消息（反序列化失败）写入 `<queue>:dead`（`LPUSH`，无上限）——仅当上游产出非法 JSON 时增长；当前 producer 由 `JSON.stringify(buildJudgeTask(...))` 生成，正常不命中 | 需上游写入非法消息；累积量受唯一坏消息数限制，不构成可用性风险 | **审过无问题（卫生项）** | 可选：死信列表加上限/告警 |
| NOJ-A10 | **Low** | `noj-judge/src/config.rs:229-265`（`resolve_instance_id`）、`noj-judge/src/sandbox/cleanup.rs:101-131` | 多副本共享 `WORK_DIR` 且未设 `JUDGE_INSTANCE_ID` 时，级联**故意**收敛到同一实例 ID；副本 B 启动即 `cleanup_orphan_containers(instance_id)` → **强删副本 A 正在评测的容器**（`:117-126`，无"是否在飞"判据）→ A 评测 SystemError，A 完成任务后 ACK（`main.rs:424-425`）→ 结果丢失、提交滞留至 sweeper ≥10 分钟后重投 | 需多副本**且**共享卷（当前 `docker-compose.prod.yml:206-243` 为单副本固定容器名，**不成立**；`--scale judge=N` 时 compose 无法为副本分配独立命名卷，会命中）；后果为"部分评测被同伴误杀"，可恢复降级 | **上轮"已知多副本约束"成立，未修** | 复现：`docker compose up --scale judge=2` 后对 A 发起长评测、同时重启 B；修复：启动清扫增加"在飞/最近创建"判据，或未显式设置时自动派生含容器标识的实例 ID |

**A1 的补充（内存账本）**：解压上限三件套（1000 条目 / 64MiB / 512MiB，`sandbox/container.rs:18-22`）只约束**单份**解压物，未约束"解压物 + tar 副本"合计；而 `/tmp`（WORK_DIR）在容器内是 tmpfs（`docker-compose.prod.yml:243`），zip 落盘也吃同一 cgroup 内存。故单次提交峰值 ≈ `zip 落盘` + `512MiB 条目` + `512MiB tar`。对照面：**输出侧已加固**（`MAX_OUTPUT_BYTES=1MiB` + `append_capped`，`dual/mod.rs:47-49,165-181`；`LineParser` 4MiB 上限，`protocol.rs:57-101`），**输入侧（支持包/artifact 注入）未加固**。

---

## ① 已审但未发现问题的子面（附检索证据）

| 子面 | 检索词（rg，均在 `noj-judge/`） | 命中情况与结论 |
|---|---|---|
| Redis 消费者组 / 未 ACK 挂死 | `xgroup|xreadgroup|consumer_group|XREAD` | **0 命中**（judge 用 list + `BRPOPLPUSH` + `LREM` ACK，`mq.rs:78-116`、`:184-203`），不存在 PEL/消费者组挂死面 |
| 进程内锁与死锁 | `flock|FileLock|lock\(\)\.await|Mutex|RwLock|OnceLock|OnceCell` | 命中仅 `sandbox/cache.rs`（按目录共享 async 锁）、`config.rs`/`logging.rs`（OnceLock 初始化）、`user_claim.rs`（注释）。无跨 await 持有的 std 锁；`CACHE_LOCKS` poisoning 已兜底（`cache.rs:29-32`）。**未发现锁导致的槽位挂死** |
| 线程/阻塞调用泄漏 | `std::thread|thread::spawn|JoinHandle|spawn_blocking`；`Blocking|block_on|\.wait\(\)` | 仅 `spawn_blocking`（zip 解压/缓存 atime，`dual/mod.rs:194`、`cache.rs:290`）与 `main.rs:89` 一处 `block_on`、`drain.rs` 的 JoinHandle 管理。无自建线程。注：`spawn_blocking` 不可取消（A5 背景） |
| 信号处理面 | `signal\(` | 仅 `main.rs:239-252`：SIGTERM + ctrl_c 双通道 + oneshot。**未发现漏注册信号**（若注册失败 `expect` panic 在该 spawn 任务内 → 关闭通道永不触发，属 A5 同族加固项） |
| Docker API 超时覆盖 | 逐个 `docker.` 调用点 + `timeout\(` 全量列举 | 已有：创建容器 30s（`dual/container.rs:272`）、start 5s（`:278`）、create_exec 10s（`:197`）、rm -f 10s×3（`cleanup.rs:56`）、stats 3s（`dual/mod.rs:235`）、drain 兜底 15s（`drain.rs:16,32`）。**缺口**：`start_exec`（`container.rs:205`）、hijack 后 `write_all`（`:208`）、`inspect_exec`（`:215`）、日志流 `chunk()`、`list_containers`（`cleanup.rs:108`）——即 A2/A3/A8 |
| 内存上限 / OOM（容器侧） | `memory_limit_mb|memory_bytes|memory_swap|pids_limit|cap_drop|no-new-privileges|tmpfs` | 已收敛：内存 `min(4096)` + 0→512（`dual/container.rs:243-249`；`dual/mod.rs:134-136`）、`memory_swap = memory`、`swappiness 0`、`pids_limit 256`、`cap_drop ALL`、`no-new-privileges`、`/tmp 256M` + `/workspace 512M` + `noexec,nosuid,nodev`（`host_config.rs:22-53`、`dual/container.rs:32-37`）。**未发现容器侧限制绕过**（本篇问题都在 judge 自身进程内存，见 A1） |
| ZIP 路径穿越 / 解压炸弹 | `\.\.|is_absolute|MAX_ZIP_ENTRIES|MAX_FILE_SIZE|MAX_TOTAL_SIZE|重复` | 三重校验齐备且互相独立：解压侧（`container.rs:69-73,88-91,95-117`）、注入侧（`validate_entry_name`，`:132-146`）、tar 侧（`build_tar_archive` 逐条校验，`:152-169`）。限额按**实际读取字节**判定而非声明大小（`:93-99`）。**未发现绕过** |
| 队列背压 / 容量原子性 | `QUEUE_CAPACITY_SCRIPT|LLEN|LPUSH|EXPIRE` | core 侧 Lua 原子容量检查（`producer.ts:34-98`，high/medium/low=5000/10000/20000，消息≤16MB）；judge 侧只 `RPUSH` 队尾（`mq.rs:150-156`）不会撑破容量；主队列**无 TTL**（`producer.ts:100-101` 有注释）。**未发现问题** |
| 幂等 / 重复消费 | `submission_id \+ rejudge_seq|幂等|dedup` | judge 侧显式不去重（`mq.rs:205-212` 注释），由 core 以 `submission_id + rejudge_seq` 吸收；sweeper 重投是 at-least-once（`mq.rs:181-183`）。语义自洽，**未发现 judge 侧可自造的重复消费** |
| 用户并发/公平调度语义 | `try_claim_user|ZREMRANGEBYSCORE|PEXPIRE|TIME` | Lua 单脚本原子（清理过期+判定+占用），时间戳取 **Redis 服务端**（`user_claim.rs:86-97`）、`ZCOUNT` 只读诊断（`:144-163`）、启动期 TTL 不变量校验（`main.rs:208-231`）。**设计正确**（缺口仅空 user_id 与退避，见 A6/A7） |
| 输出落库是否有界 | `MAX_OUTPUT_BYTES|append_capped|MAX_BUFFER_BYTES|truncate` | 有界：stdout/stderr 各 1MiB（`dual/mod.rs:47-49`）、行缓冲 4MiB（`protocol.rs:58`）、日志原文按字符边界截断（`mq.rs:118-132`）。**未发现无界读容器输出** |
| 支持包下载面 | `redirect|timeout|MAX_SUPPORT_PACKAGE_BYTES|checksum` | 全部**流式落盘**（base64/s3/local 三路，`download.rs:62-203`）、2GiB 上限、禁跟随重定向（`:233-234`）、强制 SHA-256（`:311-321`）、HTTPS 强制（`:146-150`）、`local` 协议告警+路径脱敏（`:177-185`）。**未发现 SSRF/落盘绕过**（除 A4 的 checksum 强绑定） |
| 容器回收（正常/崩溃/重启/信号） | `destroy|Drop|cleanup_orphan_containers|INSTANCE_LABEL` | 正常路径显式 `await destroy()`（`dual/mod.rs:419-423`）、提前返回被 async block 收口（`:327-331`）、Drop 仅 panic 兜底（`container.rs:146-175`）、启动+退出双清扫（`main.rs:145`、`:449-454`）。**VULN-15 主修复成立**（残留见 A5/A8/A10） |

---

## ② 上一轮各项逐条裁定

| 上轮项 | 裁定 | 证据 |
|---|---|---|
| **VULN-14** Solution 可发 `FRAME_SHUTDOWN`（裁定 Won't Fix） | **维持 Won't Fix（裁定仍成立）** | solution 帧经 `handle_sol_chunk` 的 `FRAME_LOG/FRAME_SHUTDOWN` 分支转发给 evaluator（`dual/mod.rs:1059-1064`）→ evaluator reader 线程 `runner.py:162-164` 置 `self._closed = True` → 只影响**本容器对本提交**的后续调用（`runner.py:75-76`）。跨容器/跨提交影响面**不存在**：每任务独立 evaluator+solution（`dual/container.rs:79-126`），无共享状态/卷/网络；唯一跨任务共享物是 Redis 队列/claim（solution 容器内无 Redis 访问） |
| **VULN-15** 孤儿容器清扫失效 | **维持已修**（主修复成立）；**残留两处** → A8、A10 | 确定性级联（`config.rs:229-265`）+ SHA-256 前 12 hex（`:148-158`）+ 纯度校验（`:161-171`，测试 `:614-742`）；双标签（`container.rs:43-55`）；清扫只用实例标签（`cleanup.rs:31-38,101-131`）；提前返回走显式 `destroy()`（`dual/mod.rs:327-423`）；Drop 兜底（`container.rs:146-175`）；退出前 15s 有界兜底（`drain.rs:26-45`） |
| **VULN-16** 写管道无超时导致编排死锁 | **部分成立：帧转发已修，同类缺陷在批量注入写路径仍可绕过** | 已修证据：`PipeWriteOutcome` + `forward_frame_with_timeout`（`pipe.rs:30-118`，3s）、`handle_*_chunk` 返回 `Result<bool>`、超时→PeerGone→收尾（`dual/mod.rs:598-608,724-736`），单测覆盖 EPIPE 与对端停读（`dual/tests.rs:704-830`）。**绕过点**：`sandbox/container.rs:208` 的 `input.write_all(&tar_buf)`（512MiB 级、无超时、在任何总超时之前）→ A2 |
| **VULN-17** 支持包逐文件 exec 注入 | **维持已修** | 单次 tar + 单次 `tar xf -`（`container.rs:171-225`），单文件薄包装（`:228-235`），tar 构造有逐字节等价回归测试（`:604-630`） |
| **VULN-18** 支持包失败静默放行 | **维持已修；但引入新副作用** | `runner.rs:63-74`、`:97-105` 已 `return Err(e)`；单测 `runner.rs:244-319`。副作用 → A4。另注：`tests/e2e_abnormal.rs:171-220` 名为 `support_package_missing_still_finished`，实际传 `None`（不经下载/校验路径），**并未覆盖**真实下载失败语义——"真实 E2E 不经过 runner"盲区仍成立 |
| **VULN-19** ZIP 全量驻留堆内存（本轮未修） | **推翻"可忽略"、升级为 Critical 可利用**（改由 artifact/注入路径承载） | `extract_zip_entries_from_file`（`container.rs:35-39`）→ `Vec<ZipEntry>`（`:119-123`）→ `build_tar_archive` 二次拷贝（`:152-169`）→ 全量 `write_all`（`:208`）。与"下载链路已流式"（`download.rs:9,62-264`）形成对照：**只有下载段改了，解压/注入段没改** |
| **已知多副本约束** | **维持"成立"，但当前部署拓扑下不可触发** | 触发条件：≥2 副本共享 `WORK_DIR` 且未设 `JUDGE_INSTANCE_ID`（当前生产 compose 单副本固定容器名，不成立；`--scale` 会命中）。后果：后启动副本强删同伴在飞容器（`cleanup.rs:117-126` 无"在飞"判据）→ 同伴 SystemError 但**仍 ACK**（`main.rs:424-425`）→ 结果丢失 + sweeper 重投。症状可观测（心跳孤儿计数 + 日志）但**无告警** |
| 盲区：`runner` 支持包失败早退只有单测 | **确认盲区仍存在**（并发现 E2E 名称误导） | `noj-judge/tests/*.rs` 中 `download_url` 仅出现在契约测试（`judge_task_contract.rs:41`）与 `None` 赋值（`e2e_dual_container.rs:45`）；`support_package` 仅 `e2e_abnormal.rs:171`（传 `None`）→ **无任何 E2E 走"真实支持包下载失败→任务终止"** |
| 盲区：`cleanup_containers_after_drain` 无 E2E | **确认盲区仍存在** | `cleanup_containers_after_drain|drain_tasks` 在 `src/drain.rs` 之外**无测试引用**；`drain.rs:107-154` 只有 4 个合成任务单测 |

---

## ③ 需要人工裁决的设计级问题（非 finding）

1. **judge 进程自身是否应受内部预算保护**：A1/A2/A3 的根因都是"judge 进程内存与容器内存同池，而 judge 只对**容器**设了限额、对自己没有内部预算"。修 A1 只需给解压加更小上限，但"评测输入/输出在 judge 内存中的预算"应作为设计决策：是否引入统一的 `JUDGE_MAX_INFLIGHT_INPUT_BYTES` 令牌（每次注入/解压前申请，跨任务全局受限），而不是逐路径打补丁。
2. **artifact 注入协议是否改为流式**：当前"解压到内存→构造 tar→写 stdin"是为了复用单次 exec（VULN-17 的收益）。改为"边读 zip 条目边写 tar"可同时解决 A1 内存放大与 A2 写放大，但需重新设计错误语义（流中失败时容器内已有部分文件）。
3. **任务级硬超时的归属**：所有时限都在 `run_dual_loop` 内，容器准备/注入段（Docker API + 注入）无兜底。是否在 `main.rs` 的 spawn 处对整个 `evaluate_with_cpu_limit` 加 `tokio::time::timeout`（代价：超时后无法保证容器回收，需与 A8 的"按实例标签反查清理"配套）——属编排契约变更，需裁决。
4. **多副本拓扑与实例标签语义**："一副本一实例标签（强制 `JUDGE_INSTANCE_ID` 或独立 WORK_DIR）" vs "实例标签代表同一逻辑部署、启动清扫需增加在飞判据"。这决定 A10 的正确修法，且影响 compose 是否要改。
5. **空 `user_id` 在评测协议中的地位**：judge 侧把它当"一个用户"，导致空 user 全员串行 + 互相饿死（A6）。是否把 `user_id` 提升为必填校验（judge 拒绝并走死信），需与 core sweeper 恢复路径（`sweeper.ts:284` 的 `?? ""`）一起改。

**本轮未能验证的部分（只读约束）**：A1（OOM 实测）、A2（`write_all` 是否挂）、A5（drain 强杀后是否有残留容器）均需 Docker E2E 与 `docker stats`/`NOJ_RUN_E2E=1` 实测确认；本报告对这三条给出代码级触发路径与机制论证，其中 A2 的"挂起"环节标注为需实测确认。
