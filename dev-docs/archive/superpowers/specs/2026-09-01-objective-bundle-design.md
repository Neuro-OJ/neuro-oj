# 客观题套卷加入统一题目包设计

- 日期：2026-09-01
- 状态：已与需求方确认，待用户审阅
- 范围：noj-core（题目包解析/校验/导入服务）、noj-cli（构建/导入）、OpenSpec 规范、noj-docs 文档、测试

## 背景

Neuro OJ 已完整支持客观题套卷（`is_objective=true` + `objective_questions` 表 + 服务端即时判定），但统一题目包（Problem Bundle）目前只覆盖 U/P 评测题：

- `problem.json` 强制 `runtime_config`；
- zip 强制根级 `evaluate.py`；
- 导入服务总是创建/更新带评测包的题目。

现有 OpenSpec 规范和 noj-docs 均明确“客观题套卷不通过统一题目包导入，走 Web 编辑器/API 管理”。本次需求希望把客观题套卷纳入统一题目包，支持**批量导入/迁移**，使客观题套卷也能像编程题一样通过 zip 构建、导入、幂等更新。

## 目标

- 统一题目包支持客观题套卷变体：`problem.json` 增加 `is_objective` 可选字段，`questions.json` 承载小题。
- 客观题包不要求 `evaluate.py` / `runtime_config`，导入后不产生评测包存储。
- 支持与编程题一致的幂等更新语义（admin 按 `(type, number)` 更新）。
- 同步更新 OpenSpec 规范、noj-docs 文档与测试。

## 非目标

- 不做数据库 → zip 的客观题导出。
- 不做客观题提交重测（导入更新不自动重测，历史提交保持原判定结果）。
- 不升级 `format_version`，保持 v1 向后兼容。
- 不改变客观题 CRUD/判定/竞赛集成等既有行为。

## 关键决策

1. **方案 A：在现有统一题目包内做“客观题变体”**。`problem.json` 增加可选 `is_objective`，`questions.json` 独立承载小题；保持 `format_version=1`。
2. **小题承载**：独立 `questions.json` 文件，manifest 保持简洁。
3. **导入语义**：支持幂等更新——admin 提供 `number` 时按 `(type, number)` 匹配，命中则更新元数据并全量替换小题；未命中则创建。非 admin 提供 `number` 仍 400。
4. **重测**：导入更新不自动重测，历史提交保持原判定结果；重测作为独立后续功能。
5. **范围**：仅导入/构建，不做导出。

## 设计内容

### 1. 题目包格式

`problem.json` 新增可选字段 `is_objective`（boolean，缺省 `false`）。

当 `is_objective: true` 时：

- **不要求** zip 根级 `evaluate.py`，也**不要求** `runtime_config`。
- **必须**包含根级 `questions.json`（小题数组）。
- `statement.md` / `manifest.description` 仍二选一（作为套卷说明/题面），文件优先。
- `type` 仍为 `U`/`P`，缺省 `U`；`number` 幂等键语义与编程题一致。
- `tags` 支持，但沿用现有规则：客观题禁止关联算法标签。
- 编程题专属字段若出现则拒绝（HTTP 400）：`runtime_config`、`llm`、`template`、`submission_mode`、`artifact_max_size_mb`；`samples` 忽略（预留字段）。

`questions.json` 结构（数组，每项对应现有 `CreateQuestionInput`）：

```json
[
  {
    "type": "single",
    "prompt": "题干",
    "options": [{ "key": "A", "text": "选项A" }],
    "answer": ["A"],
    "explanation": "解析（可选）",
    "sort_order": 1
  }
]
```

- `sort_order` 可选，缺省按数组顺序从 0 开始；重复或非法则 400。
- 校验复用现有 `validateAnswerForType` / `validateOptions` 等。
- 至少 1 道小题，空套卷导入直接 400。

包结构示例：

```text
objective-paper.zip
├── problem.json      # is_objective: true
├── questions.json    # 小题数组
└── statement.md      # 可选
```

### 2. 解析器改动（`src/lib/bundle-parser.ts`）

- `parseBundleZip` 目前强制根级 `evaluate.py`。改为：先解析 `problem.json`，若 `is_objective === true` 则不要求 `evaluate.py`；否则维持原要求。
- 解析结果增加 `questions` 字段（`questions.json` 内容，不存在为 `null`）。
- 客观题包不调用 `stripMetadataEntries`（没有要存储的“纯净评测包”）。

