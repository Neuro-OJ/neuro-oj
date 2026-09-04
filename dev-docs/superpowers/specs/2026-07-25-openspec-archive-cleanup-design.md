# OpenSpec 三变更归档收尾 — 设计文档

> 日期：2026-07-25
> 范围：将 `openspec/changes/` 下三个已落地但未归档的变更（`add-noj-docs`、`dual-container-judge`、`remove-single-container-mode`）正式归档，并把 spec 增量同步到 `openspec/specs/` 主规范。
> 类型：流程债清理；不改任何运行时模块、不改 API、不改 schema、不改消息协议。

---

## 1. Context

NOJ 当前 `openspec/changes/` 目录有三个活跃变更（不算 `archive/`），实际状态如下：

| 变更 | proposal | design | tasks | specs/ | 实现 |
|---|---|---|---|---|---|
| `add-noj-docs` | ✅ | ✅ | ✅ 26/26 全 [x] | — 无 | ✅ |
| `dual-container-judge` | ✅ | ✅ | ⚠️ 39 项全 [ ] | ✅ 3 份增量 | ✅ PR #146/#148 |
| `remove-single-container-mode` | ❌ 缺 | ✅ | ❌ 缺 | — 无 | ✅ 提交 `7e00a8f1` |

仓库主 `openspec/specs/`（56 个规范）的当前状态：

- `judge-worker/spec.md` — 仅有单容器路径（被 `dual-container-judge` 增量 ADDED 扩充前）
- `judge-image-whitelist/spec.md` — 不含 `kind` 字段（被 MODIFIED 扩充前）
- `problem-runtime-config/` — **目录不存在**（需新建）
- `container-pool/spec.md` — 含 PoolManager 全套规则，但 `pool/` 模块已删除（被 `remove-single-container-mode` 撤销）

OpenSpec 工作流卡点：

1. `add-noj-docs` 已实质完成（tasks 全 [x]），但**未 archive**，spec/ 未删除。
2. `dual-container-judge` 实现已落地，但 `tasks.md` 全 [ ]（文档与代码漂移），且 3 份 spec 增量**未 sync 到主 specs**。
3. `remove-single-container-mode` 只有 design.md，缺 proposal + tasks，无法满足 OpenSpec "三件套"基本结构，且无 spec 增量（因为它要移除的内容藏在 `dual-container-judge` 的主 spec 里）。
4. `judge-worker` 主 spec 在 dual-container-judge ADDED 后仍含单容器相关 scenarios；在 remove-single-container-mode 后这些 scenarios 失去对应实现。
5. `container-pool` 主 spec 整体失效（`pool/` 模块已被删除）。

---

## 2. Goals / Non-Goals

**Goals：**

- 三个变更按 OpenSpec 标准归档（含 proposal/design/tasks 三件套与 spec 增量）。
- 主 `openspec/specs/` 反映当前实现：双容器为唯一路径，镜像白名单带 `kind`，新建 `problem-runtime-config` 规范。
- 不丢失单容器历史信息（保留在 archive 与 design.md 中），但主 spec 不再有失效场景。
- `container-pool` 主规范合理处置（归档或保留 + 废弃说明）。

**Non-Goals：**

- 不修改任何运行时模块（noj-core / noj-ui / noj-judge）。
- 不修改 API、数据库 schema、消息协议。
- 不做新功能；不开新变更。
- 不动 `openspec/changes/archive/` 下任何已归档历史。
- 不修复 `pool/mod.rs` 1050 行等技术债（属于其他 OpenSpec 变更范畴）。
- 不动 `add-noj-docs` 已落地的 `noj-docs/` 文档站内容。

---

## 3. 术语

- **delta spec**：变更目录下的 `specs/<capability>/spec.md`，含 `## ADDED / MODIFIED / REMOVED / RENAMED Requirements`。
- **主 spec（main spec）**：`openspec/specs/<capability>/spec.md`，是仓库的真理来源。
- **三件套**：OpenSpec 变更要求 proposal.md + design.md + tasks.md 三份文件齐全（虽然官方规范允许省略，本项目历史归档均带齐）。

---

## 4. Decisions

### Decision 1：先补齐 `remove-single-container-mode` 的 proposal + tasks，再归档

