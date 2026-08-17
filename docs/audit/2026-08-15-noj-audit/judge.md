# noj-judge 审计报告

> 基线：`main` @ `31150781` · 只读静态审查 + 对抗性复核 · 真阳性 41 条（全部经逐条代码验证）

| 严重级 | 数量 |
|---|---|
| 严重 | 1 |
| 高 | 5 |
| 中 | 15 |
| 低 | 11 |
| 信息 | 9 |

## 严重

### NOJ-179 BRPOP 无 ACK/无超时重投，judge 崩溃即永久丢失评测任务
- **位置**：`noj-judge/src/mq.rs:19-22`　**维度**：可靠性
- **描述**：任务拉取使用 BRPOP，原子弹出后即从队列移除，无 ACK、无 processing 列表、无 visibility timeout。judge 在 BRPOP 返回后、push_result_with_retry 成功前崩溃/被 kill（main.rs:97 弹出→118 spawn→153 推送之间任意点），该任务永久丢失，submission 卡在 judging 状态。对照 noj-core：producer 仅 LPUSH 一次（producer.ts:47），无任何 stuck/redeliver/超时重投机制（grep 全仓无 requeue/sweep/超时重投；queue.ts:140-162 的 judging 列表只是读 DB 状态，无兜底恢复），只有人工 rejudge 才能挽救。这是整个评测链 at-most-once 架构的根因缺陷。
- **证据**：`let result: Option<(String, String)> = conn.brpop(queue, BRPOP_TIMEOUT_SECS).await...; // 返回即已移除`
- **建议**：引入可靠投递语义：BRPOPLPUSH 到 processing:<queue> 列表，评测完成后 LREM；由 noj-core（或独立 sweeper）定时扫描 processing 列表，将超过阈值（如 10 分钟）未完成的任务重投回主队列（幂等，靠 core 的 rejudge_seq/UPSERT 兜底）。至少应在 judge 崩溃后能自动恢复，而非仅靠人工重测。
- **验证**：mq.rs:19-22 用 BRPOP 原子弹出任务即从队列移除，无 ACK/processing 列表/visibility timeout；main.rs:97 弹出→118 spawn→153 推送之间崩溃即丢任务。producer.ts:47 仅 LPUSH 一次；全仓 grep 无 requeue/sweep/超时重投（仅 docs/audit 下是审计文本本身）。services/queue.ts:140-162 的 judging 列表只读 DB status、无兜底恢复（finder 引用的 routes/queue.ts 仅 22 行，实为 services/queue.ts，引用路径小误但不影响结论）。at-most-once 根因缺陷成立，仅人工 rejudge 可救。

## 高

### NOJ-160 ---RESULT--- 标记与结果 payload 跨 chunk 丢失导致误判 SystemError
- **位置**：`noj-judge/src/dual/mod.rs:579, 582-586, 626-634`　**维度**：正确性
- **描述**：`awaiting_result_payload` 是 `handle_eval_chunk` 的函数局部变量，每次喂入一个 chunk 都被重置为 false。LineParser 只保证「半行跨 chunk 缓冲」，但标记行与结果行之间没有跨 chunk 的状态机。当 `---RESULT---\n` 恰为某个 chunk 的最后一行、而 `{"status":...}` 落在下一个 chunk 时，后者会被当作普通文本丢弃（result_payload 保持 None），最终走 finalize_outcome → SystemError（score=0）。Docker exec attach 的 stdout 分片不保证与行对齐，evaluator 的两次 print/flush 极易落在不同 LogOutput 消息中，因此这是可稳定触发的误判。现有单测 test_handle_eval_chunk_result_marker_sets_payload 把标记与 JSON 放在同一 chunk，掩盖了此缺陷。
- **证据**：`let mut awaiting_result_payload = false;  // 函数内局部，每 chunk 重置
...
EvaluatorLine::Unknown(s) => {
    append_capped(stdout_full, &s);
    if awaiting_result_payload && !s.trim().is_empty() {
        *result_payload = Some(s.trim().to_string());
        awaiting_result_payload = false;
    }
}`
- **建议**：把「等待结果 payload」状态提升为跨 chunk 的持久状态（如通过 &mut bool 传入，或把 RESULT 标记→下一行 JSON 的解析逻辑下沉到 LineParser 中统一管理），确保标记行与结果行被拆分到不同 chunk 时仍能正确捕获。补充跨 chunk 拆分的回归测试。
- **验证**：核实成立。dual/mod.rs:579 awaiting_result_payload 是 handle_eval_chunk 函数局部变量，每次喂 chunk 重置为 false；protocol.rs LineParser.feed 仅做半行跨 chunk 缓冲(见 test_feed_partial_line_buffered)，无 RESULT 标记→下一行 JSON 的跨 chunk 状态机。当 ---RESULT---\n 为 chunk1 末行、JSON 落在 chunk2 时，JSON 被当 Unknown 丢弃，result_payload 保持 None → finalize_outcome→SystemError。evaluate.py 两次独立 print/flush 极易被 docker attach 拆成不同 LogOutput，可真实触发；现有单测(994)把标记与 JSON 放同 chunk 掩盖缺陷。

### NOJ-161 成功路径丢失 rejudge_seq，重测结果被 core 静默丢弃、提交卡在 judging
- **位置**：`noj-judge/src/dual/mod.rs:725-750（关键 748）`　**维度**：正确性
- **描述**：`build_judge_result` 构造 JudgeResult 时硬编码 `rejudge_seq: None`（748 行），而它只接收 (submission_id, parsed, stderr, stdout)，未接收 rejudge_seq。evaluate.py 正常输出 ---RESULT--- 的成功路径（Accepted/WrongAnswer 等绝大多数结果）都走此函数，导致 rejudge_seq 丢失。noj-core `saveEvaluationResult` 中 `incomingSeq = result.rejudge_seq ?? 0`，重测后 submissions.rejudge_seq 已递增为 1，于是 `0 < 1` 成立 → 直接「忽略过时的评测结果」return，评测结果被丢弃、submission 永远停在 judging。仅 timeout/system_error 路径正确透传了 rejudge_seq。
- **证据**：`fn build_judge_result(submission_id: &str, parsed: &Value, stderr: &str, stdout: &str) -> JudgeResult {
    ...
    JudgeResult { submission_id: ..., status, score, output, details,
        time_ms: None, memory_kb: None, rejudge_seq: None }  // 748 行
}`
- **建议**：给 build_judge_result 增加 rejudge_seq 形参，并在调用点（run_dual_loop 的 result_payload Some 分支，约 517-522 行）传入 run_dual_loop 已持有的 rejudge_seq；保持与 timeout_result/system_error 一致。
- **验证**：属实且链条完整：build_judge_result（dual/mod.rs:725-750）硬编码 rejudge_seq:None（748），调用点 517-522 未传入，而 run_dual_loop 已持有 rejudge_seq（328 行形参，timeout/system_error 路径 540/545 均透传）。core 侧 saveEvaluationResult（submissions-result.ts:41,61-67）incomingSeq=result.rejudge_seq??0，重测后 sub.rejudge_seq 已递增为 1，0<1 成立→直接 return，结果被丢弃、submission 永久停在 judging。仅 timeout/system_error 路径正常，故重测绝大多数（Accepted/WrongAnswer 等）均命中。维持「高」。

