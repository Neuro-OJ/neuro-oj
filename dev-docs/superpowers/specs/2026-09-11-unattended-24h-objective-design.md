# 无人值守 24 小时目标设计（题库建设 + 平台改进）

Status: approved
日期：2026-09-11
执行者：AI Agent（无人值守自主执行）
批准人：项目所有者（人在回路讨论后批准，预算上限 24h）

---

## 1. 目标

以**题库建设**为主轴，为 Neuro OJ 交付一批**原创、可评测、可复现、可验收**的 AI 领域题目；并修复阻碍可信验收的基线红灯，补齐题库仓库的 CI 与若干平台改进项。

所有产出以 **分支 + Draft PR** 交付，**绝不推送到 main**。验收以 **Draft PR 的 CI 运行结果**为准。

---

## 2. 已确认的关键约束（人在回路讨论结论）

| 约束 | 内容 | 来源 |
| --- | --- | --- |
| 非目标 | **多语言评测不是本项目目标**，不得投入 | 用户明确 |
| 硬件约束 | 运营者**无高性能 GPU** → 禁止大模型微调、本地推理；LLM 仅可通过 `noj-llm-gateway` API 调用 | 用户明确 |
| 题目来源 | **全部原创命题**，不复制 LMCC 官方真题内容（仅借鉴知识大纲与题型风格） | 用户选择 |
| 交付边界 | **只推分支 + Draft PR，绝不碰 main** | 用户明确 |
| 验收方式 | **以 Draft PR 的 CI 运行结果为验收标准** | 用户明确 |
| 主交付 | 题库建设（新题 3 编程 + 1 LLM，方案 A）；平台改进为并行工作项 | 用户选择 |
| 质量纪律 | 可靠性由后续 code review 兜底，但每项交付必须自证（测试/证据） | 用户明确 |

---

## 3. 基线实测结论（本次调查获得，为设计依据）

> 以下均为**实测证据**，非推测。这些结论修正了 ROADMAP 与 plans 的失真描述。

### 3.1 基线不是绿的，但性质已定性

**问题 A：`deno task test:parallel` 5 个失败，且 main 固有**

- 实测结果：`905 passed | 5 failed | 11 ignored`
- 失败清单（5 个，跨 4 个文件）：
  - `content-review: enqueueReview 落库 + 同目标去重 + 审计`
  - `contests routes: 公开访问、注册、题目、排名与管理端 CRUD`
  - `contest settlement: 未结束禁止发布，结束后允许无待处理任务发布`
  - `contest settlement: 失败评测需说明并显式允许后才能发布`
  - `contest ranking snapshot: 重复发布按序生成唯一版本`
- 典型错误：`insert or update on table "contest_ranking_snapshots" violates foreign key constraint "contest_ranking_snapshots_contest_id_contests_id_fk"`（父行刚插入却报外键失败）
- **关键证据**：在 `main`（`8d6600ae`）的独立 worktree 上跑出**完全相同的 5 个失败** → 与 PR #484 无关，是 **main 固有的测试分片竞态**
- **反向证据**：`deno task test:domain contest`（带 `JWT_SECRET`）为 **38 passed / 0 failed** → 单独跑域内测试全绿，问题只在 `test:parallel` 分片并发下出现
- 结论：**测试基座竞态缺陷**，非产品缺陷

**问题 B：main 的 `Judge Sandbox E2E` 红灯是 flaky**

- main 最新提交 `8d6600ae` 的 E2E 运行中 `Judge Sandbox E2E` = failure
- 失败用例：`noj-judge/tests/e2e_abnormal.rs:207` `support_package_missing_still_finished`
  - 断言「无支持包也应 finished」，实得 `status: "error"`
- **关键证据链**：
  1. `git diff origin/main..origin/observability-domain -- noj-judge/` = **0 文件**（该分支完全不碰 judge）
  2. `git merge-base origin/main origin/observability-domain` = `8d6600ae`（judge 代码完全相同）
  3. PR #484 的 `Judge Sandbox E2E` = **pass**
  4. 历史 8 次 main E2E 运行中 7 次 judge sandbox 通过
