# 预测提交题（本地 GPU 出分，服务端判分）设计

Status: approved（设计已由项目所有者 review 并确认，进入实施）
日期：2026-09-21
范围：noj-core（submission / catalog）、noj-judge、noj-ui、noj-docs、契约与文档
基线：main @ d7778dff3
关联：ROADMAP Phase 2「公开榜 / 私有榜」；`dev-docs/audit/2026-09-05-noj-cheating-audit/summary.md`

---

## 1. Problem

### 1.1 诉求

希望选手用**自己的本地 GPU** 评测题目，并让结果**进入正式计分 / 榜单**。

### 1.2 为什么「本地出分」不能直接做

正式出分要求评测结论可信。当前的信任边界是：

- 判据（`hidden.jsonl` 隐藏标签、`evaluate.py`）只进 **Evaluator** 容器；
- 选手代码只进 **Solution** 容器（`network_mode: none`、`cap_drop ALL`、readonly rootfs）；
- 两容器文件系统隔离，只能经 NDJSON RPC 通信；
- 结果由 judge 解析 Evaluator 的 `---RESULT---` JSON 得出。

一旦把「出分程序 + 隐藏判据」放到选手本机，选手就同时握有裁判权（读内存、改返回值、伪造分数），
`cap_drop` / `network none` / `---RESULT---` 解析全部失效——**进程不在平台控制下**。

因此「本地 GPU 出分」只有一条可行路径：

> **隐藏判据留在服务端，本地 GPU 只做「拿不到答案也能算出答案」的计算。**

### 1.3 形态选择：Kaggle 传统赛

经确认，采用 **Kaggle 传统赛（offline）形态**：

| 要素 | 取值 |
| --- | --- |
| 训练集 / 公开验证集 / 测试输入 | **公开**，出题人自行外链，平台不托管 |
| 隐藏标签 / 标准答案 | **保密**，随支持包只进 Evaluator |
| 本地 GPU | 选手自行用于训练 / 推理，**平台不观测、不信任、不需要信任** |
| 提交物 | **预测结果文件**（纯数据，非代码） |
| 出分 | 服务端在隐藏标签上确定性计算 |

**关键结论：本地 GPU 是否作弊这个问题直接消失**——平台从不依赖那台机器。
剩余的唯一公平性风险是「分数 oracle 过拟合」，由提交限次与（Phase 2）私有榜承担。

### 1.4 现状证据（实测）

| 事实 | 证据 |
| --- | --- |
| 已有类 Kaggle 的 artifact 提交链路 | `noj-core/src/domains/submission/services/submissions/artifact-submissions.ts` |
| Solution 入口硬编码 `submission.py` | `noj-judge/src/dual/mod.rs:43,434-438` |
| 支持包（含 `hidden.jsonl`）只注入 Evaluator | `noj-judge/src/dual/mod.rs:190-218,423-431` |
| 每用例必须带布尔 `hidden`，缺失整份剥离 | `noj-core/.../submission-projection.ts:112-134` |
| 评测路径统一走双容器 | `noj-judge/src/judge/runner.rs:106` → `dual::evaluate_dual_with_cpu_limit_and_user_llm` |
| 容器无 GPU、无 bind mount | `noj-judge/src/sandbox/host_config.rs:24,28`（`binds: None`、`device_requests: None`） |
| Solution `/workspace` 为 512M tmpfs | `noj-judge/src/dual/container.rs:201` |
| artifact 不支持重测、评测后对象即删 | `submissions-rejudge.ts:80-82`、`submissions-result.ts:230-245`、`sweeper.ts:483-527` |
| `submission_mode` CHECK 仅 `code`/`artifact` | `noj-core/src/shared/db/schema/catalog.ts:64-67` |

---

## 2. Decision

新增第三种提交模式 **`prediction`（预测提交题）**：

- 选手从题面外链下载公开数据 → 本地 GPU 训练/推理 → 上传**单个预测结果文件**；
- noj-core 接收单文件、校验扩展名与魔数、落对象存储、构造 JudgeTask；
- noj-judge **只创建 Evaluator 容器**（不创建、不执行 Solution，无 NDJSON 编排），
  把支持包与预测文件注入 Evaluator，执行 `evaluate.py`；
- `evaluate.py` 读预测文件 + 隐藏标签，确定性算分，输出标准 `---RESULT---`；
- 其余（结果构造、投影、状态机、限次、SSE、榜单）完全复用现有链路。

