# 双容器 Evaluator/Solution 评测运行时 — 设计稿

> 对应 issue: [#118](https://github.com/Neuro-OJ/neuro-oj/issues/118)
> 状态：评审后修订
> 日期：2026-07-09

## Context

NOJ 当前的单容器评测模型（`judge-image-whitelist` + `judge-worker` spec）把支持包与用户代码塞入同一个容器、共用同一 Python 进程。这不足以承载 LMCC 类题目：

1. `evaluate.py` 与用户代码共享文件系统，可被覆盖、伪造模块、污染 `sys.path`。
2. `import submission` 同进程调用把可信评测逻辑放在不可信进程里。
3. 未来可能需要让 Evaluator 持有内网凭据、模型访问或私有数据，单纯靠 `network_mode: none` 不能解决 Solution 受控访问能力的需求。

issue #118 要求把单容器拆成双容器：**Evaluator（可信）+ Solution（不可信）**，并定义 `noj_evaluator_sdk` / `noj_solution_sdk` 的调用语义，使其能迈向生产可用阶段。本设计稿描述第一阶段的实现方案，覆盖协议、SDK、容器编排、DB/UI、安全测试。

## Goals / Non-Goals

### Goals

- noj-judge 支持按题目一次任务启动 Evaluator + Solution 两个容器。
- Solution 容器默认无网络、不挂支持包、不读取 Evaluator 环境变量、不共享进程。
- Evaluator 通过 `noj_evaluator_sdk` 的 `SolutionRunner.call(...)` 调用 Solution 容器内的函数；同一评测内多次调用复用同一个 Solution Host（`persistent` 模式）。
- 协议安全：仅允许 7 种基本类型（`None` / `bool` / `int` / `float` / `str` / `bytes` / `list` / `dict`），禁止 `pickle` / `cloudpickle`、禁止运行时对象。
- 错误以枚举编码（`Timeout` / `NotFound` / `Exception` / `SystemError` / `Rejected`），调用方按统一语义处理。
- noj-core DB / API / admin UI 支持分别配置 Evaluator Runtime 与 Solution Runtime。
- 题目现有单容器模式保持向后兼容：缺 `runtime_config` 时自动回退到现有路径，零数据迁移。
- 配套安全测试覆盖：覆盖 `evaluate.py` / 模块 shadowing / 读取隐藏文件 / 网络访问 / fd 泄露。

### Non-Goals（第一阶段显式排除）

- 不引入支持包内 Manifest。运行时配置全部写入 `problems.runtime_config` JSONB。
- 不兼容 LMCC 官方样例的 `import submission` 同进程语义。
- 不实现 `isolate_per_call`（每调用独立隔离）模式。
- 不允许 Solution 反向调用 Evaluator（第一阶段统一拒绝）。
- 不使用 `pickle` / `cloudpickle` 跨进程传输对象。
- 不引入额外持久化对象存储。后续大对象传输通过 artifact descriptor 扩展。
- 不实现 Capability Service。
- **不允许 Evaluator 容器访问网络**（`runtime_config.evaluator.network` 第一阶段仅 `'none'`；需要网络能力的题目留待 Capability Service，后续阶段实现）。
- **不支持 Solution 反向日志/事件通道**（除 NDJSON `log` 帧外，无其他通道）。

## Decisions

### 1. 容器架构：两层 exec 直连，judge 转发 NDJSON

第一版设计稿采用 "judge → docker exec(agent) → unix socket → SDK + judge → docker exec(host)" 三层 hop。本设计稿简化为两层 hop：

```
   ┌─────────┐   docker exec      ┌──────────────────────┐    docker exec      ┌─────────────┐
   │  judge  │ ── python3 ────>   │  Evaluator           │                     │  Solution   │
   │  Rust   │   evaluate.py      │  Container           │                     │  Container  │
   │ process │                    │  ├─ evaluate.py      │                     │  ├─ host.py │
   │         │ <── stdout ───────│  │   (SDK client)     │                     │  (stdin/out)│
   │         │   (NDJSON+result)  │  └─ noj_evaluator_sdk│                     │             │
   │         │                    │                      │                     │             │
   │         │   docker exec ────────────────────────────────────────────────> stdin      │
   │         │ <── stdout ─────────────────────────────────────────────────── stdout     │
   │         │   (NDJSON)         │                      │                     │             │
   └─────────┘                    └──────────────────────┘                     └─────────────┘
```

**关键路径**

1. judge 启动 Evaluator 容器（网络隔离），不立即执行 `evaluate.py`。
2. judge 通过 `docker exec` 在 Evaluator 容器内启动 `python3 <evaluate.py>`（即 `judge_command`）。
3. judge 启动 Solution 容器（无网络、无支持包），通过 `docker exec` 跑 `python3 -m noj_solution_sdk.host --entry <solution_entry>`（host 模块源码 `noj-judge/sdk/solution/noj_solution_sdk/host.py`，由 `solution-python` 镜像构建时安装）。
4. **消息通路**（**Evaluator → Solution**：单方向）：
   - Evaluator SDK 调用 `runner.call("solve", 1, 2)` 时，SDK 通过**约定的 stdout NDJSON 通道**输出一行 JSON 帧（见 §2）
   - judge 在 Evaluator exec 的 stdout 流上做协议解析（识别 NDJSON 帧 vs `---RESULT---` 标记 vs 其他）
   - judge 把 NDJSON 帧原样转发到 Solution host 的 stdin
   - host 处理后写一行 stdout → judge 读 Solution exec stdout
   - judge 把响应帧**回写 Evaluator exec 的 stdin** → SDK 从 stdin 读到响应
5. 评测结束时（`evaluate.py` 写 `---RESULT---...` 标记），judge 读 evaluator 容器的 stdout 解析最终结果，写回 `JudgeResult`，关闭两个容器并清理。

**Evaluator 容器的 stdin/stdout 契约（SDK ↔ judge）**

- **stdout**（按时间顺序）：
  - 普通 print/logging 输出（被 SDK 通过 stderr 重定向）→ judge **不解析**，写日志后丢弃
  - NDJSON 协议帧（一行一帧）→ judge 解析后转发给 Solution host
  - `---RESULT---` + JSON → judge 识别为最终结果
- **stdin**（来自 judge 的回写）：NDJSON 响应帧（一行一帧），SDK 阻塞读

**Evaluator 容器协议约束**

- SDK 内部所有 print/logging **必须**重定向到 stderr（提供 `noj_evaluator_sdk.configure_logging()` 辅助）
- SDK 与 judge 的通信**只用** stdout 上的 NDJSON 帧 + `---RESULT---` 标记两样东西
- 若 evaluate.py 自己往 stdout 写内容，必须自己承担被 judge 误解析为协议帧的风险（design 选择：**不**为 stdout 加额外前缀，因为那样会改变 `---RESULT---` 协议）

**为何这样设计**

- 两层 hop 即可：judge 既是 Evaluator exec 的 IO 端，也是 Solution exec 的 IO 端，中间不需要 agent 进程
- `evaluate.py` 的 stdout 可控：SDK 把 print/log 转到 stderr，stdout 仅 NDJSON + `---RESULT---`，judge 解析逻辑简单
- 故障点少一个：不再有 agent 进程，Python traceback 直接出现在 evaluator exec 的 stderr 上，调试链完整
- 第一阶段不实现反向调用，evaluator↔solution 通道单向（call → result/error），后续若开反向，只需让 host 也通过相同 NDJSON 协议回写到自己的 stdout，无须重构

### 2. RPC 协议：NDJSON + 错误枚举

**Solution Host 输入输出（stdin / stdout，一行一消息）**

| 方向 | type 字段 | 必要字段 |
|------|-----------|----------|
| host → judge（启动） | `ready` | — |
| judge → host | `call` | `id`, `fn`, `args[]` |
| host → judge | `result` | `id`, `value` |
| host → judge | `error` | `id`, `code`, `message`, 可选 `trace` |
| host → judge | `log` | `stream` ∈ {`stdout`,`stderr`}, `data` |
| judge → host | `shutdown` | — |

**Evaluator SDK ↔ judge（stdout / stdin）**：相同帧格式。SDK 写 stdout，judge 读 stdout 后转发到 Solution host stdin；Solution host 的 `result`/`error`/`log` 帧经 judge 转发回写到 Evaluator stdin，SDK 从 stdin 读到。

**错误码枚举**：`Timeout` / `NotFound`（函数未注册）/ `Exception`（用户代码异常）/ `SystemError`（host 内部错误）/ `Rejected`（参数类型不允许）。

**类型安全**：序列化层只接受 `None / bool / int / float / str / bytes (base64) / list / dict`；其他类型抛 `Rejected`，不杀 host。

**Trace 路径清洗**：host 在格式化 user exception trace 时，**仅保留** 文件 basename + 行号 + 类名 + 消息；剥离所有绝对路径（如 `/usr/local/lib/python3.12/dist-packages/noj_evaluator_sdk/...`）避免反推容器镜像 layout。

**Log 消息限额**：
- 单条 `log.data` ≤ 64 KiB；超限截断为前 64 KiB + `\n<truncated>\n`
- 累计 `log.data` ≤ 1 MiB / 评测；超限丢弃并计数（最终 `JudgeResult.details.logs_dropped` 字段）
- `log` 不进入 `JudgeResult.output`，仅落 `details.logs[]`

**输出缓冲约定**：
- host 启动时必须 `sys.stdout.reconfigure(line_buffering=True)`、`sys.stderr.reconfigure(line_buffering=True)`，否则 NDJSON 帧在管道模式下会卡在缓冲区

### 3. 任务协议：JudgeTask 向后兼容扩展

```ts
export interface JudgeTask {
  submission_id: string;
  problem_id: string;
  language: string;
  code: string;
  file_name?: string;
  rejudge_seq?: number;

  /** 单容器模式必填；双容器模式忽略 */
  judge_image?: string;
  judge_command?: string;
  /** 单/双容器模式通用：noj-download:// URL */
  download_url?: string;
  time_limit_ms: number;
  memory_limit_mb: number;

  /** mode 不存在或 'single' → 旧单容器路径；'dual' → 双容器编排 */
  mode?: 'single' | 'dual';
  /** 双容器模式必填 */
  runtime_config?: RuntimeConfig;
}
```

> 仅新增字段，不删字段、不改既有字段语义。任何不识别 `mode` 的旧 judge 自动忽略 → 单容器路径。

```ts
interface RuntimeConfig {
  evaluator: {
    image: string;
    command: string;             // 例如 "python3 /workspace/evaluate.py"
    /** Evaluator 总时间上限（双容器模式必填） */
    time_limit_ms: number;
    /** Evaluator 内存上限 */
    memory_limit_mb: number;
  };
  solution: {
    image: string;
    entry: string;               // Solution 容器内入口文件名，例如 "solution.py"
    /** 单次 SDK 调用的时间上限（单次超时不影响 host 进程） */
    call_timeout_ms: number;
    memory_limit_mb: number;
  };
}
```

**字段映射**：现有 `judge_image` / `judge_command` / `time_limit_ms` / `memory_limit_mb` 由 admin API 自动同步填充到 `runtime_config.evaluator` 的等价字段，单容器旧题无感。

**Legacy 字段保留策略**：
- 当 `runtime_config` 被设置时，`judge_image` / `judge_command` 仍保留为最后一次同步值，仅供 admin UI 显示，不参与调度
- 当 `runtime_config` 被清空（admin 显式置 null），回到单容器路径，使用 `judge_image` / `judge_command`
- 单容器题目 `runtime_config` 始终为 NULL；core 调度时读 `runtime_config IS NOT NULL` 决定路径

**时间层级关系（明确化）**：

| 上限 | 含义 | 触发动作 |
|------|------|----------|
| `runtime_config.solution.call_timeout_ms` | 单次 `runner.call(...)` 调用最大时长 | SDK 抛 `Timeout`，host 进程继续 |
| `runtime_config.evaluator.time_limit_ms` | 整个 Evaluator 容器（含 SDK 全部调用）最大时长 | judge `docker stop -t kill_grace_secs` → `docker kill` Evaluator 容器；判 `TimeLimitExceeded` |
| 实际耗时应满足 | `sum(call 实际耗时) ≤ evaluator.time_limit_ms`（含 SDK overhead） | — |
| `result.accept/wrong_answer` 调用本身 | 不受 `call_timeout_ms` 限制（防最后一帧超时） | — |

### 4. DB 与 API 改动

- `problems` 表新增列 `runtime_config JSONB NULL`，无迁移影响；现有题目均为 `NULL`。
- 新增 SQL 约束：`CHECK (runtime_config IS NULL OR jsonb_typeof(runtime_config) = 'object')`。
- Admin 题目 CRUD（`POST/PUT /admin/problems`）接受 `runtime_config`：可选；admin 不传则保留原值或置空。
- 取题公共 API（`GET /problems/:id` / `POST /problems`）行为不变；提交接口不读 `runtime_config`，由 submissions service 在落库前按题配置组装 task。
- 提交流程：`submissions` 服务查题 → 若 `runtime_config` 非 NULL 且结构合法 → 构造 `JudgeTask { mode: 'dual', runtime_config, ... }` 推 MQ；否则按旧路径推单容器任务。
- 提交流程的并发安全：先以 `SELECT ... FOR UPDATE`（或带 `updated_at` 的乐观锁）锁住题目行，再读取 `runtime_config` 构造 task，避免 admin 在提交期间清空 `runtime_config` 导致任务与预期路径不一致。
- Drizzle 迁移文件：`0017_problem_runtime_config.sql`（新增 nullable 列 + CHECK 约束）。

**导出兼容性**：导出文件包含 `runtime_config`；导入时若 `runtime_config` 缺失仅 warning，不报错（向后兼容旧导出文件）。

### 5. 镜像与白名单

- 新增两个目录：
  - `noj-judge/docker/solution-python/Dockerfile`
  - `noj-judge/docker/evaluator-python/Dockerfile`
- 镜像内分别内置 `noj-solution-sdk`（host + register）/ `noj-evaluator-sdk`（SolutionRunner + result）。
- 构建脚本：`noj-judge/scripts/build-sdk-images.sh`，并行 build 两个镜像并打 `:dev` tag。
- `judge_images` 表新增 `kind` 字段（`'evaluator' | 'solution'`，NOT NULL），admin 配置镜像时必须指定 kind。镜像分类不再靠 image 名前缀判别（避免脆性约定）。
- 白名单沿用 `judge_images` 表（参考 `judge-image-whitelist` spec 增量），不新增 RPC。
- judge 通过现有 `get_image_allowlist` RPC（见 `judge-rpc` spec）从 core 拉白名单，**返回结构升级**为 `{ image, kind }[]`；judge 启动时按 kind 分别预热 Evaluator 池（仅 evaluator kind 入池）。
- admin 配置校验：`runtime_config.evaluator.image` 必须在白名单中且 `kind='evaluator'`；`runtime_config.solution.image` 必须在白名单中且 `kind='solution'`。否则 admin API 返回 400。
- core 调度时（即推 MQ 前）再读一次白名单做 final gate：若发现镜像被下架或 kind 不匹配，返回提交错误 `image_not_allowlisted` 而非悄悄回退单容器 —— 避免语义漂移。
- judge 在容器创建前再做一次本地缓存校验（防御 TOCTOU）。

### 6. 模块边界

| 模块 | 职责 | 不做 |
|------|------|------|
| `noj-judge/sandbox/container.rs` | 启停单容器（旧路径） | 任何 SDK 协议 |
| `noj-judge/dual/` (新) | 双容器编排、NDJSON 协议解析、消息转发、结果收集、清理 | 评测语义 |
| `noj-judge/sdk/evaluator/` (Python) | `noj_evaluator_sdk`：`SolutionRunner` / `result.accept` / `result.wrong_answer`、stdout/stderr 重定向配置 | 不碰容器 |
| `noj-judge/sdk/solution/` (Python) | `noj_solution_sdk`：`register(fn)` | 不碰容器 |
| `noj-judge/docker/solution-python/` | 内置 solution host + SDK，ReadonlyRootfs + tmpfs /tmp + network=none | 不含测试数据 |
| `noj-judge/docker/evaluator-python/` | 内置 `noj_evaluator_sdk`；network=none（**第一阶段硬编码**，即便 admin 不配置）、无支持包，由 judge 在运行时 tar 注入 | 不含测试数据 |
| `noj-core` | `problems` Drizzle 列、admin CRUD、按模式调度 | 不懂 SDK |
| `noj-ui` | admin 题目编辑表单加 runtime 配置块（含镜像 kind 下拉） | — |

**容器安全默认**（Evaluator 与 Solution 共享）：
- `CapDrop=["ALL"]`、`SecurityOpt=["no-new-privileges:true"]`、`Privileged=false`、`ReadonlyRootfs=true`、`NetworkMode=none`、`IpcMode=none`、`PidsLimit=256`
- `tmpfs /tmp:size=256m,mode=1777`、`MemorySwap = Memory`、`MemorySwappiness=0`
- Solution 容器额外：`User=nobody`（以非 root 运行 host 进程，降低 fd 泄露攻击面）

### 7. 错误处理与状态映射

| 场景 | 行为 |
|------|------|
| Solution host 在 5s 内未发 `ready` | `SystemError`，`output: "solution host boot timeout"` |
| SDK 单次调用超过 `call_timeout_ms` | judge 关闭 Solution host 转发通道（停止向其 stdin 写入），回 `Timeout` 给 SDK；`evaluate.py` 决定怎么收场（catch 或透传） |
| Solution host 进程崩溃 / Solution 容器超 `time_limit_ms` | 同上 |
| Evaluator 容器 stdout 解析失败（非 NDJSON 非 `---RESULT---`） | 累积在 `details.stdout_unknown`，不立刻失败 |
| Evaluator 容器总时间超 `runtime_config.evaluator.time_limit_ms` | `TimeLimitExceeded` |
| Evaluator 容器 RSS 超 `runtime_config.evaluator.memory_limit_mb` | `MemoryLimitExceeded` |
| Solution 容器 RSS 超 `runtime_config.solution.memory_limit_mb` | `SystemError`（host 守护触发） |
| SDK 序列化非法类型 | `Rejected`，host 继续运行 |
| 用户代码 raise 异常 | `Exception`（trace 已 sanitize），host 不退出 |
| `runtime_config` 引用未白名单镜像或 kind 不匹配 | admin API 400；judge 同样返回 `SystemError`（"image not in allowlist"），不回退单容器 |
| Evaluator agent 不存在 | （本设计不再有 agent 进程，此项 N/A） |

**清理契约（RAII）**：

`DualContainer` 结构（`noj-judge/dual/mod.rs`）持有两个 `Container` handle 和两个 `Exec` handle，其 `Drop` 实现必须：
1. `docker rm -f <solution_container_id>`（先关 Solution，避免它反向接收 evaluator 已关的信号）
2. `docker rm -f <evaluator_container_id>`（再关 Evaluator）
3. 任何中间步骤 panic 都不应阻止后续清理
4. 关闭临时目录与下载缓存

### 8. 兼容性、回滚与迁移

- **向后兼容**：
  - 任何缺 `mode` 字段的 `JudgeTask` 走单容器旧路径，零行为变化。
  - 任何 `runtime_config IS NULL` 的题目走单容器旧路径；现有 1001/1002/1003 题目、API 都无感。
- **回滚**：admin 可在题目编辑界面清空 `runtime_config`，回到单容器路径。`judge_image` / `judge_command` 字段保持最后一次同步值，无需重建题。
- **迁移**：单条 Drizzle SQL 添加 nullable JSONB 列 + CHECK 约束；不需要对存量数据做 backfill。
- **新镜像未发布场景**：若 judge 容器内 `get_image_allowlist` 未列出给定镜像（被下架/尚未拉取），admin API 已经在创建时拒绝，core 调度时如果再发现不一致则 `SystemError` 而不静默回退 —— 避免结果语义漂移。
- **审计日志**：admin 设置/清空 `runtime_config` 必须记录 `action=problems.runtime_config_changed` 审计日志，含旧值摘要与新值摘要。

### 9. 测试矩阵

**单元 / 集成（无 Docker 或受限 Docker）**

- `noj_evaluator_sdk`：`SolutionRunner.call()` 各类型往返、`call_timeout_ms` 行为、非法类型抛 `Rejected`、`result.accept/wrong_answer` 写入 `---RESULT---` 的兼容性、stdout/stderr 重定向后 print 不污染 stdout。
- `noj_solution_sdk`：`register(fn)` 注册 + 重复注册抛错、未知函数调用返回 `NotFound`、异常返回 `Exception`（含 sanitize trace）、`register("name", fn1)` 后再次 `register("name", fn2)` 抛错。
- judge orchestrator：双容器路径分流、容器池回补（Evaluator 进池 / Solution 不进池）、异常关闭资源清理（8 种错误场景）。
- admin API：`runtime_config` 字段校验（结构、镜像白名单、kind 匹配）。

**Docker E2E（`NOJ_RUN_E2E=1`）**

新增 `tests/e2e_dual_container.rs`：

| 测试 | 目标 |
|------|------|
| `dual_basic` | A+B Problem，调用 `solve(1,2)` 接受，得分 100 |
| `dual_persistent` | 同一 host 内多次 `call`，验证持久化全局状态 |
| `dual_timeout` | Solution 函数 sleep 2s，`call_timeout_ms=500`，验证返回 `Timeout` 而非挂死 |
| `dual_solution_exception` | Solution 函数 raise，错误含 sanitize trace（不含绝对路径） |
| `dual_solution_cannot_overwrite_evaluate` | Solution 写盘尝试覆盖 evaluate.py，验证失败 |
| `dual_solution_no_network` | Solution 内 `socket.socket(...)` / `urllib.request` / DNS，验证全部失败 |
| `dual_solution_module_shadowing` | Solution 写 `os.py` / `sys.py` 到 PYTHONPATH，验证 Evaluator 进程内 `os` 不受影响 |
| `dual_solution_read_evaluator_env` | Solution 读 `os.environ`，验证看不到 Evaluator secret 环境变量 |
| `dual_solution_cannot_leak_fd` | Solution 调用 `os.listdir('/proc/self/fd')` 并尝试 `os.read`，验证无法读到 judge IPC 通道 |
| `dual_evaluator_no_network` | Evaluator 容器 `runtime_config.evaluator.network`（即便配置为 'default'）仍受 image 内 `network_mode: none` 约束（验证默认值生效） |
| `dual_legacy_fallback` | 旧 `JudgeTask`（无 `mode`）走单容器路径且行为不变 |
| `dual_image_kind_mismatch` | `runtime_config.solution.image` 配 `kind='evaluator'` 的镜像 → admin API 400 |

**跨模块 (noj-tests/E2E)**

新增 `e2e/08_dual_container_judge.test.ts`：

- admin API 配置双 runtime 题目 + 提交 → 返回 Accepted。
- admin 提交任务但镜像白名单被下架 → 返回 `image_not_allowlisted` 错误 + UI 友好提示。
- 单容器题目在 PR-C 之后仍能正常评测（回归测试）。

### 10. 四 PR 拆分（实施顺序）

| PR | 范围 | 合并依赖 | CI 风险 |
|----|------|----------|---------|
| **PR-A1**（协议 + SDK + types） | `noj-judge/sdk/{evaluator,solution}/`（Python）、`noj-judge/src/types.rs` 扩展、SDK 单测（无 Docker） | 独立可合 | 低 |
| **PR-A2**（Docker E2E + orchestrator） | `noj-judge/dual/`（编排、NDJSON 解析、消息转发、清理）、`tests/e2e_dual_container.rs`、动态构建临时镜像 COPY 当前 SDK/agent 源码 | PR-A1 | 中（Docker E2E 启动慢） |
| **PR-B**（生产镜像 + judge_images.kind） | `noj-judge/docker/{solution-python,evaluator-python}/`、`scripts/build-sdk-images.sh`、`docker-compose.yml` 集成、`judge_images.kind` 列迁移、Drizzle 0018_judge_images_kind.sql | PR-A1 | 中 |
| **PR-C**（DB + core API + UI） | Drizzle 0017_problem_runtime_config.sql、`problems.runtime_config` 列 + CHECK、admin CRUD API、admin UI runtime 配置块、submissions service 任务分流（含 SELECT FOR UPDATE 锁）、`JudgeTask` 协议扩展、judge 端 `get_image_allowlist` 返回结构升级 | PR-A1、PR-B；理论可 PR-A1 + PR-C 并行 | 中 |

> **不再合并 PR-A 与 PR-A2**：原设计 PR-A 把 SDK + Docker E2E 捆在一起，导致 CI 镜像构建与协议尚未敲定时反复推翻。拆开后 PR-A1 单测覆盖 < 30s，PR-A2 仅在协议稳定后才引入 Docker 依赖。

### 11. 文档交付

- 本设计稿：`openspec/changes/dual-container-judge/design.md`
- 提案：`openspec/changes/dual-container-judge/proposal.md`
- 任务拆分：`openspec/changes/dual-container-judge/tasks.md`
- 规范增量：
  - 扩展 `openspec/specs/judge-worker/spec.md`：补 §6 dual 模式 requirements + scenarios。
  - 扩展 `openspec/specs/judge-image-whitelist/spec.md`：补 `kind` 字段约束与分类语义。
  - 新增 `openspec/specs/problem-runtime-config/spec.md`：DB 列、admin API、调度语义。

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| 双容器路径耗时 vs 单容器：双 docker exec + host 启动多 ~200-500ms | 复用容器池（参考 `container-pool` spec）；Evaluator 容器按 image 入池，Solution 容器不复用（防状态泄漏） |
| NDJSON 帧解析在大输出下成本可观 | SDK 单行 ≤ 1 MiB 软限；超限 `Rejected`；Solution 日志通过独立 `log` 消息通道，受 64 KiB/条 + 1 MiB/总双限额约束 |
| Solution host 持有多次调用的全局状态，用户可能误用 | 已文档化 `persistent` 语义；提供 `runner.restart()` 重置 host；`isolate_per_call` 留给下一阶段 |
| `runtime_config` JSONB 结构演进困难 | 第一阶段保持简单结构；未来扩展使用 `schema_version` 字段而不是 db migration |
| 新镜像占 CI 镜像构建时间 | PR-B 单独做；CI 缓存分两层：基础镜像 + SDK 层；预估增 1-2 分钟 |
| Solution host 进程 crash 后 SDK 调用收到 connection error | SDK 抛出 `SolutionRunner.connection_error()`；evaluate.py 决定记 SystemError 还是 retry |
| Evaluator 网络开放带来的风险（未来 Capability Service 缺失） | 第一阶段硬编码 `network: none`；评审 H2 显式禁止 'default' |
| Solution fd 泄露攻击 | host 进程以 `User=nobody` 运行，且每评测独立进程（不进池） |
| Docker daemon 并发 exec 上限 | 单 judge 实例 16 池 × 2 exec = 32，并发安全；多 judge 实例水平扩展 |
| 协议 stdin/stdout 与 evaluate.py 自身 print 冲突 | SDK 强制 stdout/stderr 重定向；evaluate.py 不应直接 print，需用 SDK 提供的 logger |
| judge 端 dual 编排代码复杂度 | 用 RAII（`DualContainer` Drop）兜底清理；8 种错误场景必测 |

## Open Questions

1. Solution 镜像是否需要支持非 Python 语言（C++/JS）？
   - 第一阶段只做 Python；与现有 `LANGUAGE_EXT_MAP` 对齐。
2. Solution 容器是否复用？
   - 第一阶段不复用（防状态泄漏 + 简化）；v2 可在 `runner.restart()` 之后复用并重置 module cache。
3. 是否需要支持 `runtime_config` 在提交时按用户提交语言动态覆盖 Solution image？
   - 第一阶段不做；统一用题目配置的 image；不同语言走不同题目配置即可。
4. 是否需要 Evaluator 容器持有 secret 凭据？
   - 第一阶段不做；Capability Service 是后续阶段的目标。
5. trace sanitize 策略如何细化？
   - 第一阶段采用 "basename + 行号 + 类名 + 消息" 简化策略；v2 可由 SDK 提供 hook 让支持包自定义 sanitize 函数。

## Changelog

- 2026-07-09 v2（评审修订）：
  - A1 简化架构为两层 hop（去掉 socket 层与 agent 进程）
  - A2 Evaluator 网络第一阶段硬编码 `'none'`
  - A3 JudgeTask 字段精简（删除 `dual_download_url`、`solution_entry` 移入 `RuntimeConfig`）；明确 legacy 字段保留策略与时间层级关系
  - A4 `judge_images` 新增 `kind` 字段，分类不再靠前缀
  - B1 Trace 路径清洗
  - B2 Log 消息限额（64 KiB/条 + 1 MiB/总）
  - B4 PR 拆分从 3 段细化为 4 段（A1/A2/B/C）
  - B5 时间层级关系明确化
  - C 系列补充：line buffering、迁移文件编号 0017/0018、容器 User=nobody、fd 泄露测试、审计日志
  - 补全 proposal.md / tasks.md / specs/ 三件套