- 结论：**flaky 测试**（时序/环境敏感），非确定性产品缺陷

**问题 C：本地 `deno task test:domain <domain>` 需外部传入 `JWT_SECRET`**

- 未传时 4 个测试因 `环境变量 JWT_SECRET 未设置，无法签发 JWT` 失败
- `scripts/test-domain.sh` 自身不加载 `.env`，注释声明「CI 会显式传入」
- 这是**开发体验缺陷**（本地与 CI 不一致），非产品缺陷

### 3.2 仓库真实状态（修正 ROADMAP/plans 失真）

- **ROADMAP 双向失真**：既漏报已实现项（成绩单 CSV/JSON 导出、judge 三级优先级队列、队列背压都已存在），也虚报（Agent Note 声称的 judge ZIP 模糊测试，全仓 `fuzz` grep = 0 命中）
- **plans 的 checkbox 不可信**：31/38 份存在未勾项，但对应工作早已上线（`2026-09-03-noj-core-organization-refactor.md` 有 139 未勾，对应域化重构已交付）→ **禁止当作待办清单**
- 完全未实现项（grep 验证 0 命中）：SPJ/交互题、代码相似度检测、A/B 榜、IOAI/NOAI 赛制、评测插件机制、备份调度、迁移回滚
- **真实缺陷**：judge 的 per-user 公平调度使用**各 worker 进程本地**的 `active_users` 集合（`noj-judge/src/main.rs:123-149`），N 个 worker 时同一用户可并发 N 个评测 → 公平性限制静默失效
- 测试规模：noj-core 174 个测试文件（`tests/` 38 + `src/domains/*/tests/` 136）；noj-tests/e2e 45 个测试文件

### 3.3 可用资源

- **基础设施全部在线**：PostgreSQL 5432 / Redis 6379 / MinIO 9000 / llm-gateway 8001（已 Up 12h+）
- **评测镜像齐全**：`noj-evaluator-python:latest`、`noj-solution-python`、`noj-e2e-*`
- **judge 二进制已编译**：`noj-judge/target/release/noj-judge`
- **`llm-mock` 服务存在于 `docker-compose.e2e.yml`**（端口 8002，返回固定 OpenAI 兼容响应）→ **LLM 题可在无真实 Provider 下端到端验收**
- 当前 `llm_providers` 表 **0 行**（无真实 Provider）→ LLM 题的真实模型质量需 Owner 配置 Provider 后复验
- 开发库数据：0 题 / 3 用户 / 0 竞赛 → 导入测试无污染风险
- GPG 双配置就绪（git `commit.gpgsign=true` + jj `signing.behavior=own`，同一密钥）
- **Draft PR 确实会触发 CI**（无 draft 跳过条件），job 粒度细（`Core <domain>`、`Judge Check`、`E2E <Domain>`、`Judge Sandbox E2E`）

### 3.4 仓库与分支事实

- `neuro-oj`：当前工作副本在 `observability-domain` 分支（PR #484 已开，全部检查通过）
- `main` = `origin/main` = `8d6600ae`
- `noj-problems`：独立仓库（`Neuro-OJ/noj-problems`），**无任何 CI**（无 `.github/workflows`）
- `noj-problems` 存在**未提交 WIP**：40 文件 / +4177 −501（今日 13:08–13:26 改动），44 个自测全绿、`verify_scenarios.py` 0 ERROR

---

## 4. 交付物与执行顺序

用户指示「按顺序执行」。以下为串行优先级；每项独立可交付，未达门禁者降级为「进行中」写入报告，**不做半成品提交**。