### 2.1 关键取舍

| 取舍 | 结论 | 理由 |
| --- | --- | --- |
| 数据集托管 | **平台不管**，题面外链 | 项目所有者决策；避免在 Phase 1 引入大数据集存储与 CDN 治理 |
| 模式信号 | JudgeTask 新增顶层 `submission_mode` 枚举 | 显式优于靠字段缺席推断；便于日志与调度分支 |
| `runtime_config.solution` | 改为**可选**；prediction 模式省略 | prediction 无 Solution 容器，强制填一个不用的镜像属伪配置。模式**只由显式 `submission_mode` 判定**，不靠字段缺席推断 |
| 预测文件存储列 | **复用** `submissions.artifact_storage_url` | 免费复用「评测后删除 / 不支持重测 / 孤儿清理 / 相似度排除」四套生命周期 |
| 大小上限字段 | **复用** `problems.artifact_max_size_mb` | 同为「提交产物大小上限」，避免多余迁移 |
| 判分路径 | 新增单容器「数据评分」路径 | prediction 无不可信代码执行，攻击面比现有双容器**更小** |
| pickle | **明令禁止** | 反序列化即任意代码执行，与「数据非代码」前提冲突 |
| 重测 | **不支持**（与 artifact 一致） | 预测文件一次性，赛后需重算时重新提交 |
| 分数可见性 | 与现有提交一致（本人可见） | 与 Kaggle 公开榜语义一致；过拟合由限次 + Phase 2 私有榜控制 |
| 服务端 GPU 复算 | **不做** | 与「本地 GPU」目标冲突，且平台无高性能 GPU |

---

## 3. 变更清单（按模块）

### 3.1 契约层（core ↔ judge，同一提交改完）

- `noj-core/src/domains/submission/types/index.ts`：
  - 新增 `export type JudgeSubmissionMode = "code" | "artifact" | "prediction";`
  - `JudgeTask` 新增必填 `submission_mode: JudgeSubmissionMode`；
  - `BuildJudgeTaskInput` 新增必填 `submission_mode`；
  - `buildJudgeTask` 无条件写入该字段；
  - `JUDGE_TASK_FIELDS` 新增 `"submission_mode"`。
- `noj-core/src/domains/submission/types/index.ts`（同一文件）：`RuntimeConfig.solution` 改为可选。
- `noj-core/src/domains/catalog/types/runtime-config.ts`：
  - `RuntimeConfig.solution` 改为 `solution?: SolutionRuntime;`；
  - `EvaluatorRuntime` 增加**可选** `workspace_size_mb?: number`（prediction 专用，缺省用
    judge 的 `JUDGE_PREDICTION_WORKSPACE_MB`）。
- `noj-core/src/domains/catalog/types/problem-bundle.ts` / `problems-types.ts`：
  - `validateRuntimeConfig` 对 `submission_mode === "prediction"` 允许省略 `solution`；
  - `submission_mode` 取值校验扩为三值。
- `noj-judge/src/types.rs`：
  - `RuntimeConfig.solution` 改为 `Option<SolutionRuntime>`；
  - 新增 `pub submission_mode: String`，带
    `#[serde(default = "default_submission_mode")]`（缺省 `"code"`，兼容在途旧消息）；
  - 新增 `fn default_submission_mode() -> String { "code".into() }`；
  - `EvaluatorRuntime` 增加 `#[serde(default)] pub workspace_size_mb: Option<u64>`。
- `noj-tests/fixtures/judge-task.contract.json`：新增 `"submission_mode": "artifact"`。
- `noj-core/.../tests/types/judge-task-contract.test.ts`：字段集补 `"submission_mode"`。
- `noj-judge/tests/judge_task_contract.rs`：字段集与断言同步。
- 全部 `buildJudgeTask` 调用点补 `submission_mode`：
  `submissions-crud.ts`（`code`）、`submissions-rejudge.ts`（两处，按源提交推导）、
  `artifact-submissions.ts`（`artifact`）、`self-tests.ts`（`code`）、
  `sweeper.ts`（按源提交推导）。

### 3.2 noj-core：prediction 提交服务与路由