### NOJ-190 镜像名/命令/网络全部来自消息，judge 侧零白名单复验（叠加 Redis 无认证）
- **位置**：`noj-judge/src/dual/mod.rs:155-179`　**维度**：安全
- **描述**：evaluator.image/command、solution.image、evaluator.network.enabled 与内存均直接取自 JudgeTask 消息并原样使用：parse_command(command) 得到 exec 命令（第 155 行），image 传入 create_container（第 164-177 行），network.enabled 决定 bridge/none（第 158-163 行）。judge 侧没有任何镜像白名单复验（CLAUDE.md 声称的 ensure_image_local() 在代码中并不存在，grep 无命中），也没有命令校验。白名单仅由 noj-core 在提交/建题时执行；而 noj-core 的敏感字段权限 problem:field_evaluator_command / problem:field_evaluator_network 经一次性 seed 默认授予 default user 角色（seed-rbac.ts:55-61），即普通用户默认可对自有题目设置任意 evaluator.command 并开启 network。叠加 docker-compose 中 Redis 无认证（docker-compose.yml:2-9），能访问 6379 的一方或恶意出题人都可令 judge 以 root 在容器内执行任意命令（bridge 网络时可出网/扫描内网）。
- **证据**：`let evaluator_cmd = parse_command(&runtime_config.evaluator.command);
let evaluator_network_enabled = runtime_config.evaluator.network.as_ref().map(\|n\| n.enabled).unwrap_or(false);
DualContainer::create_evaluator(&docker, &runtime_config.evaluator.image, runtime_config.evaluator.memory_limit_mb, evaluator_network_enabled)`
- **建议**：judge 侧增加镜像白名单与 kind 复验（或至少校验 image 必须匹配受信前缀）、对 evaluator.command 做可执行白名单校验，并对 network.enabled 在 judge 侧强制默认拒绝；同时对 Redis 增加认证/ACL，限制队列写入。
- **验证**：judge 侧零复验：parse_command 仅 shell 分词（container.rs:110 起，无白名单），image 直接传给 create_evaluator，network.enabled 直接决定 bridge/none（dual/mod.rs:155-169）；grep 确认 src 内不存在 ensure_image_local/任何镜像白名单。敏感字段权限 problem:field_evaluator_command/network 在 seed-rbac.ts:55-61 一次性默认授予 default user 角色，assertSensitiveFieldPermissions 默认放行，故普通注册用户可为自有题目设任意 evaluator.command 并开网。Redis docker-compose.yml 无 requirepass。命令在 cap_drop ALL/no-new-privileges 的容器内以 root 执行，开网时可出网/扫内网，属真实高危。

### NOJ-152 SIGTERM 未处理，容器化环境优雅关闭失效
- **位置**：`noj-judge/src/main.rs:78-83`　**维度**：可靠性
- **描述**：优雅关闭仅注册 tokio::signal::ctrl_c()（SIGINT）。SIGTERM 是 kill 默认信号、Docker/K8s stop 的标准终止信号，未注册处理意味着收到 SIGTERM 时进程被 OS 立即杀死，drain_tasks 与容器清理的 Drop 逻辑都不会执行，in-flight 评测结果丢失且容器成为孤儿。CLAUDE.md 声称「SIGINT/SIGTERM 优雅关闭」，实际仅覆盖 SIGINT。
- **证据**：`tokio::spawn(async move { tokio::signal::ctrl_c().await.ok(); ... let _ = shutdown_tx.send(()); });`
- **建议**：改用 tokio::signal::unix::signal(SignalKind::terminate()) 同时监听 SIGTERM 与 SIGINT（并用 select!/merge 汇入 shutdown_tx），或使用 tokio_util 的 ctrl-c feature。
- **验证**：main.rs:79-83 仅注册 tokio::signal::ctrl_c()（SIGINT），无 SIGTERM 处理；drain.rs 头注释自称『收到 SIGTERM/SIGINT 时』排空，但入口只接 SIGINT。Docker/K8s stop 发 SIGTERM 时进程被直接杀死，drain_tasks 与容器清理不执行，in-flight 结果丢失且容器孤儿。文档与实际实现不一致，成立。

### NOJ-193 zip 解压炸弹防护可被伪造声明大小绕过（单条目解压无上限，内存耗尽 DoS）
- **位置**：`noj-judge/src/sandbox/container.rs:70-95`　**维度**：安全
- **描述**：单文件 64MB 上限检查的是 zip 中央目录里攻击者可控的声明解压大小 file.size()（第 70-77 行），而非实际解压字节数。第 86 行 file.read_to_end(&mut buf)? 会无上限地把整条 deflate 流解压进内存（Vec 自动扩容），512MB 总上限（第 88-95 行）在整条读完、内存已分配完毕之后才触发。攻击者把声明大小伪造为 0/小值即可绕过 64MB 单文件限制，单个条目解压出数百 MB～数 GB，造成 judge 进程内存耗尽（OOM）崩溃，违背 AGENTS.md「64MB 单文件 / 512MB 总解压硬编码」防护承诺。嵌套 zip 不会被递归解压（只解一层并注入容器），故不构成绕过路径，真正绕过点是声明大小与真实解压大小不一致。
- **证据**：`if file.size() > MAX_FILE_SIZE { ... bail! ... } ... let mut buf = Vec::with_capacity(file.size() as usize); file.read_to_end(&mut buf)?; total_size += buf.len() as u64; if total_size > MAX_TOTAL_SIZE { ... bail! ... }`
- **建议**：不要信任 file.size()：用带上限的读取（如 Read::take(MAX_FILE_SIZE+1) 包裹后 read_to_end，或循环 read 到固定缓冲并在读取过程中累计 total_size、任一超出即中断），使单文件与总量限制在解压过程中实时生效。
- **验证**：核实 container.rs:70-95：第 70 行 `file.size()` 取中央目录中攻击者可控的声明解压大小，第 86 行 `read_to_end` 无上限解压进 Vec，第 88-95 行总上限在内存分配完成后才检查。download.rs:14 的 128MB 上限只限制压缩包体积，不限制解压后体积（deflate 零串压缩比可达千倍），故声明大小伪造绕过成立，任何注册用户经支持包上传即可触发 judge 进程 OOM，DoS 成立。维持高。

## 中

### NOJ-168 评测运行时基础镜像 tag 未固定 digest（python:3.12-slim 浮动）
- **位置**：`noj-judge/docker/python/Dockerfile:7`　**维度**：供应链
- **描述**：FROM python:3.12-slim 未用 @sha256: 固定 digest，仅靠浮动 tag。tag 可被上游重打，构建不可复现，属典型供应链投毒面。
- **证据**：`FROM python:3.12-slim`
- **建议**：改为 FROM python:3.12-slim@sha256:<digest> 固定内容摘要，并定期轮换 digest；可用 docker buildx imagetools 获取当前 digest。
- **验证**：docker/python/Dockerfile:7 为 FROM python:3.12-slim，未固定 @sha256 digest，tag 可被上游重打、构建不可复现，供应链投毒面属实，维持中（供应链加固项）。

### NOJ-171 评测沙箱容器以 root 运行不可信用户代码（无 USER 指令）
- **位置**：`noj-judge/docker/python/Dockerfile:7`　**维度**：容器安全
- **描述**：评测运行时镜像（python、evaluator-python、solution-python 均无 USER 指令）默认以 UID 0 运行，用户提交的不可信代码在容器内以 root 执行。虽有 cap_drop ALL / no-new-privileges / network none 等运行时加固，但缺少非 root 用户这一层纵深防御，一旦能力或 seccomp 配置疏漏/内核漏洞即放大为宿主 root。
- **证据**：`三个镜像均无 USER 指令，python:3.12-slim 默认 root 用户`
- **建议**：在 Dockerfile 中创建非特权用户（如 UID 1000）并以 USER 切换；注意评测需写 /workspace、/tmp 的目录属主与挂载权限。
- **验证**：确认 docker/python/Dockerfile 及 evaluator/solution 镜像均无 USER 指令，默认 UID 0。属与 idx187 同源的纵深防御缺口，cap_drop ALL 等已大幅缓解提权风险，维持中。

### NOJ-156 drain 30s 超时短于下载超时(60s)，误 abort 仍在推进的任务
- **位置**：`noj-judge/src/drain.rs:13-14`　**维度**：可靠性
- **描述**：DRAIN_TIMEOUT_SECS=30，而支持包下载超时默认 60s（config.rs SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT 默认 60），且 evaluator 可配置 time_limit_ms 可能 >30s。shutdown 时若某任务仍合法地在下载/评测中，30s 后被强 abort：其结果不会推送（提交 Pending），且若已创建容器则因第 2 条 Drop 缺陷泄漏容器。排空超时兜底存在，但阈值与任务真实耗时上限不匹配。
- **证据**：`const DRAIN_TIMEOUT_SECS: u64 = 30;  // drain.rs;  config.rs: support_package_download_timeout_secs 默认 60`
- **建议**：drain 超时上限应 ≥ 下载超时 + 启动超时(30s) + 最大 time_limit_ms 之和，或从 config 派生；并记录被 abort 任务的 submission_id 以便补偿/重排。
- **验证**：drain.rs:13 DRAIN_TIMEOUT_SECS=30，而 config.rs:34-37 支持包下载超时默认 60s，且 evaluator time_limit_ms 可 >30s；优雅关闭时合法推进的下载/评测任务在 30s 后被 abort，结果不推送（提交卡住）且已建容器经 Drop 清理失败会泄漏。阈值不匹配真实，维持中。