| # | 交付物 | 仓库 | 分支 | 内容 |
| --- | --- | --- | --- | --- |
| D0 | **基线转绿** | neuro-oj | `fix/baseline-stability` | 修 `test:parallel` 分片竞态（问题 A）；稳定 judge sandbox flaky 用例（问题 B）；修 `test-domain.sh` 本地 `JWT_SECRET` 缺陷（问题 C） |
| D1 | **noj-problems WIP 固化** | noj-problems | `feat/trial-snowy-manor-polish` | 审阅 WIP → 规范对齐 → 提交 → Draft PR，并在其上继续 |
| D2 | **noj-problems CI** | noj-problems | 同 D1 | 新增 CI workflow（题目自测 + 剧本校验 + bundle 构建 + manifest 校验），使「Draft PR CI 验收」标准成立 |
| D3 | **新题 4 道**（方案 A） | noj-problems | 每题独立分支 | 3 编程题 + 1 LLM 工程题，全部原创 |
| D4 | **平台改进项 5 项** | neuro-oj | 每项独立分支 | 见 §6 |
| D5 | **平台代码审查与改进** | neuro-oj | 独立分支 | 在 D0–D4 完成后，按 §7 限定范围执行 |
| D6 | **证据与自审** | 两仓 | — | 验收证据文档 + 工作日志 + 待人工 review 清单 + PR 收尾 |

---

## 5. 新题设计（D3，方案 A）

### 5.1 硬约束

- **原创命题**，不复制任何官方真题内容；仅参考 CCF/LMCC 大纲的**知识模块划分**与题型风格
- 纯 CPU 可评测（编程题）；LLM 题仅通过 `noj-llm-gateway` API
- 遵循 `noj-docs/docs/standards/quality.md` 与 `problem-bundle.md`
- 标题须含来源署名（原创题标注为原创，不使用官方来源标签）

### 5.2 题目清单

**P 型编程题（3 道，纯 CPU Python）**

| # | 题目（slug） | LMCC 模块 | 核心评测要点 |
| --- | --- | --- | --- |
| 1 | `decoding-sampler` 解码采样器实现 | 解码与部署 | temperature / top-k / top-p / 重复惩罚；边界：全 `-inf`、并列最大值、`p→0`、`k>V` |
| 2 | `bpe-tokenizer` BPE 分词器 | 大模型基础概念 | 训练 + 编码；Unicode 边界、合并顺序稳定性、空输入、未见字符 |
| 3 | `llm-metrics` LLM 评测指标 | 模型评测 | pass@k 无偏估计、ECE 分桶、置信区间；数值精度与退化输入 |

**P 型 LLM 工程题（1 道，走 gateway API）**

| # | 题目（slug） | LMCC 模块 | 核心评测要点 |
| --- | --- | --- | --- |
| 4 | `rag-cited-qa` 带引用的检索问答 | 智能体 / 知识应用 | 检索质量 + 引用可核验 + LLM judge 评分；**反刷分**：防硬编码答案与关键词蒙分 |

### 5.3 每题交付物（缺一不可）

```text
<slug>/
├── problem.json      # manifest（format_version=1；LLM 题含 llm 字段 + evaluator 联网）
├── statement.md      # 题面（描述/输入/输出/样例/数据范围/提示）
├── README.md         # 本题入口：结构、运行方式、评分口径
├── evaluate.py       # 评测脚本（zip 根级；标准 details.cases 输出）
├── template.py       # 选手模板（必须不含可满分实现）
├── visible.jsonl     # 可见用例（样例即测试，不计分）
├── hidden.jsonl      # 不可见用例（正式评分）
└── tests/            # 题目自测
```

---

## 6. 平台改进项（D4，用户选定 6 项）

