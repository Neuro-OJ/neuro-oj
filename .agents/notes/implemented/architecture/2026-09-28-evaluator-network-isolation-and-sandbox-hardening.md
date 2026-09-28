# Agent Note: 评测沙箱加固与 Evaluator 网络隔离（noj-judge 生命周期、协议与容器网络）

Status: implemented

## Problem

2026-09-28 源码审计于 `noj-judge`（Rust 评测 Worker + Docker 双容器编排）发现一组"稳定性 + 隔离"缺陷：

1. **孤儿容器清扫完全失效（VULN-15，High）**：实例标识默认是 `{HOSTNAME}-{PID}`。Worker 崩溃重启后 PID 必变，启动清扫的标签过滤恒为空，旧容器（`sleep infinity`）永久残留占用 Docker/cgroups/网络资源；拼接字符串还可能含 `:`、`=`、空格，导致 Docker label filter 与 Redis 键切割歧义。`DualContainer::drop` 又只用 `tokio::spawn` 甩手删除容器，而 drain 时运行时随即销毁，异步删除没跑就被强杀。
2. **写管道无超时导致编排死锁（VULN-16，High）**：`run_dual_loop` 的 `select!` 分支内直接 `write_all().await`。对端停止读 stdin 时内核管道缓冲（约 64KB）写满即挂起，外层 `select!` 再也无法轮询，**总超时与调用级超时同时失效**——单次恶意提交即可永久占死一个评测槽位。
3. **支持包注入串行 exec（VULN-17，Medium）**：解包文件逐个 `docker exec` 注入，数百个小文件可耗数十秒，突破 30s 启动硬限额，把正常多文件题误判为 `Evaluator 启动超时 -> SystemError`。
4. **支持包失败静默放行（VULN-18，Medium）**：下载或 SHA-256 校验失败只打日志并把支持包置 `None`，继续起容器，最终以"无输出退出"掩盖真实原因。
5. **Evaluator 联网用默认 bridge（VULN-20，Low）**：默认 `bridge` 让沙箱经网关 IP（`172.17.0.1`）触达宿主机与同宿主其他容器，而全站服务挂在同一个扁平 `noj-net` 上——联网的 Evaluator 可直接向内网基础设施发起通信。
6. **tmpfs 缺少执行位约束（VULN-21，Low）**：`/tmp` 与 `/workspace` 只有 `size`/`mode`，攻击者可在临时目录直接执行投放的 ELF。
7. **`noj-download://local` 无审计告警（VULN-22，Low）**：该协议绕过对象存储鉴权直接读宿主文件，成功路径静默无日志，生产被异常调用时 SOC 无从感知。

## Decision

**实例标识：确定性短哈希 + 双标签解耦 + 显式生命周期。**

- `config::resolve_instance_id(work_dir)` 级联取值：① 非空 `JUDGE_INSTANCE_ID` → 种子 `env:{id}`；② `<WORK_DIR>/.instance_id` 非空 → 复用（已是最终形态则原样使用，否则按同一 hash 收敛并回写）；③ `auto:{canonical_work_dir}:{hostname}:{machine_id}` 派生并 best-effort 落盘，保证重启 100% 确定。`instance_id_source`（env/file/derived）进启动日志便于排障。
- 取 SHA-256 前 6 字节 → 12 位小写 hex，最终 `noj-{hash12}`：字符集仅 `[a-z0-9-]`，彻底消除 label filter 与 Redis 键的转义/切割歧义（对含 `:`、`=`、空格、非 ASCII 的恶意 `JUDGE_INSTANCE_ID` 同样成立）。
- 容器标签双份：`com.noj.judge.instance=noj-{hash12}`（本实例精准清扫）与 `com.noj.managed-by=noj-judge`（平台级兜底识别，绝不误杀宿主 postgres/redis 等业务容器）。启动清扫只用实例标签过滤器，`managed-by` 不进启动路径。
- 废弃全局易变 `instance_label_value()`；实例 ID 由 config 解析后显式透传 `main → runner → dual::evaluate_dual_with_cpu_limit → DualContainer::create_evaluator`。
- 容器创建之后的全部步骤包进内部 async 块，任何提前返回都显式 `await dual.destroy()`；`Drop` 退化为 panic 兜底（`Handle::try_current` + warn）；`drain::cleanup_containers_after_drain` 在运行时仍存活时按实例标签做 15s 有界的退出兜底清扫。