**选择**：从 `design.md` §Migration Plan 提炼出 6 个步骤作为 `tasks.md`（全部勾上 [x]，因为提交 `7e00a8f1` 已落地）；再回溯式写 `proposal.md`，按现有两套 proposal 模板风格（与 `add-noj-docs`、`dual-container-judge` 同构）。

**理由**：
- 已归档的 49 个变更历史（如 `2026-07-02-simplify-judge-pool`）都带齐三件套。
- 缺失 proposal/tasks 直接归档会破坏 OpenSpec 一致性，导致后续 spec-history 浏览不可读。

**替代方案**：
- (A) 不补 proposal/tasks 直接 archive，附 README 说明；**否决**：破坏一致性，且 `openspec status` 会报缺失。
- (B) 删除整个变更目录当作"已通过 commit 完成"；**否决**：丢失设计意图与迁移步骤的文档资产。

### Decision 2：先 sync-specs 到主 specs，再 archive

**选择**：按 OpenSpec 流程惯例，在 archive 之前先 sync delta spec 到主 spec。sync 采用 agent-driven intelligent merging（仓库 `.claude/skills/openspec-sync-specs/SKILL.md` 已文档化此流程）。

**理由**：
- archive 后的 delta spec 文件被移走；若主 spec 尚未同步，spec 真理来源（main spec）将**缺失**新增内容。
- sync 是 additive 操作，不会破坏 archive 后只读状态。
- 与现有 OpenSpec 工作流惯例一致。

### Decision 3：`container-pool` 主 spec 整体归档到 `archive/2026-07-25-container-pool-superseded/`

**选择**：将 `openspec/specs/container-pool/spec.md` 移到 `openspec/changes/archive/2026-07-25-container-pool-superseded/spec.md`（保留 spec.md，但归类为历史），主 specs 目录不再有 `container-pool`。

**理由**：
- `remove-single-container-mode` 已删除 `pool/` 模块、移除 `JudgeMode::Single`、移除 `POOL_*` 环境变量。
- `container-pool` 主 spec 描述的 PoolManager 行为、池大小、健康检查、文件注入等**全部无对应实现**。
- 保留在主 specs 会误导读者；归档更准确反映"该设计已被撤销"。

**替代方案**：
- (A) 保留主 spec 但加废弃 banner（"DEPRECATED 2026-07-25 by remove-single-container-mode"）；**否决**：仍占用主 spec 路径，目录列表含失效规范。
- (B) 删除主 spec 文件；**否决**：丧失历史追溯。

**注意**：archive/ 下历史规范通常对应已 archive 的变更（`<YYYY-MM-DD>-<change-name>/spec.md`）。本处置不与任何变更挂钩，仅作为"被取代的独立 spec"归档——会在 archive 目录顶部加 `README.md` 说明缘由。

### Decision 4：`judge-worker` 主 spec 拆分单容器专属 scenarios，保留下载/缓存/校验等共用部分

**选择**：把 `dual-container-judge/specs/judge-worker/spec.md` 的 ADDED Requirements 合并进主 spec；对当前主 spec 内的 scenarios 做精细化拆解而非整段删除。

**A. 整段删除的 Requirement block**：

| 删除块 | 当前主 spec 行号 | 理由 |
|---|---|---|
| `Requirement: 并发控制`（含"无空闲容器时即时创建 / 并发任务完成释放"） | 当前主 spec 第 148-162 行 | `pool/` 模块已删，无 Idle/InUse 概念 |

**B. `Requirement: 评测编排` block 内逐 Scenario 处理**（当前主 spec 第 64-147 行）：