| # | 项目 | 现状（实测） | 规模 | 验收要点 |
| --- | --- | --- | --- | --- |
| 1 | **noj-problems CI** | 完全无 CI | S | workflow 可在 PR 上跑通：题目自测 + `verify_scenarios.py` + bundle 构建 + manifest 校验 |
| 2 | **judge 跨 worker 并发公平性缺陷** | per-worker 本地 `active_users`，N worker 时限制失效（真缺陷） | S/M | 多 worker 场景下同一用户并发受限；有回归测试 |
| 3 | **代码相似度检测** | 完全空白（`contest-anti-cheat.ts` 仅 IP 分组/时间线） | M | token 归一 + k-gram winnowing 指纹；竞赛窗口内比对输出相似对；雷同提交命中、正常提交不误报 |
| 4 | **成绩单导出补全** | 端点已有但仅「最新一版」，UI 无下载入口 | S/M | 历史版本导出端点 + UI 下载按钮；断言列头与行数 |
| 5 | **题目包脚手架 `noj-cli problems init`** | 只有样例，无生成器 | S/M | 生成 `problem.json`/`evaluate.py`/`template.py` 后可通过 `import-bundle` 校验 |
| 6 | **Judge ZIP fuzz 测试** | 文档声称已做，实际 0 命中（doc drift） | S | 补随机字节模糊测试（固定种子、有界迭代），消除文档漂移 |

---

## 7. 验收标准（分级硬门禁）

### L0 — 全局门禁（每个 PR 必须满足）

- **neuro-oj**：`deno fmt --check` + `deno lint` + `deno task check:types` + 相关域测试全绿
- **noj-problems**：题目自测全绿 + `verify_scenarios.py` **0 ERROR** + bundle 构建成功
- 中文 Conventional Commits；**GPG 签名有效**；非平凡变更附 Agent Note（`deno run -A scripts/verify-agent-note-format.ts` 通过）
- **main 零改动**（可验证：分支上 `git log origin/main..HEAD` 非空，且 `git log HEAD..origin/main` 为空）
- **Draft PR 的 CI 结论为验收硬证据**

### L1 — 每题门禁（9 条，缺一不可）

1. **包可导入**：manifest 通过校验；zip 根级含 `evaluate.py`；无 `REPLACE_WITH_*` 占位符残留
2. **判定正确**：参考解 → 预期 AC；`template.py` 原样提交 → **非 AC**（防空提交蒙分）；≥2 个负例（WA/TLE/RE/边界）判定正确
3. **隐藏数据零泄露**：`details.cases[]` 每项含 `case_id`/`status`/`hidden`（**布尔值**）；隐藏用例不含 input/expected/output
4. **样例即测试**：题面样例作为可见用例运行、不计分、输出选手友好调试信息
5. **确定性**：无随机/时间依赖（或固定种子）；同输入两次评测结果一致
6. **题目自测**：题目目录内 `tests/` 全绿
7. **规范对齐**：标题含署名；tags 2–8 个且用大纲通用术语；`template.py` 不含可满分实现；难度与数据强度匹配
8. **平台 E2E**：跑通「导入 bundle → 提交参考解 → judge 评测 → 预期判定」全链路（LLM 题可用 `llm-mock` 验证链路）
9. **反刷分**（LLM 题必做）：零推理/盲搜策略得 0 分，且有回归测试守住

### L2 — 交付完整性

每题独立 README + 根 README 索引更新 + 验收证据文档 + 工作日志 + 待人工 review 清单

---

## 8. 分支与提交策略（jj stacked 模式）

**版本管理统一使用 jj（Jujutsu），不使用 git 命令做本地操作，不使用 git worktree 隔离。**

- **基线**：当前工作副本基线 `840fa455`（`observability-domain` 分支 = PR #484 tip）。所有新工作 stacked 在其之上。
- **单栈串行**：不使用并行工作区，在当前工作副本按 §4 顺序推进。
- **小步快跑**：每个可独立验收的**小改动**打一个 jj change（`jj commit -m "..."` / `jj new`）。
- **每目标一 bookmark**：每个独立交付目标（D0、D4.1、D4.2 …）在其**末个 change** 上打一个 bookmark，形成 stacked 链。
- **Draft PR**：每个 bookmark 推一个 GitHub **Draft PR**，PR base 指向**栈中前一个 bookmark**（首个指向基线），从而每个 PR 只展示自身改动。
- 提交信息：中文 Conventional Commits，`<type>(<scope>): <描述>`；jj `signing.sign-all = true` 保证签名。
- **绝不推送或合并到 main、绝不在 main 上落提交、绝不 force-push 他人分支**。