**写管道：3 秒超时 + 显式区分"对端已死"。**

- `PipeWriteOutcome { Written, PeerGone }` 与 `forward_frame_with_timeout`（`PIPE_WRITE_TIMEOUT = 3s`）：写成功、超时、`EPIPE` 三态显式区分，其他 io/serde 错误仍返回 `Err`（不吞错）。`write_timeout_frame` 与所有回写 evaluator/solution stdin 的路径统一经此函数，不再有裸 `write_all`。
- `handle_eval_chunk`/`handle_sol_chunk` 返回 `Result<bool>`（false = 对端 stdin 已死），循环内四个调用点据此置 `evaluator_done`/`solution_done` 并走异常收尾，而不是每帧等满 3 秒或死锁。

**注入：单 tar 流 + 单次 exec。**

- `inject_files_to_container(docker, container_id, files: &[(&str, &[u8])])` 用 `tar::Builder` 把所有文件写入同一个内存归档，容器内只发起一次 `tar xf - -C /workspace`；`inject_file_to_container` 保留为单元素薄包装（逐字节兼容旧行为，有测试钉住）。路径校验前移并加强：拒绝空名、NUL、绝对路径（`/`、`\`）与 `..` 穿越。

**失败即终止（VULN-18）**：`task.download_url` 存在但下载或 SHA-256 校验失败时打印中文 `error!` 并 `return Err(e)`，不再以空环境继续起容器。

**网络隔离（VULN-20，方案 A 的最小爆炸半径实现）。**

- `docker-compose.prod.yml` 新增**评测隔离网络** `noj-eval-net`（`name:` 显式固定，可用 `NOJ_EVAL_NETWORK_NAME` 覆盖以支持同宿主多 stack）。只有 `llm-gateway` 同时加入 `noj-net` 与 `noj-eval-net`（唯一受控双网卡入口，在两个网络上都有服务名别名）；其余服务（postgres / redis / minio / core / ui / judge / nginx / 监控）保持在 `noj-net`。
- Evaluator 沙箱容器因此只落在 `noj-eval-net` 上：能出公网、能访问 `http://llm-gateway:8001`，但对 postgres / redis / minio / core **既无 DNS 也无路由**，内网横向穿透与 SSRF 在物理层被切断。
- `noj-judge` 的 `evaluator_network_mode` 默认改为 `noj-eval-net`，并新增 `validate_evaluator_network_mode` + `Config::validate()`（挂到启动路径）：**拒绝 `bridge` / `host`**、空值与非法 Docker 网络名。`noj-cli` 的两个默认值（`JUDGE_DEFAULT_VALUES`、`COMPOSE_ENV_DEFAULTS`）同步改为 `noj-eval-net`，渲染出的 `docker-compose.judge.yml` 声明并创建该网络（保证 network 存在，否则 judge 创建容器会 network not found）；restore-drill（TS 与遗留 bash）改为对每套演练 stack 使用 `${projectName}_noj-eval-net` 并同步设置 `JUDGE_EVALUATOR_NETWORK`，避免与生产固定名冲突。

**容器收尾与审计（VULN-21/22）**：`/tmp` 与 `/workspace` 挂载追加 `noexec,nosuid,nodev`（保留原 size/mode）；`noj-download://local` 在解析校验之后、复制之前打印明确声明危险性的 `warn!`，路径经 `redact_local_path` 脱敏（只留末段文件名与目录层级计数），协议本身保留可用。

**明确不做**：VULN-14（Solution 容器可向 Evaluator 发 `FRAME_SHUTDOWN`）按审计裁定 **Won't Fix**——它只造成选手自损（本次提交 `SystemError` 得 0 分），不影响其他评测与宿主，`dual/mod.rs` 的转发语义与 `sdk/evaluator` 的 `runner.py` 均未改动。VULN-19（ZIP 全量驻留堆内存）本轮不实施流式重构。

## Alternatives considered