### 3. 类型与校验改动（`src/types/problem-bundle.ts`）

- `ProblemBundleManifest` 增加 `is_objective?: boolean`。
- `validateBundleManifest` 增加分支：
  - `is_objective=true`：禁止 `runtime_config` / `llm` / `template` / `submission_mode` / `artifact_max_size_mb`（提供则 400）；`samples` 忽略。
  - `is_objective=false` 或缺省：维持现有必填 `runtime_config`。
- 新增 `validateObjectiveQuestions(raw)`：校验 `questions.json` 为数组、每项题型/选项/答案/解析/排序合法，且至少 1 道。

### 4. 导入服务改动（`src/services/problems/problem-bundle.ts`）

- `importProblemBundle` 解析后按 `manifest.is_objective` 分流：
  - **客观题**：不剥离/上传评测包，`support_package_storage_url` 保持 `NULL`；创建/更新套卷行（`is_objective=true`、`runtime_config=NULL`），并在同一 DB 事务内**全量替换小题**（删除旧小题 + 插入新小题）。
  - **编程题**：维持现有流程。
- 幂等更新：admin 提供 `number` 时按 `(type, number)` 匹配；命中则更新元数据 + 全量替换小题；未命中则创建。非 admin 提供 `number` 仍 400。
- 权限：与现有导入一致——U 型普通用户可创建（无 `number`），P 型仅 admin；客观题沿用 U/P 权限规则。
- 标签：沿用 `resolveTagIds` + `syncProblemTags`，客观题禁止算法标签由现有校验保证。
- 错误处理：`questions.json` 缺失/非法/空数组、字段非法、`sort_order` 冲突均返回 400。
- **不自动重测**：导入更新只影响后续提交；历史 `objective_submissions` 保持原判定结果。

### 5. CLI 构建/导入（`scripts/noj.ts`）

- `buildProblemPackage` 对客观题源目录无需大改：现有 `zip -r` 打包逻辑可直接复用，排除规则（`submission*`、模板、`__pycache__`、`.git`）对客观题目录无害。
- 客观题源目录约定：`problem.json`（含 `is_objective: true`）+ `questions.json` + 可选 `statement.md`，不需要 `evaluate.py`。
- `importProblemPackages` 无需改动，直接复用 `importProblemBundle`，自动按 `is_objective` 分流。
- 可选：在 `data/problems-src/` 增加一个客观题示例目录，方便开发/文档演示。

### 6. 规范与文档

- OpenSpec：新增变更，修订 `openspec/specs/problem-bundle-import/spec.md`：
  - 把“客观题套卷不通过统一题目包导入”改为“客观题套卷支持通过统一题目包导入”。
  - 补充 `is_objective` 字段、`questions.json` 结构、条件必填规则、导入语义（幂等更新、全量替换小题、不自动重测）。
  - 如需要，同步 `openspec/specs/objective-questions/spec.md` 补充“可通过题目包导入”的说明。
- noj-docs：
  - `noj-docs/docs/standards/problem-bundle.md`：更新包结构、manifest 表、特殊题型章节（客观题从“不通过”改为“支持”，给出 `questions.json` 示例）。
  - `noj-docs/docs/features/objective.md`：更新“不通过统一题目包导入”为“支持通过统一题目包导入”。

### 7. 测试

- `tests/routes/problem-bundle.test.ts` 新增客观题包导入用例：
  - 创建客观题套卷（无 `evaluate.py`/`runtime_config`）成功；
  - admin 提供 `number` 幂等更新（元数据 + 全量替换小题）；
  - 非 admin 提供 `number` 被拒；
  - `questions.json` 缺失/空/字段非法/`sort_order` 冲突 → 400；
  - 客观题包携带 `runtime_config`/`llm`/`template` 等 → 400；
  - 客观题禁止算法标签仍生效。
- 单元测试：`validateObjectiveQuestions`、`parseBundleZip` 对客观题包不要求 `evaluate.py`。
- 服务层测试：客观题导入创建/更新走事务，失败不产生半导入。

## 验证方式

- `deno task test` / `test:parallel` 通过。
- `deno fmt` / `deno lint` 通过。
- noj-docs 构建通过（`npm run docs:build` 或等价命令）。
- OpenSpec 变更按 `/opsx:propose` → 评审 → 实现 → `/opsx:apply` → `/opsx:archive` 流程执行。

## 后续流程

- 本设计文档经用户审阅后，进入 `writing-plans` 制定实施计划。