| Scenario | 动作 | 理由 |
|---|---|---|
| 评测成功（s3 模式） | **保留**（移入重构后的"评测编排"） | 双容器路径仍走 download_url → s3 下载支持包 → 注入 Evaluator `/workspace` |
| 评测成功（base64 模式） | **保留**（移入重构后的"评测编排"） | 同上，base64 内嵌 |
| 无支持包时跳过 | **保留** | 双容器路径仍适用 |
| 下载/解码失败返回 SystemError | **保留** | 双容器路径仍适用 |
| 完整性校验失败 | **保留** | 双容器路径仍适用 |
| 评测超时（exec > time_limit_ms） | **删除** | 单容器 exec 模型；双容器总时间超时由 ADDED `Evaluator 总时间超时` 覆盖 |
| 评测脚本无有效输出 | **删除** | 解析 `---RESULT---` 标记是单容器约定；双容器走 NDJSON |
| 用户代码运行时错误 | **删除** | 单容器 exec 退出码语义；双容器 Solution 异常由 ADDED `错误码枚举 Exception` 覆盖 |
| 容器内存超限（OOM 137） | **删除** | 单容器 OOM；双容器 Evaluator OOM 由 ADDED 单独 scenario 覆盖，Solution OOM 由 ADDED 单独 scenario 覆盖 |
| 容器创建失败（镜像问题） | **删除** | 单容器 shell exec 视角；双容器镜像创建失败落到 SystemError 兜底（无显式 scenario） |
| 返回资源消耗数据（time_ms / memory_kb） | **改写** | 改为：双容器模式下 `time_ms` 反映 Evaluator 容器总执行时间（含全部 SDK 调用），`memory_kb` 反映 Evaluator RSS 峰值；Solution OOM 不计入 |
| 临时目录在错误时仍清理 | **保留**（移入"容器清理 RAII 契约"已覆盖，由 ADDED 接管） | 双容器 RAII 已在 ADDED 显式描述 |

**C. 主 spec 结构调整**：保留一个**精简的"评测编排" Requirement**，只含下载/缓存/校验相关 scenarios（含上述 B 表中保留/改写项）；具体容器执行细节（含 time/memory）由 ADDED Requirements 接管。

**D. 新增**：把 `dual-container-judge/specs/judge-worker/spec.md` 全部 7 个 ADDED Requirement 块追加到主 spec：

1. 双容器评测编排（dual mode）
2. NDJSON 协议帧类型与字段
3. Log 消息限额
4. 输出缓冲约定
5. 容器清理 RAII 契约
6. 时间层级关系
7. 兼容性回退（**改写**："runtime_config 为 NOT NULL 必填；缺字段时 admin 创建/更新返回 400"）

### Decision 5：`judge-image-whitelist` 主 spec 合并 kind 字段升级

**选择**：把 `dual-container-judge/specs/judge-image-whitelist/spec.md` 的 MODIFIED Requirements 合并进主 spec。具体动作：

- `Requirement: 管理员管理镜像白名单` → 增加 `kind` 字段描述（必填，`evaluator` / `solution`），新增 4 个 scenario（添加 Evaluator / 添加 Solution / kind 缺失被拒 / kind 非法值被拒）。
- `Requirement: 题目创建/更新时校验镜像白名单` → 重命名为 `题目创建/更新时校验镜像白名单（含 kind）`，新增双容器相关 scenario（参考 delta spec 第 54-94 行）。
- `Requirement: 公开镜像列表 API` → 重命名为 `公开镜像列表 API（按 kind 过滤）`，新增 `?kind=` 查询参数 scenario。
- 新增 `Requirement: get_image_allowlist RPC 响应升级`，含 2 个 scenario（RPC 含 kind、历史数据迁移 kind 默认值）。

**保留**：`Requirement: 全版本模式安全警告` 不变。

### Decision 6：新建 `problem-runtime-config` 主 spec

**选择**：把 `dual-container-judge/specs/problem-runtime-config/spec.md` 全部 ADDED Requirements 作为新主 spec，目录 `openspec/specs/problem-runtime-config/spec.md`。

**注意**：ADDED 中的 "admin 清空 runtime_config 回退单容器" 场景（lines 46-52）和"提交流程按 runtime_config 路径分流"的"runtime_config IS NULL 走单容器"场景（lines 62-72），与 `remove-single-container-mode` **直接冲突**。这些场景需在 sync 时**改写或剔除**：

- "清空回退单容器" → 删除（清空回退路径已不存在；保留"清空"动作但 outcome 改为 422/400）。
- "runtime_config IS NULL 走单容器" → 改写为"runtime_config 为 NOT NULL 必填，缺字段时 admin 创建/更新返回 400"。
- "runtime_config 非 NULL 走 dual" → 保留（这是当前行为）。

这本质上是 `remove-single-container-mode` 的"残留 spec 清理"工作，应该作为 remove 变更的一部分在 sync 阶段同步处理。

### Decision 7：`dual-container-judge` 的 tasks.md 按 PR 落地映射勾选