- **实例 ID 继续用 PID，但把清扫改成"按 `managed-by` 全量清扫"**：能清掉孤儿，但在同一 daemon 上有多个 judge 实例时会**互杀在跑容器**，风险高于残留。改为"实例标签精准清扫 + managed-by 仅作人工兜底"。
- **实例 ID 仅用 `HOSTNAME` 或 UUID 落盘**：前者在多副本/同名宿主下不唯一，后者需要额外的持久化介质与读失败路径；`auto:` 指纹派生 + 文件缓存兼顾确定性与零外部依赖。
- **用哈希全 64 位**：label 值不需要那么长，12 位（48-bit）与 Docker 短容器 ID 惯例一致，且日志可读。
- **写管道超时后直接杀掉整个评测**：对"对端 stdin 已死"与"临时拥塞"不加区分会放大误判；改为标记流结束并按协议异常收尾，让评测脚本/收尾逻辑正常产出结果。
- **批量注入改用 Docker 原生 upload API**：需要额外的 tar 处理与 API 版本约束，且现有 tar 方案已在真实 Docker E2E 中验证；保留 `tar xf -` 单次 exec。
- **按审计草案把 `noj-net` 重命名为 `noj-backend-net`**：改名会波及 `noj-cli` 模板、restore-drill 覆盖文件、监控文档与告警脚本里的网络名，而**隔离效果完全相同**（隔离来自 `noj-eval-net` 只承载 Evaluator）。保留 `noj-net` 作为后端核心网络名，并在 compose 中写明这一取舍。
- **用宿主机 iptables 做 egress 白名单**：审计明确不采用宿主机侵入式规则，依托 Docker 原生网络隔离实现最小特权。
- **把 `JUDGE_EVALUATOR_NETWORK` 的校验改成仅在 `JUDGE_ALLOW_EVALUATOR_NETWORK=true` 时生效**：fail-open 的过渡口子会长期存在。宁可默认值正确 + 启动期硬拒绝（错误信息明确指向该变量）。

## Consequences

- 崩溃重启后的孤儿容器现在真的会被回收（实例标签在重启间稳定）；异常退出路径也会显式销毁本次评测的双容器，退出前另有有界兜底清扫。
- 单次恶意提交不再能靠"塞死对端 stdin"永久占死评测槽位：3 秒内判定对端已死并按协议收尾，总超时恢复有效。
- 多文件支持包/产物注入从"每文件一次 exec"变为"一次 exec"，消除了 30s 启动超时误判（真实 Docker E2E 的 support-package / dual-container / 安全隔离用例全部通过）。
- 生产拓扑变化（运维需要知晓）：
  - 新增网络 `noj-eval-net`；`llm-gateway` 现在同时在两个网络上；
  - `JUDGE_EVALUATOR_NETWORK` 默认值改为 `noj-eval-net`，且**填 `bridge`/`host` 会让 noj-judge 拒绝启动**（这是审计要求的强护栏）；`.env.prod.example` 新增 `NOJ_EVAL_NETWORK_NAME`；
  - 同宿主跑多套 stack（含 restore-drill 演练）必须为每套设置不同的 `NOJ_EVAL_NETWORK_NAME` 与 `JUDGE_EVALUATOR_NETWORK`；
  - 独立 judge 部署（`noj-cli judge install`）渲染出的 compose 会声明并创建 `noj-eval-net`；若运维把它指向外部已有网络，需自行改写为 `external: true`。
- **多副本约束**：`WORK_DIR/.instance_id` 若被多副本共享（命名卷）且未显式设置 `JUDGE_INSTANCE_ID`，各副本会解析出**同一个**实例 ID 并互相当作自己的残留回收——已在 `noj-judge/AGENTS.md` 标注，生产应为每个副本注入唯一 `JUDGE_INSTANCE_ID` 或使用独立 `WORK_DIR`。
- `WORK_DIR` 现在会在启动时被创建（用于落盘 `.instance_id`）；支持包获取/校验失败从"继续跑"变为"任务 `error`"（预期行为，日志含明确中文原因）。
- 覆盖盲区（诚实记录）：`judge::runner` 的支持包失败早退只有单元测试覆盖（真实 E2E 不经过 runner）；`drain::cleanup_containers_after_drain` 需要真实 SIGTERM 场景，未做 E2E（逻辑为 15s 有界超时 + 复用启动清扫的同一过滤器）；VULN-19 的 512MB 级解压内存峰值仍在（已知改进点：把 tar 目标从 `Vec<u8>` 换成 `WORK_DIR` 临时文件再流式喂 exec stdin 可使峰值约减半，彻底流式需处理 `ZipFile: !Send` 与 sync/async Write 桥接，建议单独立项）。