### NOJ-153 Drop 清理用 fire-and-forget tokio::spawn，shutdown abort 时容器泄漏
- **位置**：`noj-judge/src/dual/container.rs:81-100`　**维度**：可靠性
- **描述**：DualContainer 的 Drop 仅 spawn 两个 detached 清理任务并立即返回（不 await、不 join）。在正常错误路径（create_solution/inject/start_exec 失败或 panic）中，清理靠 Drop 完成，任务随后继续推送结果、进程仍存活，清理任务尚能跑完；但在优雅关闭的 drain 超时 abort 路径：handle.abort() 触发 Drop 后 spawn 的清理任务未被 FuturesUnordered 跟踪，join_all 只等被 abort 的 JoinHandle，随后 main 返回、rt 被 drop，这些 detached 清理任务被直接丢弃——docker rm 从未执行，容器泄漏。累积泄漏最终耗尽宿主机资源。
- **证据**：`impl Drop for DualContainer { fn drop(&mut self) { if let Some(id)=self.solution_id.take(){ let docker=self.docker.clone(); tokio::spawn(async move { if !remove_container_force(&docker,&id).await { ... } }); } ... } }`
- **建议**：不要用 spawn 做 Drop 清理。让 evaluate_dual 的每个早退路径都走显式 dual.destroy().await（用 scope guard 风格），或在 drain 阶段额外等待一个持有清理句柄的集合；确需 Drop 兜底时把容器 ID 记录到进程级待清理列表，由启动清扫兜底回收。
- **验证**：机制属实但触发面窄，由高下调。container.rs:81-100 Drop 用 fire-and-forget tokio::spawn 清理；evaluate_dual(147-248) 正常路径末尾显式 dual.destroy().await(243)，仅步骤1-6 早退错误路径依赖 Drop（此时进程存活、清理任务可跑完）；真正泄漏仅在 drain 超时 abort 路径（drain.rs:51-52 handle.abort()）→ Drop spawn 清理任务后 rt 被 drop、任务被丢弃、docker rm 未执行。且 grep 确认 noj-judge/src 无任何按标签（com.noj.judge.dual.*）的启动孤儿清理实现，泄漏无兜底。但仅优雅关闭+卡死任务(>30s)时触发，每次泄漏量有限，非正常运行累积，故降中。

### NOJ-187 用户代码与评测脚本以 root (UID 0) 运行且 rootfs 可写
- **位置**：`noj-judge/src/dual/container.rs:172-181`　**维度**：安全
- **描述**：ContainerCreateBody 未设置 user 字段（Docker 默认 root），两个镜像 Dockerfile（evaluator-python、solution-python）也均无 USER 指令，因此用户代码（Solution 容器）与 evaluate.py（Evaluator 容器）都以 UID 0 运行。同时 build_host_config 以 readonly_rootfs=false 调用（第 172 行），rootfs 可写。虽 cap_drop ALL + no_new_privileges 已移除提权能力、无敏感挂载，root 仍可任意读写容器内全部文件系统（含 SDK 代码），且 /workspace 位于容器可写层（仅 /tmp 是 256M tmpfs），缺乏对可写层磁盘写入的配额，恶意提交可在时限内向 /workspace 大量写盘（临时占用宿主 overlay 磁盘）。
- **证据**：`let host_config = build_host_config(memory_bytes, tmpfs, false, network_mode);
let body = ContainerCreateBody { image: ..., cmd: Some(vec!["sleep", "infinity"]), labels: ..., host_config: Some(host_config), working_dir: Some("/workspace"), ..Default::default() };`
- **建议**：在 ContainerCreateBody 中设置非特权 user（如 65534:nogroup）或镜像内加 USER 指令；将 readonly_rootfs 设为 true，并把 /workspace 改为受限 tmpfs 挂载；对可写层增加 disk 配额或对输出做大小限制。
- **验证**：确认 dual/container.rs ContainerCreateBody 无 user 字段（默认 UID 0），build_host_config(...,false,...) 传 readonly_rootfs=false（host_config.rs 第三参确为 readonly_rootfs 且无 storage_opt 磁盘配额），镜像无 USER 指令。但 cap_drop ALL + no-new-privileges + network none + ipc none + pids_limit + memory 已消除提权与外联，Docker 默认 seccomp 仍在，故不构成宿主 root 逃逸；残余为可写层磁盘耗尽 DoS 与纵深防御缺口，由高下调为中。

### NOJ-158 容器创建成功但 start 失败时，容器 ID 丢失导致泄漏
- **位置**：`noj-judge/src/dual/container.rs:183-196`　**维度**：可靠性
- **描述**：create_container_with_security 中，create_container 成功返回 result.id 后若 start_container 失败/超时，函数经 ? 返回 Err，result.id 未纳入任何 Drop guard（create_evaluator/create_solution 在得到 Err 前 DualContainer 尚未持有该 ID），该「已创建未启动」容器成为孤儿。Docker 负载下 start 失败是可预期的失败路径。
- **证据**：`let result = timeout(Duration::from_secs(30), docker.create_container(None, body)).await...?; timeout(Duration::from_secs(5), docker.start_container(&result.id, None)).await...?; Ok(result.id)`
- **建议**：start_container 失败时立即对 result.id 调用 remove_container_force 再返回 Err，或把 ID 先交给 RAII guard 再 start。
- **验证**：核实成立。dual/container.rs create_container_with_security(183-196)：create_container 成功返回 result.id 后，若 start_container 超时/失败经 ? 返回 Err，result.id 未交给任何 Drop guard(create_evaluator/create_solution 在得到 Ok 前 DualContainer 未持有 id)，容器成为孤儿。缓解：labels 已打(162-163)且 cleanup.rs 启动时按标签清理，故泄漏有界(重启前残留)。真实资源泄漏路径，维持中。

### NOJ-189 内存限制直接取自 MQ 消息，judge 侧无上限封顶
- **位置**：`noj-judge/src/dual/container.rs:165`　**维度**：安全
- **描述**：memory_bytes 直接由消息中的 memory_limit_mb 计算（memory_mb as i64 * 1024*1024），judge 侧没有任何上限校验或封顶。noj-core 侧的 enforceResourceLimits 仅在管理员把 judge_max_evaluator_memory_limit_mb / judge_max_solution_memory_limit_mb 配置为 >0 时才生效，而 registry 默认值为 0（= 不限制，settings-registry.ts:595-622）。因此默认部署下内存上限完全由消息决定，任何能写入队列的一方（或配置失误）可申请超大内存。另 memory_mb 为 u64，`as i64` 在超 2^63 时静默回绕为负数（会被 Docker 拒绝，属健壮性问题）。
- **证据**：`let memory_bytes = (memory_mb as i64) * 1024 * 1024;`
- **建议**：在 judge 侧对 memory_limit_mb 设硬上限（env 配置，如 JUDGE_MAX_MEMORY_MB）并在计算前校验上界与溢出；同时在 core 侧将 judge_max_* 默认值从 0 改为有实际意义的上限。
- **验证**：dual/container.rs:165 memory_bytes=(memory_mb as i64)*1024*1024 无任何上限校验；core 侧 judge_max_*_memory_limit_mb 默认 0=不限制（settings-registry.ts:595-622）。默认部署下内存上限完全由消息决定，u64→i64 超 2^63 还会回绕为负。属防御纵深缺口（需队列写入方或配置失误），真实，维持中。