- 新增 `noj-core/src/domains/submission/services/submissions/prediction-submissions.ts`，
  结构对齐 `artifact-submissions.ts`：
  - 模式校验：`problem.submission_mode === "prediction"`；
  - **单文件**上传（`file` 字段），大小上限 = `min(problem.artifact_max_size_mb, NOJ_ARTIFACT_MAX_SIZE_MB)`；
  - 扩展名白名单：`.csv` / `.tsv` / `.jsonl` / `.json` / `.npy` / `.npz` / `.parquet`；
  - 魔数校验：
    - `.npz` → `PK\x03\x04`；`.npy` → `\x93NUMPY`；`.parquet` → `PAR1`；
    - 结构化文本（`.csv`/`.tsv`/`.jsonl`/`.json`）→ 前 4KB 不得含 NUL 字节；
  - **显式拒绝 pickle 类**：扩展名黑名单（`.pkl`/`.pickle`/`.pt`/`.pth`/`.bin`/`.joblib`/`.ckpt`）
    + 魔数检测（pickle 协议头 `\x80\x04`/`\x80\x05`）→ 400 `PREDICTION_FORMAT_REJECTED`；
  - 存储 key `artifacts/<uuid>.<ext>`（复用 `artifacts/` 前缀，便于既有治理脚本覆盖）；
  - `language = "python3"`（占位，保持列非空）；
  - `buildJudgeTask({ ..., submission_mode: "prediction" })`；
  - 插入 `submissions`，`artifact_storage_url` 承载预测文件 URL（见 §2.1）；
  - 入队失败清理、pending 超时清理、评测后删除——**全部复用**现有 artifact 生命周期。
- `noj-core/src/domains/submission/routes/submissions.ts`：
  `POST /api/v1/submissions` multipart 分支按 `problem.submission_mode` 分派到
  `createPredictionSubmission` / `createArtifactSubmission`。
- `noj-core/src/domains/contest/routes/contests.ts`：竞赛提交 multipart 分支同样分派。
- `noj-core/src/shared/db/schema/catalog.ts`：`problems_submission_mode_check`
  扩为 `IN ('code', 'artifact', 'prediction')`；
  `src/shared/db/schema-ddl.ts` 同步该 CHECK。
- 新增迁移（`deno task db:generate`）：DROP + ADD CHECK 约束。
  不涉及 `ADD COLUMN ... NOT NULL`，迁移安全门禁不触发。

### 3.3 noj-judge：单容器数据评分路径

- 新增模块 `noj-judge/src/prediction/mod.rs`：
  - `pub async fn evaluate_prediction(...)`：
    1. 支持包缓存优先下载（复用 `judge/runner.rs::fetch_and_cache_support_package`）；
    2. 预测文件一次性下载 + SHA-256 校验（复用 `fetch_artifact_package` 形态）；
    3. 白名单复验（镜像前缀 `JUDGE_IMAGE_PREFIX`、命令白名单、网络开关）；
    4. **只创建 Evaluator 容器**（复用 `dual::container.rs::create_container_with_security`）；
    5. 注入支持包 → `/workspace`（复用 `dual::inject_support_package_to_evaluator`）；
    6. 注入预测文件 → `/workspace/prediction/<file_name>`（复用流式注入原语，见下一条）；
    7. exec `runtime_config.evaluator.command`，实时收集 stdout/stderr；
    8. 解析 `---RESULT---`（复用 `dual::protocol::LineParser`）；
    9. 构造 `JudgeResult`（复用 `dual::build_judge_result`）→ `destroy`。
  - 超时/OOM 归因复用现有 `finalize_outcome` 语义（总超时 → `SystemError`）。
- `noj-judge/src/judge/runner.rs`：`evaluate_with_cpu_limit` 按 `task.submission_mode`
  分派：`"prediction"` → `prediction::evaluate_prediction`，其余 → 现有双容器路径。
- `noj-judge/src/lib.rs`：导出 `prediction` 模块（供集成测试）。
- 注入原语抽取：新增**单文件流式注入**
  `inject_file_stream_to_container(docker, id, host_path, container_path)`，
  边读边 `tar | docker exec tar xf -`（不整文件读入内存），供 prediction 预测文件使用；
  与现有 `inject_support_package_to_evaluator`（zip 专用）并存，避免预测文件误走 zip 路径。
- 结果构造与协议解析（`build_judge_result` / `finalize_outcome` / `LineParser`）
  按需提升可见性（若目前为私有），在 prediction 模块中**复用而非复制**。