**选择**：对照 git log 与 PR #146/#148/#155 的实际落地范围，勾选以下已实际完成的任务；保留未勾选（[ ]）的任务作为后续 tracking：

**全部勾选 [x]**（代表 PR-A1/A2/B/C 全部完成）：
- 1.1-1.5：协议 + SDK + types（PR-A1 已合并）
- 2.1-2.5：Docker E2E + orchestrator（PR-A2 已合并）
- 3.1-3.9：生产镜像 + judge_images.kind（PR-B 已合并）
- 4.1-4.9：DB + core API + UI（PR-C 已合并）
- 5.1：spec 增量落盘（已在 `changes/dual-container-judge/specs/`，由本次 sync 任务完成）
- 5.2：`openspec archive dual-container-judge`（本次操作完成）
- 6.1-6.7：关键检查点（PR 合入均过 CI）

**保留 [ ]**（明确未做）：
- 5.3, 5.4：原 tasks.md 中"archive 同步时自动完成"的描述**改为 [ ]**，因为本项目 sync 是 agent-driven 而非自动；本次清理时手动同步。
- 原 task 1.5 内的 `host 用户代码 raise 返回 Exception + sanitize trace` 改为 [x]（已实现）；其他子项已实现也勾上。

### Decision 8：`remove-single-container-mode` 补写的 tasks.md

**选择**：基于 `design.md` §Migration Plan 6 个步骤写为 task group，每步聚合为 1-2 个 task：

```markdown
## 1. 样例题 + seed 更新
- [x] 1.1 更新 1001/1002/1003 的 evaluate.py 为双容器 NDJSON 协议
- [x] 1.2 更新 seed 脚本使用 runtime_config 替代 judge_image/judge_command

## 2. 数据库 Schema 更新
- [x] 2.1 Drizzle 迁移：删除 problems.judge_image、problems.judge_command 列，runtime_config 改为 NOT NULL

## 3. noj-core 代码更新
- [x] 3.1 修改 types/index.ts：移除 JudgeMode，RuntimeConfig 相关类型保留
- [x] 3.2 修改 services/submissions.ts：移除模式判断，始终使用 runtime_config
- [x] 3.3 修改 services/problems.ts：移除 judge_image/judge_command 字段
- [x] 3.4 修复 rejudge 路径

## 4. noj-judge 代码更新
- [x] 4.1 移除 JudgeMode 枚举、pool/ 模块
- [x] 4.2 简化 runner.rs：只保留 dual 相关逻辑
- [x] 4.3 简化 main.rs：移除模式分流
- [x] 4.4 清理 POOL_* 环境变量（除 POOL_MEMORY_MB / POOL_CPU / POOL_KILL_GRACE_SECONDS）

## 5. noj-ui 代码更新
- [x] 5.1 移除 ProblemEditor.vue 中的 dualMode 开关
- [x] 5.2 移除 judge_image/judge_command 表单字段
- [x] 5.3 始终渲染 RuntimeConfig 表单

## 6. 测试更新
- [x] 6.1 更新 noj-judge 单元测试（移除 JudgeMode::Single 引用、pool 测试）
- [x] 6.2 更新 noj-core 服务测试
- [x] 6.3 更新 E2E 测试
```

注：实际提交流程上 `7e00a8f1` 已经覆盖；后续 6.3 的"E2E 测试更新"即 `e2e/15_dual_container_judge.test.ts`。

---

## 5. Execution Plan

按以下顺序执行（**前序步骤失败时回退到上一步**）：

### 步骤 1：补 `remove-single-container-mode` 工件

- 创建 `openspec/changes/remove-single-container-mode/proposal.md`（约 80-120 行）：
  - Why：单容器与双容器并存造成代码复杂度 + rejudge 路径 bug + Phase 1 收尾需要。
  - What Changes：移除 JudgeMode 枚举、judge_image/judge_command 列、pool/ 模块、相关环境变量；样例题同步切换。
  - Capabilities → Modified：`judge-worker`（移除单容器路径相关 scenarios）、`container-pool`（整体撤销）。
  - Impact：noj-core / noj-judge / noj-ui / 数据库 migrations（具体列文件）。
- 创建 `openspec/changes/remove-single-container-mode/tasks.md`（按 Decision 8 的 6 个 task group）。