### NOJ-162 文档声称的 OOM 识别/内存峰值读取/两步 kill 均未实现，time_ms 与 memory_kb 恒为空
- **位置**：`noj-judge/src/dual/mod.rs:746-747；dual/container.rs 64-78`　**维度**：正确性
- **描述**：CLAUDE.md/AGENTS.md 描述的内存峰值读取（cgroup v2 memory.peak / v1 memory.max_usage_in_bytes）、OOM 退出码识别（137/139）、超时后 stop_container(SIGTERM)+kill_container(SIGKILL) 两步终止、docker logs 捕获输出等，在 src 中全库 grep 均无对应实现（无 memory.peak/max_usage/OOM/SIGKILL/stop_container/kill_container 字样）。实际：build_judge_result 与 timeout/system_error 三个构造器都把 time_ms/memory_kb 置 None；超时后仅靠 evaluate_dual 末尾 dual.destroy() 的 `docker rm -f` 直接强删容器。后果：(1) evaluation_results.time_ms/memory_kb 恒为 NULL；(2) Solution 容器 OOM（SIGKILL/137）无法被 judge 识别，只能经 call 超时→finalize_outcome 归为 TLE/SystemError，而非 MemoryLimitExceeded。
- **证据**：`build_judge_result: time_ms: None, memory_kb: None, rejudge_seq: None
DualContainer::destroy: remove_container_force(...)  // 仅 docker rm -f，无 SIGTERM/SIGKILL 序列`
- **建议**：要么实现文档承诺的峰值内存读取与 OOM 退出码映射（在 exec 结束后读取 cgroup memory.peak 并按 137→MemoryLimitExceeded 归因），要么修正文档，避免与实现不符误导维护者；至少应把 judge 可观测到的 solution 退出码/EOF 与内存上限命中显式区分。
- **验证**：属实：grep 确认 src 无 SIGKILL/stop_container/kill_container/memory.peak/max_usage/137 归因实现（仅 types.rs 有 MemoryLimitExceeded 枚举、protocol.rs 一条防 judge OOM 注释）；build_judge_result(746-747) 与 JudgeResult::timeout/system_error（types.rs:151-152,165-166）均置 time_ms/memory_kb=None，故 evaluation_results 两列恒 NULL；destroy 仅 remove_container_force（docker rm -f，container.rs:64-78）。文档承诺的 OOM 识别/峰值读取/两步 kill 未实现，Solution OOM 只能归为 TLE/SystemError。属正确性/文档-实现不符，维持「中」。

### NOJ-155 shutdown 与 BRPOP 同时就绪时，已弹出的任务被丢弃
- **位置**：`noj-judge/src/main.rs:91-107`　**维度**：正确性
- **描述**：主循环 select! 使用 biased，shutdown_rx 分支优先于 pull_task。当 SIGINT 到达时若 pull_task 的 BRPOP 已下发到 Redis（mq.rs 用 MultiplexedConnection，命令一经 poll 即写入 socket），Redis 会服务端弹出该任务，但 select 选中 shutdown 分支后把 pull_task future 丢弃，弹出的任务既未评测也未重新入队，提交永久停在 Pending（任务丢失）。排空期间本身不再拉取新任务（正确），但「已弹出未消费」的窗口仍会丢任务。
- **证据**：`tokio::select! { biased; _=&mut shutdown_rx => { drain::drain_tasks(&mut tasks).await; break; } task_result = mq::pull_task(&mut redis_conn, &config.judge_queue) => { ... } }`
- **建议**：用 BRPOPLPUSH 移到 processing 队列、或收到 shutdown 后先把弹出但未处理的任务 LPUSH 回原队列，再退出；至少不要在 shutdown 已就绪时继续发起 BRPOP。
- **验证**：确认。main.rs:91-107 select! 用 biased 且 shutdown_rx 优先；mq.rs:14-31 用 MultiplexedConnection 的 BRPOP(5s 超时)，命令一经 poll 即写入 socket。SIGINT 到达时若 BRPOP 已下发，biased 选中 shutdown 丢弃 pull_task future，Redis 服务端弹出任务后响应无人消费，任务丢失（提交将卡在 judging 而非描述中写的 pending，属轻微措辞误差），窗口约 5s，真实但窄。

### NOJ-180 结果 fallback 文件仅写不回读：重启不重发、磁盘满即永久丢失
- **位置**：`noj-judge/src/mq.rs:104-143`　**维度**：可靠性
- **描述**：LPUSH 全部失败后把结果写入 fallback_dir 下 result-<submission_id>.json，但整个 noj-judge 没有任何代码在启动/运行期回读该目录并重发（main.rs:68-69 仅构造目录，grep 确认无 replay 逻辑），所谓『供运维恢复』完全依赖人工，不满足『重启后重发』。此外：create_dir_all 失败（112-120）或 fs::write 失败（磁盘满，126-142）时仅记一条 error 日志即返回，结果永久丢失（对照任务要求『结果永久丢失=高』）。且文件名不含 rejudge_seq，同一 submission 多次重测失败会互相覆盖。
- **证据**：`match tokio::fs::write(&fallback_path, &json).await { Ok(_) => ..., Err(e) => { error!(... "写入 fallback 文件失败"); } }`
- **建议**：启动时扫描 fallback-results 目录并尝试重新 LPUSH（成功后删除文件）；写入失败（含磁盘满）时至少提升告警级别，并考虑改用原子写（临时文件+rename）避免半截文件；文件名纳入 rejudge_seq 避免覆盖。
- **验证**：grep 确认 noj-judge 无任何回读 fallback-results 目录并重发的逻辑（mq.rs 仅写，main.rs:69 仅构造目录）；写失败仅 error 日志、文件名不含 rejudge_seq 均属实。但代码注释写明『供运维恢复』（人工恢复）而非『重启后重发』，fallback 文件本身即持久化，永久丢失仅在 Redis 与磁盘双重失败时发生，故从高下调为中。

### NOJ-181 反序列化失败的消息被静默丢弃，无死信/错误回投且日志缺原文
- **位置**：`noj-judge/src/mq.rs:33-41`　**维度**：可靠性
- **描述**：parse_task_message 对畸形 JSON/缺必填字段/类型错误（如 time_limit_ms 传字符串）只 error 日志后返回 None，main.rs:99-100 对 Ok(None) 直接 continue——此时 BRPOP 已弹出该消息，故它被永久丢弃，对应 submission 永远卡在 judging（core 侧也不知情）。这满足『不 panic、不死循环重读同一坏消息』（点 2 的底线 OK，unknown 字段因 serde 默认忽略也不 panic），但缺少两点：一是未把坏消息投到死信队列或向 core 回投 SystemError 结果，导致单条脏消息即造成该提交永久无结果；二是 error 日志只带 serde 错误、不含原始消息内容，运维无法定位是哪条消息坏了（对比 core base-consumer.ts:87 的 JSON 解析失败同样只跳过）。
- **证据**：`Err(e) => { error!(error = %e, "反序列化 JudgeTask 失败，跳过该消息"); None }`
- **建议**：解析失败时将原始 value（截断）记入日志；可选将坏消息 LREM 后放入 noj:judge:dead 死信队列，或按 submission_id 回投一个 SystemError 结果让 core 把提交标记为 error，避免永久卡 judging。
- **验证**：确认 mq.rs:33-41 parse_task_message 反序列化失败仅 error 日志后返 None 且不含原文，pull_task 返回 Ok(None)；BRPOP 已弹出该消息，main.rs 对 None continue，消息被永久丢弃、对应 submission 卡 judging，且无死信/回投。维持中。

### NOJ-182 结果推送无幂等/去重，网络歧义下重复 LPUSH 使 core 统计重复计数
- **位置**：`noj-judge/src/mq.rs:65-102`　**维度**：可靠性
- **描述**：push_result_with_retry 无幂等键/去重：若 LPUSH 已在服务端成功但客户端收到网络错误（超时/断连），重试会再次 LPUSH 同一结果 → core 消费两次。core 的 saveEvaluationResult 对结果行是 UPSERT（onConflictDoUpdate），submission 状态更新也幂等（终态 finished/error），故状态机不被破坏；但 saveEvaluationResult 每次都会无条件调用 applyNewResult(result.score, ...)（submissions-result.ts:113-115），而 applyNewResult 每次调用 total++/todayTotal++（stats-cache.ts:103-117），重复结果会虚增统计计数；且 Accepted 的 first_accepted 活动判定仅排除自身提交（submissions-result.ts:128-133），重复结果可能产生重复活动事件。
- **证据**：`let push_result = conn.lpush::<&str, &str, usize>(queue, &json).await; match push_result { Ok(_) => { ... return; } Err(e) => { ... retry } }`
- **建议**：judge 侧无法完全消除 at-least-once 重复，应在 core 侧做幂等：saveEvaluationResult 在结果与上次一致时跳过 applyNewResult（比对既有 evaluationResults 行的 score/status，或基于 rejudge_seq+status 的幂等标记）；或 judge 侧为每次推送生成唯一结果 ID 并让 core 去重。
- **验证**：mq.rs:65-102 push_result_with_retry 无幂等键，LPUSH 服务端成功但客户端网络歧义时重试会重复入队。core 侧 saveEvaluationResult 对结果行 UPSERT(submissions-result.ts:98-109) 状态机不破坏，但 line 114 无条件 applyNewResult→stats-cache.ts:105-113 每次 total++/todayTotal++，重复结果虚增统计；且 first_accepted 判定(122-133)仅排除自身，重复可产生重复活动。rejudge_seq 校验(61)只拦过期 seq、不拦同 seq 重复。成立，保留中。