- **`/workspace` 容量**：prediction 模式使用 `evaluator.workspace_size_mb`（题目级），
  缺省取 judge 配置 `JUDGE_PREDICTION_WORKSPACE_MB`（默认 `2048`），
  覆盖 `dual/container.rs:201` 的 512M 默认值。
  注意 tmpfs 占用 RAM；若预测文件很大，备选方案是对 `/workspace/prediction`
  使用**只读 host bind mount**（host_config 已支持 `binds`，当前为 `None`）。
  本设计采用可配置 tmpfs，bind mount 留 Phase 2。

### 3.4 Evaluator SDK：预测加载与常用度量

- 新增 `noj-judge/sdk/evaluator/noj_evaluator_sdk/prediction.py`：
  - `load_predictions(path=None) -> PredictionBundle`：自动识别格式、返回行/列/ID 集合；
  - **绝对禁止 pickle**：`.npz` 一律 `np.load(..., allow_pickle=False)`；
    其它格式不调用任何反序列化器；
  - 格式/对齐校验：预测行数、ID 列与隐藏标签的匹配（缺失/多余 ID 报可读错误）；
  - 常用确定性度量：`accuracy` / `f1_score` / `rmse` / `mae` / `roc_auc`；
  - 与 `result` 集成，直接输出 `details.cases[]`（每项带布尔 `hidden`）。
- 导出至 `noj_evaluator_sdk/__init__.py`。

### 3.5 noj-ui

- 题目编辑器：`submission_mode` 增加第三项「预测提交题（prediction）」；
  沿用 `artifact_max_size_mb` 作为大小上限输入。
- 做题页：prediction 模式显示**单文件上传**入口 + 题面外链数据集 + 「本地自评」指引；
  不再要求 `submission.py`。
- 结果页：复用现有渲染（`details.cases[]`），预测题无 Solution 调用耗时语义差异说明。

### 3.6 文档

- 新增 `noj-docs/docs/problemsetters/prediction-problems.md`：
  出题规范（公开数据外链约定、预测文件格式与 ID 对齐、`evaluate.py` 写法、禁止 pickle）；
- `noj-docs/docs/users/submit.md`：新增「预测提交」小节；
- `noj-docs/docs/standards/test-data.md`：补「公开数据 / 隐藏标签分离」约定与
  prediction 题的 `details.cases[]` 要求；
- `noj-docs/docs/mechanisms/runtimes.md`：补 prediction 单容器运行时；
- 重生成 `dev-docs/engineering/route-catalog.md`（若无新增路由，`--check` 应无变更）。

### 3.7 决策记录

- 新增 Agent Note
  `.agents/notes/implemented/feature/2026-09-21-local-gpu-prediction-submission.md`
  （记录「本地 GPU 出分的信任边界」与「判据不出服务端」这一不可动摇约束）。

---

## 4. 公平性与安全

| 风险 | 对策 | 归属 |
| --- | --- | --- |
| 本地伪造结果 | 本地不参与判分，隐藏标签永不出服务端 | 架构（根本） |
| 分数 oracle 过拟合 | 复用 per-problem `submission_limits`；Phase 2 私有榜 | 运营 + Phase 2 |
| 恶意 pickle 反序列化 | 扩展名黑名单 + 魔数检测 + SDK `allow_pickle=False` | Phase 1 |
| 大文件 / zip 炸弹 | 单文件上限 + 流式注入 + 可配置 workspace 上限 | Phase 1 |
| 隐藏标签泄漏进 `details` | 沿用 `submission-projection.ts`（缺 `hidden` 标记整份剥离） | 复用 |
| 预测与标签错位 | SDK 强制 ID 对齐校验，错位即报告 | Phase 1 |
| 度量不可复现 | 内置确定性度量；自定义度量须文档声明确定性 | Phase 1 |
| 出题人换数据导致分数失真 | 文档化出题人责任（平台不托管数据集，无法锚定一致性） | 已知限制 |

> **不可动摇约束**：任何 prediction 评测的隐藏标签、标准答案、评分脚本均不得写入选手可见的
> 响应（含 `output` / `details`），也不得下发到选手机器。这是本模式公平性的唯一基石。

---

## 5. 执行顺序（保证 `main` 每步可部署）

1. **契约 + 双侧结构体（同一提交，保证可编译）**：core `types/index.ts` 新增
   `submission_mode` 与可选 `solution`，**同时**补齐全部 `buildJudgeTask` 调用点的
   实参（`code`/`artifact`/按源推导）；Rust `types.rs` 镜像为 `Option` + 默认值。
   `main` 此时仍可部署：wire 上仅多一个值。