### 步骤 2：sync `dual-container-judge` 的 3 份增量到主 specs

- **2.1 新建** `openspec/specs/problem-runtime-config/spec.md`：
  - 取 `dual-container-judge/specs/problem-runtime-config/spec.md` 全部 ADDED Requirements。
  - **改写**：删 "清空回退单容器" 场景；改 "runtime_config IS NULL 走单容器" 场景为 "runtime_config 缺字段校验失败"。
  - 加 Purpose 段（项目级开场，与现有主 spec 同构）。

- **2.2 修改** `openspec/specs/judge-image-whitelist/spec.md`：
  - 按 Decision 5 合并 MODIFIED 内容；保留全版本警告 requirement。

- **2.3 修改** `openspec/specs/judge-worker/spec.md`：
  - 按 Decision 4 删除单容器专属 requirement blocks；
  - 追加 `dual-container-judge/specs/judge-worker/spec.md` 全部 7 个 ADDED Requirements；
  - 改写"兼容性回退"段为"runtime_config 必填校验"。

- **2.4 修改** `openspec/specs/container-pool/` 处置：
  - 按 Decision 3 移到 `openspec/changes/archive/2026-07-25-container-pool-superseded/`；
  - 在 archive 目录加 `README.md` 说明取代时间与依据（引用 `remove-single-container-mode`）。

### 步骤 3：勾选两个变更的 tasks.md

- `openspec/changes/dual-container-judge/tasks.md` 按 Decision 7 勾选。
- `openspec/changes/remove-single-container-mode/tasks.md` 在步骤 1 已勾全。

### 步骤 4：archive 三个变更

按 OpenSpec 标准归档命名 `YYYY-MM-DD-<name>/`：

- `add-noj-docs` → `archive/2026-07-25-add-noj-docs/`（保留 proposal/design/tasks；无 specs 子目录）
- `dual-container-judge` → `archive/2026-07-25-dual-container-judge/`（保留 proposal/design/tasks + specs/）
- `remove-single-container-mode` → `archive/2026-07-25-remove-single-container-mode/`（保留 proposal/design/tasks；无 specs 子目录）

每个目录的 `.openspec.yaml` 与目录一起 move（保留 manifest）。

### 步骤 5：验证与提交

- 5.1 跑 `openspec validate`（如果 CLI 可用）或人工 grep 验证三件套齐全；
- 5.2 跑 `deno fmt --check`（如果改了 OpenSpec 目录下的 `.md`，需要确保格式与仓库一致）；
- 5.3 git diff 审查：检查 `openspec/specs/` 与 `openspec/changes/` 的最终结构；
- 5.4 单个 commit + 中文 Conventional Commits 描述：`docs(openspec): 归档 add-noj-docs/dual-container-judge/remove-single-container-mode 并同步 spec 增量`；
- 5.5 GPG 签名（如已配置）。

---

## 6. 涉及的具体文件清单

### 6.1 创建

| 文件 | 用途 |
|---|---|
| `openspec/changes/remove-single-container-mode/proposal.md` | 回溯式 Why/What/Capabilities/Impact |
| `openspec/changes/remove-single-container-mode/tasks.md` | 6 个 task group 全 [x] |
| `openspec/specs/problem-runtime-config/spec.md` | 新主规范 |
| `openspec/changes/archive/2026-07-25-container-pool-superseded/README.md` | 解释为何归档 |
| `openspec/changes/archive/2026-07-25-add-noj-docs/` 等 3 个目录 | 归档目录（由 mv 创建） |

### 6.2 修改

| 文件 | 变更 |
|---|---|
| `openspec/specs/judge-worker/spec.md` | 删除单容器 requirement blocks；追加 7 个 ADDED Requirements；改"兼容性回退"为"runtime_config 必填校验" |
| `openspec/specs/judge-image-whitelist/spec.md` | 合并 kind 字段 MODIFIED Requirements |
| `openspec/changes/dual-container-judge/tasks.md` | 按 Decision 7 勾选 |

### 6.3 删除（move 而非 rm）

- 三个变更目录：`openspec/changes/{add-noj-docs,dual-container-judge,remove-single-container-mode}/`
- `openspec/specs/container-pool/` 整个目录

---

## 7. Verification

### 7.1 静态检查