### NOJ-154 启动孤儿容器清扫未实现，残留容器永不回收
- **位置**：`noj-judge/src/sandbox/cleanup.rs:1-68`　**维度**：可靠性
- **描述**：CLAUDE.md 声称「孤儿容器清理：启动时按标签清理残留容器」，但 cleanup.rs 仅提供 remove_container_force（针对已知 container_id 的 rm -f），不存在按标签 list_containers + filter + remove 的启动清扫；main.rs 启动流程（连接 Redis/Docker 后直接进主循环）也未调用任何孤儿清理。崩溃/panic/drain-abort 泄漏的容器在重启后不会被回收，只能靠人工 docker rm，与第 2 条叠加形成容器泄漏累积。
- **证据**：`pub async fn remove_container_force(docker:&Docker, container_id:&str)->bool { ... docker.remove_container(container_id, Some(options)) ... }  // 全文件仅此一个函数，无 list_containers/标签过滤`
- **建议**：在启动阶段按标签 com.noj.judge.dual.evaluator/solution 列出并强制删除本实例残留容器。注意标签当前不含实例/主机名标识（未使用 gethostname），多 judge 实例共享同一 daemon 时会误删他人容器——实现 sweep 前需在标签中加入实例 ID（如 hostname），否则存在误杀风险。
- **验证**：cleanup.rs 全文件仅 remove_container_force（:21-68），无 list_containers/标签过滤；main.rs 启动流程仅连 Redis/Docker 后直接进主循环，无任何孤儿清扫调用（main.rs:43-90）。文档声称的启动清扫确不存在。降级理由：泄漏仅发生在 panic/崩溃/drain-abort 等异常终止路径，正常完成靠 DualContainer Drop 清理（dual/container.rs:81-101），且可人工 docker rm 恢复，属运维资源泄漏而非高影响正确性缺陷。

### NOJ-194 S3 下载未强制 HTTPS，且跟随任意重定向（明文传输 / http 降级 / SSRF 面）
- **位置**：`noj-judge/src/sandbox/download.rs:66-88`　**维度**：安全
- **描述**：http_download 对 percent 解码后的 url 直接 client.get(url) 发起请求，不校验 scheme（http/https 均可），也未限制重定向目标。reqwest 0.12 默认重定向策略会跟随最多 10 次重定向且不阻止 https→http 降级，也不限制目标主机。后果：① presigned URL 若为 http（MinIO/内网 S3 端点常见）则支持包明文传输、可被中间人篡改；② 若 url 被诱导指向内网地址（如 169.254.169.254 元数据服务或内网管理接口），judge 进程会代其发起请求（SSRF）。该 url 由可信 noj-core 生成，属纵深防御缺口，但配合下方 checksum 非强制的问题，明文/篡改风险被放大。
- **证据**：`let client = reqwest::Client::builder().timeout(Duration::from_secs(timeout_secs)).build()?; let mut response = client.get(url).send().await...`
- **建议**：校验解析后的 url 必须为 https（或白名单允许的内网 http 端点），并设置 redirect::Policy::none() 或自定义策略禁止降级/跨主机重定向；同时配合强制 checksum 校验兜底内容完整性。
- **验证**：核实成立。download.rs:66-89 http_download 用 reqwest 默认 client.get(url)，不校验 scheme(http/https 均可)、未设 redirect::Policy(默认跟最多 10 次重定向且允许 https→http 降级、不限目标主机)。url 由可信 noj-core presigner 生成，属纵深防御缺口；但 MinIO/内网 S3 端点 http 时明文传输、以及 judge 进程代发内网请求(SSRF)面真实存在，配合 checksum 缺失时 verify_checksum 跳过(100-110)放大风险。维持中(纵深防御)。

### NOJ-188 HostConfig 未设置任何 CPU 限制
- **位置**：`noj-judge/src/sandbox/host_config.rs:17-35`　**维度**：安全
- **描述**：build_host_config 构造的 HostConfig 只设置了 cap_drop/security_opt/privileged/readonly_rootfs/network/ipc/pids/tmpfs/memory 系列字段，未设置 nano_cpus、cpu_quota、cpu_period、cpu_shares 等任何 CPU 限制。用户代码的忙循环（如 while(1) 满负荷）在 time_limit_ms 内可占满单核，多提交并发时可造成 judge 宿主 CPU 耗尽（DoS）。
- **证据**：`HostConfig {
    cap_drop: Some(vec!["ALL".to_string()]),
    ...
    memory: Some(memory_bytes),
    memory_swap: Some(memory_bytes),
    ..Default::default()
}`
- **建议**：在 build_host_config 增加 cpu_quota/cpu_period（如限制单容器至 1 核以内）或 nano_cpus，并对 evaluator/solution 分别设合理默认值。
- **验证**：确认。host_config.rs:17-35 仅设 cap_drop/security_opt/privileged/readonly_rootfs/network/ipc/pids/tmpfs/memory/memory_swap，无 nano_cpus/cpu_quota/cpu_period/cpu_shares 任何 CPU 限制；用户 while(1) 忙循环在 time_limit_ms 内可占满单核，多提交并发有宿主 CPU DoS 风险，属实。

## 低

### NOJ-175 tokio 使用 full 特性，未按需最小化
- **位置**：`noj-judge/Cargo.toml:9`　**维度**：依赖卫生
- **描述**：tokio features=["full"] 会启用 fs、process、io-std、rt、net、time、sync、signal、macros 等全部特性，其中多数（fs/io-std/process 等）评测 worker 未必用到，扩大编译面与二进制体积、增加不必要攻击面。
- **证据**：`tokio = { version = "1", features = ["full"] }`
- **建议**：按需裁剪为 rt-multi-thread、macros、time、sync、signal、net、io-util（必要时加 process），去掉 full。
- **验证**：Cargo.toml:9 tokio = { version="1", features=["full"] } 确实启用全部特性，扩大编译面与体积。真实，维持低。

### NOJ-176 release profile 未配置 strip/panic/lto
- **位置**：`noj-judge/Cargo.toml:1`　**维度**：构建配置
- **描述**：Cargo.toml 无 [profile.release] 段，Dockerfile.e2e 的 cargo build --release 走默认配置：panic=unwind、strip=none、lto=false。发布二进制体积偏大、保留符号与回卷信息，对安全敏感的评测 worker 建议显式硬化。
- **证据**：`整个 Cargo.toml 无 [profile.release] 段；Dockerfile.e2e:15/20 使用 cargo build --release`
- **建议**：新增 [profile.release]：opt-level=3、panic="abort"、strip=true、lto="thin"（或 true）、codegen-units=1。
- **验证**：核实成立。Cargo.toml 全文无 [profile.release] 段，Dockerfile.e2e 用 cargo build --release 走默认 panic=unwind/strip=none/lto=false，发布二进制保留符号与回卷信息。属构建硬化建议，维持低。