### 栈结构

**neuro-oj**（base = `840fa455`）：

```text
840fa455 (observability-domain / PR #484)
  └─ docs/unattended-24h-spec        设计+验收标准文档
       └─ fix/baseline-stability     D0 基线转绿
            └─ test/judge-zip-fuzz   D4.6
                 └─ fix/judge-global-user-cap  D4.2
                      └─ feat/code-similarity   D4.3
                           └─ feat/ranking-export  D4.4
                                └─ feat/cli-problems-init  D4.5
                                     └─ review/platform-audit  D5
```

**noj-problems**（base = 其 main + 用户 WIP）：

```text
<baseline + WIP>
  └─ feat/trial-snowy-manor-polish   D1 WIP 固化
       └─ ci/problems-ci             D2 题库 CI
            └─ feat/prob-decoding-sampler  D3.1
                 └─ feat/prob-bpe-tokenizer D3.2
                      └─ feat/prob-llm-metrics D3.3
                           └─ feat/prob-rag-cited-qa D3.4
```

---

## 9. 风险与处置

| 风险 | 处置 |
| --- | --- |
| 基线非绿 → 无法区分「我引入的失败」 | D0 先修并记录「绿基线快照」，作为后续所有失败对照基准 |
| e2e 栈端口冲突（8001 被运行中的 dev gateway 占用） | 复用已运行的 dev 中间件；必要时临时停 dev gateway，并在日志说明 |
| LLM 题无真实 Provider（`llm_providers` 0 行） | 用 compose 内置 `llm-mock` 验证链路；真实模型质量留待 Owner 配置 Provider 后复验，报告中明确标注该边界 |
| 24h 内做不完 | **完整性 > 数量**；未达 L1 的题不半途提交，降级为工作日志进行中项 |
| 无人值守卡死 | 同一失败**尝试上限 3 次**，超限即记录根因并跳过；每 checkpoint 写进度日志保证可续 |
| 用户 WIP 被破坏 | 不动用户工作副本；用独立 worktree + 独立分支；WIP 原样固化，不重构其设计 |

---

## 10. 明确不做（YAGNI）

- ❌ 多语言评测（用户明确非目标）
- ❌ 考试模式 / A-B 榜 / IOAI 赛制 / 评测插件机制（L 规模，本轮不做）
- ❌ 大模型微调、本地推理（无 GPU）
- ❌ 触碰 main、合并 PR、改 `_journal.json`、手改 `deno.lock` / `Cargo.lock`
- ❌ 与题库及上述改进项无关的平台重构
- ❌ 使用 LMCC/IOAI/NOAI 官方真题内容（版权风险）

---

## 11. 交付证据要求

执行结束时必须产出：

1. **验收证据文档**：逐项列出交付物、对应 PR 链接、CI 结论、验证命令与实测输出
2. **工作日志**：时间线、每项状态（完成/进行中/未开始）、遇到的问题与处置
3. **待人工 review 清单**：需 Owner 决策或复验的事项（如 LLM 题真实模型质量）
4. **PR 清单**：所有 Draft PR 链接与状态

---

## 12. 与既有工作的关系

- **与 PR #484（observability-domain）**：完全独立。D0 修的是 main 固有缺陷，不依赖也不影响 #484
- **与 `noj-problems` WIP**：D1 将其固化，不重构其设计意图
- **与 PR #471（noj-cli-script-sync-phase1）**：`noj-cli problems init` 若触及相同文件需避开冲突，必要时改基或调整范围