- [ ] `openspec/changes/` 下只剩 archive 子目录（无 active 变更）
- [ ] `openspec/specs/problem-runtime-config/spec.md` 存在且带 Purpose + Requirements 段
- [ ] `openspec/specs/judge-worker/spec.md` 包含以下 Requirements：任务拉取 / 结果发布 / JudgeTask 结构 / 评测编排（精简版，仅含下载/缓存/校验） / 支持包缓存 / 缓存淘汰（LRU） / 临时文件管理 / zip 完整性校验 / 双容器评测编排 / NDJSON 协议帧类型与字段 / Log 消息限额 / 输出缓冲约定 / 容器清理 RAII 契约 / 时间层级关系 / runtime_config 必填校验（原兼容性回退改写）
- [ ] `openspec/specs/judge-image-whitelist/spec.md` 包含以下 Requirements：管理员管理镜像白名单（含 kind） / 题目创建/更新时校验镜像白名单（含 kind） / 公开镜像列表 API（按 kind 过滤） / 全版本模式安全警告 / get_image_allowlist RPC 响应升级
- [ ] `openspec/specs/judge-worker/spec.md` 不再含 `Requirement: 并发控制`、单容器 exec 流程相关 scenarios（评测超时 / 评测脚本无有效输出 / 用户代码运行时错误 / 容器内存超限 / 容器创建失败）
- [ ] `openspec/specs/container-pool/` 不再存在于主 specs 目录
- [ ] 3 个 archive 子目录结构对称：proposal.md + design.md + tasks.md（必要时 specs/）
- [ ] `archive/2026-07-25-container-pool-superseded/` 存在并带 README

### 7.2 内容一致性

- [ ] 三个 archive 目录的 tasks.md 全部勾上 [x]
- [ ] `judge-worker` 主 spec 不再含 `JudgeMode::Single`、`pool/` 模块、`POOL_*` 环境变量相关描述
- [ ] `problem-runtime-config` 主 spec 不再含"清空回退单容器"或"IS NULL 走单容器"场景

### 7.3 不变性

- [ ] `noj-core/`、`noj-ui/`、`noj-judge/` 源代码零改动
- [ ] 数据库迁移文件零改动
- [ ] GitHub Actions 配置零改动
- [ ] `docker-compose*.yml` 零改动

---

## 8. Risks / Trade-offs

| 风险 | 缓解 |
|---|---|
| `problem-runtime-config` 主 spec 的"清空回退单容器"场景若保留，与 `remove-single-container-mode` 冲突 → 用户读 spec 时困惑 | Decision 6 已明确改写/剔除策略 |
| `judge-worker` 主 spec 移除单容器 requirement 后，是否破坏现有测试断言？测试文件本身不在 OpenSpec 范围 | 本变更不改测试；同步 spec 是"文档层"动作，与代码层解耦 |
| `container-pool` 主 spec 归档后，原引用此规范的其它 spec（如 `judge-e2e-test`）若引用失效 | 步骤 5.3 之前必须先 `grep -r 'container-pool' openspec/specs/` 验证；若有引用则改为引用 `judge-worker` 主 spec 相关章节 |
| 三个变更的 archive 日期统一为 2026-07-25 致目录名冲突（与 `2026-07-25-container-pool-superseded` 等其他今日可能存在的 archive） | archive 时先 `ls` 检查同名；冲突则改用 `-v2` 后缀 |
| `openspec validate` CLI 在本机不可用 | 步骤 5.1 改用人工 grep 校验 |
| 实施期任何 sync-specs 误改导致主 spec 失真 | Decision 4/5/6 给出精确的保留/删除/合并清单；步骤 5.3 git diff 审查兜底 |

---

## 9. Out of Scope

- **不开新 OpenSpec 变更**——这是清理动作，不是功能。
- **不动运行时模块**——即使是"清理 tasks.md 与 PR 落地映射"这种半文档工作，也不涉及 `pool/mod.rs` 拆分或 metrics 恢复等结构性改造（属于 P1 改进项）。
- **不动 `add-noj-docs` 已落地的 `noj-docs/` 内容**——只搬目录。
- **不修历史归档目录**——只新建本批次 3 + 1 = 4 个 archive 子目录。

---

## 10. Open Questions

（无——所有关键决策已在本 spec 内闭合。）