### NOJ-172 E2E 镜像中 judge 进程以 root 运行（无 USER 指令）
- **位置**：`noj-judge/Dockerfile.e2e:29`　**维度**：容器安全
- **描述**：运行阶段 debian:bookworm-slim 未设置 USER，ENTRYPOINT 启动的 noj-judge 进程以 root 运行。该进程需访问 Docker socket（root 等价权限），root 运行进一步扩大被攻破后的提权面。
- **证据**：`ENTRYPOINT ["noj-judge"]，前文无 USER 指令`
- **建议**：增加非 root 用户（配合 docker 组或 rootless docker），以最小权限运行 judge。
- **验证**：Dockerfile.e2e 运行阶段 `FROM debian:bookworm-slim` 后仅 ENTRYPOINT，无 USER，进程以 root 运行，事实成立。但这是 E2E 测试镜像而非生产部署产物（生产以 cargo 二进制在宿主机运行），且 judge 本就需访问 Docker socket（root 等价权限），边际收益小，由『中』下调『低』。

### NOJ-173 E2E 运行阶段基础镜像 debian:bookworm-slim 浮动 tag
- **位置**：`noj-judge/Dockerfile.e2e:25`　**维度**：供应链
- **描述**：运行阶段使用 debian:bookworm-slim，该 tag 随 bookworm 的 point release 持续变动，未固定 digest，构建不可复现且存在被重打 tag 的投毒风险。
- **证据**：`FROM debian:bookworm-slim`
- **建议**：改用 debian:bookworm-slim@sha256:<digest> 固定。
- **验证**：核实 Dockerfile.e2e:25 `FROM debian:bookworm-slim` 浮动 tag 属实（builder 段 rust:1.86-slim-bookworm 已固定版本）。但仅用于 E2E 测试镜像、非生产，中→低。

### NOJ-184 Config 派生 Debug 且含明文 redis_url（可内嵌密码），judge 侧无脱敏
- **位置**：`noj-judge/src/config.rs:4-30`　**维度**：可靠性
- **描述**：Config 派生 #[derive(Debug, Clone)]（4 行）并持有 redis_url（7 行），redis_url 来自 REDIS_URL 环境变量（30 行），其标准格式 redis://:password@host 可内嵌密码。当前代码未对 Config 做 {:?} 打印，故暂无实际泄露；但作为可 Debug 结构体一旦被 tracing 的 ?config 或 error 链输出即泄露密码。对照 noj-core 的脱敏约定（logging.ts:104-115 抹除 secret 等敏感键、migrate.ts 对 DB 密码脱敏），judge 侧没有任何等价脱敏机制，redis_url 也未做任何 redact。
- **证据**：`#[derive(Debug, Clone)] pub struct Config { pub redis_url: String, ... }`
- **建议**：移除 Config 的 Debug 派生或为 redis_url 实现自定义 Debug（脱敏为 redis://***@host）；在统一 logger 中对 url/password/secret 字段做脱敏，与 core 约定对齐。
- **验证**：属实：config.rs:4 `#[derive(Debug, Clone)]` 且 7 行持有 redis_url（可内嵌密码），全库无 judge 侧脱敏；当前无 {:?} 打印故无实际泄露，属潜在泄露面。维持「低」。

### NOJ-163 memory_limit_mb=0 时 Docker 内存限制失效（Memory=0 视为无限制）
- **位置**：`noj-judge/src/dual/container.rs:165`　**维度**：正确性
- **描述**：`memory_bytes = (memory_mb as i64) * 1024 * 1024`，当 memory_limit_mb=0 时 memory_bytes=0。Docker API 中 Memory=0（且 MemorySwap=0）表示不施加内存限制，等于完全放开内存上限，与「内存限制 0」的直觉（要么拒绝、要么最严格）不符。该值由题目作者（admin）配置，非用户可控，故降级为低；但若题目配置异常会直接导致 Solution/Evaluator 无内存上限。负数则因 u64 反序列化失败使整个任务被 parse_task_message 静默跳过。
- **证据**：`let memory_bytes = (memory_mb as i64) * 1024 * 1024;  // 0 → Docker Memory=0 = unlimited`
- **建议**：在容器创建前校验 memory_limit_mb 必须为正（或对 0 施加默认上限），拒绝/兜底非法配置；负值在消息层统一给出可诊断的错误而非静默丢弃。
- **验证**：dual/container.rs:165 `memory_bytes=(memory_mb as i64)*1024*1024`，0→Docker Memory=0=无限制属实。缓解：problems-types.ts validateRuntimeConfig(105-112/145-152) 强制 memory_limit_mb>0，且被 problems-crud.ts:88/272 与 problem-bundle.ts:197 调用，正常 API 流不可达 0。属 judge 侧缺独立校验的纵深防御缺口（finder 亦自注 admin 可控故降低），保留低。

### NOJ-164 score 字段为浮点或超出 i32 范围时被静默置 0 或溢出
- **位置**：`noj-judge/src/dual/mod.rs:737`　**维度**：正确性
- **描述**：`let score = parsed.get("score").and_then(Value::as_i64).unwrap_or(0) as i32;`。evaluator 若输出浮点分（如 8.5），serde_json 的 as_i64 返回 None → score 静默变为 0；若输出超出 i32 范围的整数，`as i32` 发生回绕溢出。虽然协议约定 score 为 ×100 整数，但 judge 侧对异常值无任何校验/告警，题目脚本笔误会导致「满分变 0 分」且无日志可查。
- **证据**：`let score = parsed.get("score").and_then(Value::as_i64).unwrap_or(0) as i32;`
- **建议**：对 score 做类型与范围校验：非整数/越界时记录 warn 并回退为 0 或 SystemError，而非静默置 0/回绕；或在构建结果时保留原始数值透传。
- **验证**：确认。dual/mod.rs:737 `parsed.get("score").and_then(Value::as_i64).unwrap_or(0) as i32`：浮点分 as_i64→None→静默 0，超 i32 范围整数 as i32 回绕，无校验/告警，属实（防御性校验缺口）。

### NOJ-185 启动时 Redis/Docker 不可用直接退出进程，无重试/降级（对比 core 自动重连）
- **位置**：`noj-judge/src/main.rs:44-63`　**维度**：可靠性
- **描述**：启动阶段 redis::Client::open、get_multiplexed_async_connection、PING（44-53）以及 Docker connect/ping（57-62）任一失败即通过 ? 让 main 返回 Err 并退出进程，无任何启动重试或降级。对比 noj-core 启动时 Redis 失败进入 degraded 模式（HTTP 仍启动）且消费者带 30s 封顶的指数退避自动重连（base-consumer.ts:42-45）。judge 运行时拉取失败用固定 1s PULL_RETRY_DELAY（24/103 行）有界，推送重试 3 次/4s 封顶——这部分符合『退避有上限』；但启动即退出意味着 Redis 抖动期间启动的 judge 需外部编排（docker/systemd）反复拉起，且可能形成频繁重启。
- **证据**：`redis_client.get_multiplexed_async_connection().await.context("连接 Redis 失败")?; ... docker.ping().await.context("Docker daemon PING 失败...")?;`
- **建议**：启动连接增加带上限的重试循环（如 1s→2s→…→30s 封顶，共 N 次）再退出，或进入等待-重连循环而非立即退出；与 core 的自动重连策略保持一致。
- **验证**：main.rs:44-63 Redis 连接/PING 与 Docker connect/ping 任一失败即经 ? 让 main 返回 Err 退出进程，无启动重试或降级，与 core 的 degraded 模式不一致；运行时 PULL_RETRY_DELAY 有界，但启动即退出需外部编排反复拉起，维持低。

### NOJ-159 缓存写入 tmp 文件在 rename 失败/崩溃时残留且不被淘汰
- **位置**：`noj-judge/src/sandbox/cache.rs:74-84`　**维度**：可靠性
- **描述**：set() 先写 .{checksum}.tmp.{uuid} 再 rename 到 {checksum}.zip。若 rename 失败或进程在 write 与 rename 之间崩溃，tmp 文件残留。scan_entries() 只统计扩展名为 .zip 的文件，tmp 文件既不参与 max_items/max_bytes 计算也不被 LRU 淘汰，长期累积会无限增长缓存目录。
- **证据**：`let tmp_path = self.dir.join(format!(".{}.tmp.{}", checksum, uuid::Uuid::new_v4())); fs::write(&tmp_path, data).await...?; fs::rename(&tmp_path, &path).await...?;  // scan_entries: if path.extension()... != Some("zip") { continue; }`
- **建议**：rename 失败时显式 remove_file(tmp_path)；或让 scan_entries/淘汰逻辑同时清理 .tmp.* 文件（按修改时间清理陈旧 tmp）。
- **验证**：确认 cache.rs:74-84 写 .checksum.tmp.uuid 再 rename，rename 失败时 ? 上抛导致 tmp 残留；scan_entries(141) 仅统计 extension=="zip"，tmp 文件不参与计数与 LRU 淘汰，可无限累积。维持低。