2. **judge 单容器路径**：`prediction` 模块 + `runner.rs` 分派 + 流式注入原语；
   此时 core 尚未发 prediction 任务，零影响。
3. **core**：prediction 服务/路由/schema/迁移 + 题目校验放开 `solution` 可选。
4. **UI + 文档 + Agent Note**。
5. **门禁**：`deno fmt` / `deno lint`、`cargo fmt` / `cargo clippy`、
   `gen-route-catalog --check`、`check-migration-snapshot-chain`、
   `check-migration-safety`、契约测试、`verify-agent-note-format`。

---

## 6. 验证

- **契约**：core 与 judge 两侧契约快照字段集一致且含 `submission_mode`；
  未带该字段的旧 payload 在 Rust 侧解析为 `"code"`。
- **core**：prediction 提交服务/路由测试——模式校验、扩展名/魔数拒绝、
  pickle 拒绝、大小上限、竞赛分支、入队失败清理。
- **judge**：单容器路径单元测试（不依赖 Docker）+ `NOJ_RUN_E2E=1` E2E——
  合成支持包（含 `hidden.jsonl`）与预测文件，验证「注入 → 评分 → `---RESULT---`」
  以及超时归因；断言**不创建 Solution 容器**。
- **SDK**：`load_predictions` 各格式 + `allow_pickle=False` 行为 + ID 错位报错 + 度量数值。
- **端到端**（noj-tests）：上传预测文件 → 服务端隐藏标签出分 → 结果落库与投影。
- **迁移**：在**存量库**上执行新迁移成功（非仅空库）。
- **文档**：`vitepress` 构建链接检查通过；`verify-agent-note-format.ts` 通过。

---

## 7. Alternatives considered

- **方案 1：约定式 artifact（模板 shim + 预测文件塞进 zip）**：不改 core/judge，仅靠出题约定。
  受 NDJSON RPC 类型与 512M tmpfs 限制，无格式治理，语义是 hack。**否决**，不作产品形态。
- **方案 3：服务端 GPU 重跑（选手交代码/权重）**：与「本地 GPU」目标冲突，需服务端 GPU，
  平台已明确无高性能 GPU。**否决**。
- **用 `runtime_config.solution` 可选来隐式表达模式**：字段缺席即「无 Solution」。
  隐式且与题目 `submission_mode` 重复。**否决**，改用显式顶层字段。
- **平台托管公开数据集**：项目所有者明确「出题人自行外链」。**移出范围**。
- **新增 `prediction_max_size_mb` / 新存储列**：多一次迁移与四套生命周期接线，
  收益仅为命名清晰。**否决**，复用现有字段与列。
- **支持 prediction 重测**：与「预测文件一次性、评测后删除」冲突，且重算需求可重新提交。
  **否决**。
- **Phase 1 就做公开榜/私有榜**：私有榜是 oracle 过拟合的正解，但可独立交付，
  且需竞赛侧改造。**推迟到 Phase 2**。

---

## 8. Consequences

- **正面**：在**不削弱现有信任边界**的前提下支持本地 GPU 出分；prediction 路径
  **没有不可信代码执行**，攻击面小于现有双容器；复用 artifact 生命周期与契约骨架，
  改动集中在「新增一条判分路径」；为后续 ML/GPU 题与大数据集奠定形态。
- **负面**：平台不托管数据集，无法校验公开数据与隐藏标签的一致性（出题人责任）；
  Phase 1 无私有榜，过拟合仅由提交限次约束；预测文件受容器 `/workspace` 容量限制。
- **中性**：`artifact_storage_url` 列同时承载 artifact zip 与 prediction 文件，语义略宽
  （设计已记录）；`runtime_config.solution` 在 prediction 模式下省略（字段可选）。

---

## 9. Phase 2（本设计显式不做）

1. 大数据集托管与独立上传入口（GB 级）。
2. 竞赛**公开榜 / 私有榜**（最终成绩取私有榜），防 oracle 过拟合。
3. prediction 重测 / 赛后用新标签重算。
4. `/workspace/prediction` 只读 host bind mount（替代大 tmpfs 的 RAM 占用）。
5. 服务端复算可选（交模型权重而非预测文件），需 GPU 执行器。