### NOJ-196 缓存目录/文件权限未显式收紧，默认 umask 下支持包内容可被其他本地用户读取
- **位置**：`noj-judge/src/sandbox/cache.rs:30-38,78`　**维度**：安全
- **描述**：SupportPackageCache::new 用 fs::create_dir_all 创建缓存目录（未设权限，默认 0755），set 用 fs::write 写缓存文件（默认 0644），均依赖进程 umask，未显式收紧为 0700/0600。默认缓存目录为 /tmp/noj-judge/support-cache（config.rs），/tmp 是多用户共享目录：其他本地用户可读取缓存中的支持包内容（含题目评测脚本与测试数据），也可预先用符号链接占位 /tmp/noj-judge/support-cache 让 create_dir_all 落到任意目录（写入经符号链接跟随）。缓存键经 64 位 hex 校验，无法注入路径，故不构成投毒；此为权限与共享目录层面的低危问题。
- **证据**：`fs::create_dir_all(&dir).await...; fs::write(&tmp_path, data).await...`
- **建议**：创建目录后用 std::os::unix::fs::DirBuilderExt::mode(0o700)（或 set_permissions）收紧；写文件用 OpenOptions 指定 0o600；并考虑使用非 /tmp 的专用目录或创建时校验目录属主与符号链接。
- **验证**：确认 cache.rs L32 create_dir_all、L78 fs::write 未显式设权限（依赖 umask，默认 0755/0644），目录 /tmp/noj-judge/support-cache 在多用户 /tmp 下可被其他本地用户读取；缓存键经 64 位 hex 校验不可路径注入、不构成投毒，属权限/共享目录低危，维持低。

### NOJ-195 checksum_sha256 非强制，缺失或空字符串时静默跳过完整性校验
- **位置**：`noj-judge/src/sandbox/download.rs:100-111`　**维度**：安全
- **描述**：verify_checksum 在 expected 为 None 时直接返回 Ok（跳过校验），在 expected 为空字符串时也直接返回 Ok。而 download_url 中 checksum_sha256 参数是可选的（parse_query_param 缺失即 None）。调用链 runner.rs 仅在 checksum 存在时才做 verify 与缓存。这意味着若生产者（或构造 download_url 的一方）未附带 checksum，judge 会原样接受下载内容，不再有内容寻址完整性保护——与「SHA-256 校验贯穿两个层级」的设计意图不符。缓存命中路径本身不绕过校验（命中后仍 verify_checksum 复验），故缓存投毒需 SHA-256 原像、不可行；缺口在于校验本身可被缺失/空值跳过。
- **证据**：`pub fn verify_checksum(data: &[u8], expected: Option<&str>) -> Result<()> { if let Some(expected) = expected { if expected.is_empty() { return Ok(()); } ... } Ok(()) }`
- **建议**：将 checksum 设为强制：download_url 缺少 checksum_sha256 或为空时在 fetch_support_package/verify 层直接 bail 拒绝，确保所有支持包（base64 与 s3）都经 SHA-256 校验。
- **验证**：代码事实属实：verify_checksum（download.rs:100-111）对 expected=None 或空串均直接 Ok(()) 跳过校验。但 noj-core 构造 noj-download:// 时（local.ts:152/s3.ts/types.ts buildDownloadUrl）恒附加 checksum_sha256，生产者可信，不存在省略 checksum 的不可信输入路径；故为防御纵深/规范一致性的硬化缺口，非可利用链路，由「中」下调「低」。

## 信息

### NOJ-177 redis 依赖落后于当前主版本
- **位置**：`noj-judge/Cargo.toml:8`　**维度**：依赖卫生
- **描述**：redis 声明 0.27（Cargo.lock 锁定 0.27.6），已落后当前 redis-rs 主版本多个 minor（0.28/0.29/0.30）。未发现确证漏洞，但长期不升级会错失修复与安全更新。
- **证据**：`redis = { version = "0.27", features = ["tokio-comp"] }（Cargo.lock:1030 = 0.27.6）`
- **建议**：评估升级到较新 redis-rs 主版本，并运行 cargo audit / cargo update 确认无破坏性变更（凭经验，建议 cargo audit 确认）。
- **验证**：确认 Cargo.toml:8 redis=0.27（tokio-comp），落后主版本多个 minor，无确证漏洞，属依赖卫生提醒。维持信息。

### NOJ-192 容器标签为静态常量、无 submission 唯一标识，无法精确识别/清理
- **位置**：`noj-judge/src/dual/container.rs:162-163`　**维度**：安全
- **描述**：labels 仅插入 com.noj.judge.dual.{evaluator|solution}="true"，为全进程共享的静态常量，不含 submission_id、时间戳等唯一标识；容器名也由 Docker 自动随机生成（create_container 传 None）。因此无法按标签区分某次提交的容器与残留孤儿容器，也难以为未来「按标签清理孤儿容器」提供精确匹配依据（同一 label 会匹配所有 judge 容器）。当前不存在可预测的容器名碰撞（自动随机命名），此项无直接利用风险，仅影响可运维性与未来清理逻辑的正确性。
- **证据**：`let mut labels = std::collections::HashMap::new();
labels.insert(format!("com.noj.judge.dual.{}", kind), "true".to_string());`
- **建议**：为容器标签补充 submission_id 与创建时间戳（如 com.noj.judge.submission_id=<uuid>），便于精确追踪与超龄清理。
- **验证**：dual/container.rs:162-163 labels 仅插入 com.noj.judge.dual.{evaluator|solution}=true 静态常量，不含 submission_id/时间戳，容器名由 Docker 自动随机生成。无直接利用风险，仅影响可运维性与未来按标签清理的精确匹配，维持信息。

### NOJ-165 evaluator 输出 status 无白名单校验，缺失 status 时默认 SystemError 但保留 score
- **位置**：`noj-judge/src/dual/mod.rs:732-738`　**维度**：正确性
- **描述**：build_judge_result 直接透传 evaluator 输出的 status 字符串，未对照 JudgeStatus 枚举或任何白名单校验；core 侧亦只对 "SystemError"（→submission=error）与 "Accepted"（→首杀活动）做特判，其余任意字符串都会被存为 status 且 submission 置 finished。此外若 evaluator 输出缺少 status 字段，代码 `unwrap_or(SystemError)` 会把 status 置 SystemError 但 score 仍取 JSON 里的值（如 100），造成「score>0 的 SystemError」不一致结果。
- **证据**：`let status = parsed.get("status").and_then(Value::as_str)
    .unwrap_or(JudgeStatus::SystemError.as_str()).to_string();
let score = parsed.get("score").and_then(Value::as_i64).unwrap_or(0) as i32;`
- **建议**：对 status 做校验：未知 status 记录 warn 并（可选）回退 SystemError；缺失 status 时应同时将 score 归 0，保证 status/score 语义一致。
- **验证**：确认 dual/mod.rs L732-737 build_judge_result 直接透传 status 字符串无白名单校验，缺 status 时 unwrap_or(SystemError) 但 score 仍取 JSON 值（L737），可产生 score>0 的 SystemError。输入来自受信任出题脚本而非用户代码，属健壮性/语义一致性问题，维持信息。

### NOJ-166 time_limit_ms 采用墙钟时间且 0 值会立即触发 SystemError 超时
- **位置**：`noj-judge/src/dual/mod.rs:433, 366`　**维度**：正确性
- **描述**：阶段 2 的截止时间用 `tokio::time::sleep(Duration::from_millis(evaluator_timeout_ms))` 实现，为 judge 进程侧的墙钟计时（非容器 CPU 时间），且从「evaluator 首次输出」起算，阶段 1 的启动开销（最长 30s）不计入。这与 CPU-time 语义不同：Solution 的 sleep/等待会消耗墙钟预算。另外 time_limit_ms=0 时 Duration::from_millis(0) 使 deadline 立即就绪 → 判定 TimeoutKind::Total → SystemError，而 0 通常应表示「不限制」或应在配置层被拒绝。
- **证据**：`let deadline = tokio::time::sleep(Duration::from_millis(evaluator_timeout_ms));`
- **建议**：在文档/类型层明确 time_limit_ms 为墙钟语义；对 time_limit_ms=0 做显式处理（拒绝或视为不限制），避免配置笔误导致全部判 SystemError。
- **验证**：阶段 2 截止用 tokio::time::sleep(Duration::from_millis(evaluator_timeout_ms))（dual/mod.rs:433）实现，为 judge 进程墙钟计时、从 evaluator 首条输出起算，非容器 CPU 时间；time_limit_ms=0 时 sleep(0) 立即可达 → 判定 Total 超时 → SystemError。语义与 0 值边界均属实，维持『信息』。

### NOJ-167 总超时固定归 SystemError，慢 solution 可能被标为 error 而非 TLE
- **位置**：`noj-judge/src/dual/mod.rs:266-274`　**维度**：正确性
- **描述**：finalize_outcome 把任何总超时（Startup/Total）一律归为 SystemError（即使此前已向 evaluator 发送过 CallTimeout、说明根因是用户代码慢）。noj-core 据此把 submission 置为 error（而非 finished）。当用户 solution 多次接近单次 call 上限、累积导致 evaluator 超出 time_limit_ms 时，会被标成 SystemError（暗示评测环境异常）而非 TimeLimitExceeded。该语义在注释与 test_finalize_outcome_mapping 中被明确固化，属设计决策，故仅作信息提示；但会造成「慢代码」与「评测脚本故障」无法区分。
- **证据**：`fn finalize_outcome(timed_out: Option<TimeoutKind>, sent_call_timeout: bool) -> JudgeStatus {
    if timed_out.is_some() { return JudgeStatus::SystemError; }
    if sent_call_timeout { return JudgeStatus::TimeLimitExceeded; }
    JudgeStatus::SystemError
}`
- **建议**：评估是否应将「已发过 CallTimeout 且随后总超时」归为 TimeLimitExceeded 而非 SystemError，或在结果 details 中携带超时来源，供 core/前端区分评测脚本故障与用户代码超时。
- **验证**：核实 dual/mod.rs:266-274 finalize_outcome 任何 timed_out 均优先归 SystemError（即便已发 CallTimeout），注释 :262-265 与测试已固化该优先级，属设计决策，维持信息。

### NOJ-198 支持包获取/校验失败时 fail-open 继续评测（包被静默丢弃而非硬失败）
- **位置**：`noj-judge/src/judge/runner.rs:37-44`　**维度**：安全
- **描述**：fetch_and_cache_support_package 返回 Err（下载失败、base64 解码失败、checksum 不匹配、zip 非法等）时，evaluate 仅记录 error 日志并将 support_pkg 置为 None，评测照常继续（无支持包的 evaluator 通常输出 SystemError）。就安全而言这是 fail-closed——被篡改/校验失败的包不会被执行（被丢弃而非放行）；但从可用性与可观测性看，校验失败被吞掉、对做题人表现为 SystemError，无法区分「题目缺包」与「包被篡改/损坏」。此行为符合 noj-core「支持包读取失败非致命」的既有约定，故仅记为信息。
- **证据**：`Err(e) => { error!(... "支持包获取失败，继续执行（可能缺少评测文件）"); None }`
- **建议**：区分失败原因：对 checksum 不匹配等完整性失败可考虑让该提交直接判为 SystemError 并携带可观测告警，避免静默降级掩盖篡改/损坏信号（如无此需求则保持现状）。
- **验证**：核实成立。runner.rs:37-44 fetch_and_cache_support_package 返回 Err(下载失败/base64 解码失败/checksum 不匹配/zip 非法)时仅 error 日志并将 support_pkg 置 None，评测照常继续。安全上是 fail-closed(被篡改/校验失败包不会被执行)，但校验失败被吞掉、对做题人表现为 SystemError，无法区分缺包与包损坏。符合 noj-core「支持包读取失败非致命」约定，finding 已自评为信息，维持信息。

### NOJ-186 src/mq/rpc.rs 在本基线不存在，Redis RPC（core↔judge）未实现
- **位置**：`noj-judge/src/mq/rpc.rs:（文件不存在）`　**维度**：可靠性
- **描述**：任务要求审查的 src/mq/rpc.rs 在基线 31150781 中不存在：noj-judge/src 下只有 mq.rs 单文件，无 mq/ 子目录（glob 全量 src/**/*.rs 无 rpc 文件）；grep 显示 noj-judge 与 noj-core 均无任何基于 Redis 的 RPC（call/response）实现，所谓 RPC 仅存在于双容器 NDJSON 编排（dual/protocol.rs）与 SDK 类型契约注释中。AGENTS.md 目录树中的『mq/rpc.rs # Redis RPC（core↔judge）』为过期描述。因此第 5 点（调用超时/取消/channel 关闭/core 不在线行为）无实现可审，不产生可靠性发现。
- **证据**：`glob("noj-judge/**/*.rs") 无 rpc.rs；grep rpc/RPC 仅命中 sdk 与 dual/tracker.rs 注释`
- **建议**：若该 RPC 属于规划中功能，应更新 AGENTS.md 目录树描述或补充分支；当前基线无需审计该项。
- **验证**：确认。glob noj-judge/src/**/*.rs 无 rpc.rs，仅 mq.rs 单文件；无基于 Redis 的 RPC 实现，RPC 仅存在于双容器 NDJSON(dual/protocol.rs)。此条为审计范围说明（待审文件不存在），事实准确，非缺陷。

### NOJ-197 zip 符号链接/硬链接条目未显式识别，依赖注入层强制普通文件兜底
- **位置**：`noj-judge/src/sandbox/container.rs:44-67`　**维度**：安全
- **描述**：extract_zip_entries 仅判断 is_dir，未检查条目 unix_mode 中的 S_IFLNK（符号链接）或硬链接。符号链接条目会被当作普通文件 read_to_end（其内容为目标路径字符串），随后在注入层（dual/mod.rs inject_file_to_container）以固定 mode 0o644 的普通文件写入容器（tar Header::new_gnu 未设链接类型），且容器内 tar 用 -C /workspace 锚定、网络/能力隔离。故当前符号链接被扁平化为普通文件，不可利用；但这是「碰巧安全」而非显式防御，若未来注入逻辑改为保留 unix_mode 或直接落盘，符号链接将重新成为逃逸向量。
- **证据**：`let is_dir = file.is_dir(); ... if is_dir { ... continue; } ... file.read_to_end(&mut buf)?;`
- **建议**：显式读取 file.unix_mode() 并拒绝 S_IFLNK / S_IFLNK 之外的非常规类型（目录/普通文件之外一律 bail），将符号链接、设备文件、FIFO 等在解压层明确拦截。
- **验证**：核实成立。sandbox/container.rs:44-67 extract_zip_entries 仅判断 file.is_dir()，未检查 unix_mode 的 S_IFLNK/硬链接；符号链接条目被当普通文件 read_to_end(内容为目标路径字符串)，随后注入层(dual/mod.rs:97-107)以固定 mode 0o644 普通文件写入、tar -C /workspace 锚定，故当前被扁平化为普通文件不可利用，属「碰巧安全」而非显式防御。finding 已自评为信息并明确此定性，维持信息。

### NOJ-178 测试镜像使用第三方镜像源且 pip 依赖未锁定
- **位置**：`noj-judge/tests/e2e/Dockerfile.test-runner:9`　**维度**：供应链
- **描述**：测试镜像基于第三方镜像代理 docker.m.daocloud.io/library/python:3.12-alpine（无 digest），且 RUN pip install requests urllib3 未固定版本。虽仅用于 E2E 测试，仍存在镜像/依赖被投毒或版本漂移的风险。
- **证据**：`FROM docker.m.daocloud.io/library/python:3.12-alpine；RUN pip install --no-cache-dir requests urllib3`
- **建议**：固定基础镜像 digest；pip 依赖用 requirements.txt 或 == 精确版本锁定（可考虑 pip hash 校验）。
- **验证**：Dockerfile.test-runner:9 用 docker.m.daocloud.io 镜像源无 digest、11 行 pip install 未锁版本，仅 E2E 测试用，保留信息。
