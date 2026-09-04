# Neuro OJ 题目包格式与质量要求规范实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Neuro OJ 题目包格式规范进一步规范化，并新增题目质量建议规范，同步到 OpenSpec 与 noj-docs problemsetters 下的“题目规范及质量要求”子章节。

**Architecture:** 纯文档/规范变更。OpenSpec 侧新增一个变更目录，内含 `problem-bundle-import` delta spec 与新增 `problem-quality-guidelines` spec；noj-docs 侧在 `/problemsetters/standards/` 新增子章节，旧 `support-package.md` / `cases.md` 改为短重定向页。无代码、无数据库、无测试代码变更。

**Tech Stack:** Markdown、OpenSpec（spec-driven）、VitePress（noj-docs）、jj（版本控制）。

**Spec:** `dev-docs/superpowers/specs/2026-08-25-problem-format-and-quality-standards-design.md`

## Global Constraints

- 保持 `format_version=1`，不引入 v2。
- 题目包格式为 MUST（导入强制校验）；质量要求为 SHOULD/建议，不进入导入强制校验。
- 不改 noj-core / noj-judge 代码，不新增数据库字段。
- 文档语言为中文；代码标识符/文件名使用英文。
- 提交信息使用 Conventional Commits，description 中文，GPG 签名（jj 已配置）。
- 所有 OpenSpec 变更文件放在 `openspec/changes/problem-format-and-quality-standards/` 下，不直接修改 `openspec/specs/` 主规范（归档后由 `/opsx:sync` 同步）。

---

### Task 1: 创建 OpenSpec 变更骨架

**Files:**
- Create: `openspec/changes/problem-format-and-quality-standards/.openspec.yaml`
- Create: `openspec/changes/problem-format-and-quality-standards/proposal.md`
- Create: `openspec/changes/problem-format-and-quality-standards/design.md`
- Create: `openspec/changes/problem-format-and-quality-standards/tasks.md`

**Interfaces:**
- Consumes: 设计文档 `dev-docs/superpowers/specs/2026-08-25-problem-format-and-quality-standards-design.md`
- Produces: OpenSpec 变更目录骨架，后续 Task 2/3 写入 delta spec

- [ ] **Step 1: 创建 `.openspec.yaml`**

内容：

```yaml
schema: spec-driven
created: 2026-08-25
```

- [ ] **Step 2: 创建 `proposal.md`**

内容（可直接从设计文档“背景/目标/关键决策”提炼）：

```markdown
## Why

Neuro OJ 已有统一题目包导入规范，但文档与实现存在不一致（如 `categories` 已退役为 `tags`），且缺少题目质量建议规范。出题人缺少命名、tag、测试数据可见性、评测脚本质量等方面的成文指导。

## What Changes

- 修订 `problem-bundle-import` 规范：对齐 `tags`、补全包结构/版本/校验、标准化测试数据推荐约定、覆盖 LLM 调用题与客观题边界。
- 新增 `problem-quality-guidelines` 规范：题目命名（含来源署名）、tag 适用（含 LMCC 标签体系）、题面与数据质量、评测脚本质量、难度与发布流程、测试数据可见性策略。
- noj-docs 在 problemsetters 下新增“Neuro OJ 题目规范及质量要求”子章节，旧页面改为重定向。

## Capabilities

### Modified Capabilities
- `problem-bundle-import`: manifest 字段对齐、包结构/版本/校验补全、测试数据推荐约定、特殊题型说明。

### New Capabilities
- `problem-quality-guidelines`: 题目质量建议规范（SHOULD/建议，不强制）。

## Impact

- 仅文档与 OpenSpec 规范变更，无代码/数据库/测试变更。
- noj-docs 在 `/problemsetters/standards/` 新增子章节，更新导航与旧页面重定向。
```

- [ ] **Step 3: 创建 `design.md`**

将设计文档 `dev-docs/superpowers/specs/2026-08-25-problem-format-and-quality-standards-design.md` 的内容复制到该文件（保留全部章节）。

- [ ] **Step 4: 创建 `tasks.md`**

内容（后续任务清单，随实现勾选）：

```markdown
## 1. OpenSpec 变更骨架
- [ ] 1.1 创建 `.openspec.yaml` / `proposal.md` / `design.md` / `tasks.md`

## 2. 规范内容
- [ ] 2.1 编写 `specs/problem-bundle-import/spec.md`（delta）
- [ ] 2.2 编写 `specs/problem-quality-guidelines/spec.md`（新增）

## 3. noj-docs 文档
- [ ] 3.1 创建 `problemsetters/standards/` 章节四页
- [ ] 3.2 更新 VitePress sidebar
- [ ] 3.3 旧页面改重定向并更新交叉链接

## 4. 验证
- [ ] 4.1 grep 一致性检查
- [ ] 4.2 noj-docs 构建
```

- [ ] **Step 5: 提交**

```bash
jj describe -m "docs(root): 添加题目包格式与质量要求 OpenSpec 变更骨架"
```

---

### Task 2: 编写 `problem-bundle-import` delta spec

**Files:**
- Create: `openspec/changes/problem-format-and-quality-standards/specs/problem-bundle-import/spec.md`

**Interfaces:**
- Consumes: 设计文档第 1 节（题目包格式规范修订）
- Produces: 供 Task 3 引用的一致性基线；供后续 `/opsx:apply` 使用

- [ ] **Step 1: 创建 spec 文件**

内容（按 OpenSpec Requirements/Scenarios 风格，覆盖设计文档第 1 节全部要点）：

```markdown
## Purpose

修订统一题目包（Problem Bundle）导入规范：对齐 manifest 字段、补全包结构/版本/校验、标准化测试数据推荐约定、覆盖特殊题型边界。

## Requirements

### Requirement: manifest 字段对齐

系统 SHALL 在 `problem.json` 中使用 `tags`（字符串数组）作为标签字段，不再接受 `categories`。`tags` 按 name 匹配已有标签，缺省忽略 + warning。

#### Scenario: manifest 使用 tags

- **WHEN** `problem.json` 含 `"tags": ["入门", "LMCC 样例题"]`
- **THEN** 系统按标签名解析并关联已有标签；不存在的标签名被忽略并记录 warning

#### Scenario: manifest 使用已退役 categories

- **WHEN** `problem.json` 含 `"categories": [...]`
- **THEN** 系统返回 HTTP 400，提示使用 `tags` 字段

### Requirement: 包结构与版本

系统 SHALL 定义统一题目包结构：根级 MUST 包含 `problem.json` 与 `evaluate.py`，SHOULD 包含 `statement.md`，可包含 `visible.jsonl`/`hidden.jsonl`/`assets/` 等评测内容。`format_version` 当前 MUST 为 `1`，未知版本 MUST 返回 HTTP 400。

#### Scenario: 合法包结构

- **WHEN** zip 根级含 `problem.json`、`evaluate.py`、`statement.md`、`visible.jsonl`、`hidden.jsonl`、`assets/`
- **THEN** 系统接受该包为合法导入载体

#### Scenario: 未知 format_version

- **WHEN** `problem.json` 的 `format_version` 不是 `1`
- **THEN** 系统返回 HTTP 400，提示不支持的 manifest 格式版本

### Requirement: 测试数据推荐约定

系统 SHALL 在文档中推荐 JSONL 测试数据格式（`id`/`input`/`expected`/`score`/`tags`/`message`），并推荐目录约定 `visible.jsonl`/`hidden.jsonl` 或 `cases/visible/*.json`/`cases/hidden/*.json`。测试数据格式本身不强制，evaluator 自行读取。

#### Scenario: 文档提供推荐约定

- **WHEN** 出题人阅读统一题目包文档
- **THEN** 文档给出 JSONL 字段说明与目录约定，并说明格式不强制

### Requirement: 特殊题型边界

系统 SHALL 在规范中明确：LLM 调用题通过 manifest `llm` 字段配置（`provider_id`/`model`），必须 P 型 + evaluator 联网；客观题套卷不通过统一题目包导入，走 Web 编辑器/API 管理。

#### Scenario: LLM 字段校验

- **WHEN** `problem.json` 含 `llm` 且 type 非 P 或未开启 evaluator 网络
- **THEN** 系统返回 HTTP 400

#### Scenario: 客观题不通过包导入

- **WHEN** 用户尝试用统一题目包导入客观题套卷
- **THEN** 文档明确该路径不支持，应使用 Web 编辑器/API
```

- [ ] **Step 2: 自检**

确认 spec 覆盖设计文档第 1 节全部要点：tags 对齐、包结构/版本/校验、测试数据推荐约定、LLM/客观题边界。

- [ ] **Step 3: 提交**

```bash
jj describe -m "docs(root): 编写题目包格式 delta spec"
```

---

### Task 3: 编写 `problem-quality-guidelines` spec

**Files:**
- Create: `openspec/changes/problem-format-and-quality-standards/specs/problem-quality-guidelines/spec.md`

**Interfaces:**
- Consumes: 设计文档第 2 节（题目质量建议规范）
- Produces: 供 Task 4 文档页引用；供后续 `/opsx:apply` 使用

- [ ] **Step 1: 创建 spec 文件**

内容（按 OpenSpec Requirements/Scenarios 风格，质量项使用 SHOULD/建议语义；覆盖设计文档第 2 节全部要点）：

```markdown
## Purpose

定义 Neuro OJ 题目质量建议规范（SHOULD/建议，不强制）。面向出题人，覆盖题目命名、tag 适用、题面与数据质量、评测脚本质量、难度与发布流程、测试数据可见性策略。

## Requirements

### Requirement: 题目命名建议

系统 SHALL 在文档中建议：标题简洁准确无歧义；中文 5–30 字、英文 3–20 词；官方/样例题与第三方比赛题 MUST 在标题中标注来源，格式 `[来源] 题目名`；避免无信息量命名、题号/难度/类型前缀、emoji 与特殊符号。

#### Scenario: 来源署名示例

- **WHEN** 出题人创建 LMCC 官方题
- **THEN** 文档建议标题形如 `[LMCC-T 2026 第二轮] 数学作业批改助手`

### Requirement: tag 适用建议

系统 SHALL 在文档中建议：`problem` 标签用于来源/知识领域/题型/能力，`algorithm` 标签仅用于真正的算法/数据结构；LMCC 知识领域标签基于 CCF 大纲 12 模块；来源标签与能力/题型标签使用 `problem` kind；数量建议 2–5 个、最多 8 个；避免重复/过宽/过细/误导性标签；客观题不得关联算法标签。

#### Scenario: LMCC 知识领域标签

- **WHEN** 出题人为 LMCC 题选择标签
- **THEN** 文档提供 12 个知识领域标签（人工智能基础概念、大模型基础概念、模型架构、预训练技术、指令微调、人类对齐、解码与部署、提示学习、复杂推理、智能体、模型评测、模型伦理与安全）

### Requirement: 题面与数据质量建议

系统 SHALL 在文档中建议：题面包含描述/输入格式/输出格式/样例/数据范围/说明；样例覆盖典型与边界；数据范围明确；测试数据建议全部不可见；隐藏用例覆盖边界/极端/随机/压力；题面样例应作为 evaluator 可见自测用例，参与评测但不计分。

#### Scenario: 样例自测不计分

- **WHEN** evaluator 运行题面样例
- **THEN** 样例参与评测但不计分，并向选手展示友好调试信息

### Requirement: 评测脚本质量建议

系统 SHALL 在文档中建议：evaluator 健壮、可重复、不泄露隐藏数据、合理使用资源、不注册通用转发 capability、密钥不入包/题面、LLM 题走 gateway；样例自测输出明确易读的调试信息（结构化、标注输入/期望/实际/错误原因）。

#### Scenario: 调试信息明确易读

- **WHEN** evaluator 输出可见样例调试信息
- **THEN** 信息结构化、标注输入/期望/实际/错误原因，且不包含隐藏数据

### Requirement: 难度与发布流程建议

系统 SHALL 在文档中建议：难度与题面/数据强度匹配；发布前自测清单（参考答案提交、隐藏用例可见性、资源限制、rejudge）；P 型/LLM 题需 admin 审核。

### Requirement: 测试数据可见性策略

系统 SHALL 在文档中明确：LMCC 官方标准区分可见/不可见测试数据；Neuro OJ 建议全部正式评分数据使用不可见测试数据；样例可见、不计分、可展示调试信息；隐藏用例不可见、正式计分、不展示输入/期望/细节；evaluator MUST NOT 泄露不可见测试数据。

#### Scenario: 隐藏数据不泄露

- **WHEN** evaluator 生成用户可见结果
- **THEN** 不可见用例的输入、期望答案、评分细节不出现
```

- [ ] **Step 2: 自检**

确认 spec 覆盖设计文档第 2 节全部小节：命名、tag、题面/数据、评测脚本、难度/发布、可见性。

- [ ] **Step 3: 提交**

```bash
jj describe -m "docs(root): 新增题目质量建议规范"
```

---

### Task 4: 创建 noj-docs `problemsetters/standards/` 子章节

**Files:**
- Create: `noj-docs/docs/problemsetters/standards/index.md`
- Create: `noj-docs/docs/problemsetters/standards/problem-bundle.md`
- Create: `noj-docs/docs/problemsetters/standards/test-data.md`
- Create: `noj-docs/docs/problemsetters/standards/quality.md`

**Interfaces:**
- Consumes: 设计文档第 1/2/3 节内容
- Produces: 新章节页面，Task 5 接入导航，Task 6 更新旧链接

- [ ] **Step 1: 创建 `index.md`**

内容：

```markdown
# Neuro OJ 题目规范及质量要求

本大章节集中定义 Neuro OJ 的题目相关规范与质量建议，供出题人、审核者与运营者阅读。

## 内容导航

- [题目包格式规范](problem-bundle.md)：统一题目包 zip 结构、manifest 字段、版本与校验、特殊题型。
- [测试数据与样例规范](test-data.md)：测试数据推荐格式、可见/不可见语义、样例自测与调试输出。
- [题目质量要求](quality.md)：题目命名、tag 适用、题面与数据质量、评测脚本质量、难度与发布流程。

## 约束强度

- 题目包格式为**强制规范**（MUST）：导入时系统强制校验。
- 题目质量要求为**建议规范**（SHOULD）：不阻止导入，但推荐遵循。
```

- [ ] **Step 2: 创建 `problem-bundle.md`**

内容：将设计文档第 1 节内容改写为用户面向文档，必须包含：

- 包结构树（`problem.json`/`evaluate.py`/`statement.md`/`visible.jsonl`/`hidden.jsonl`/`assets/`）
- manifest 字段表（`format_version`/`title`/`runtime_config`/`number`/`difficulty`/`type`/`description`/`tags`/`samples`/`template`/`llm`）
- 明确 `tags` 取代 `categories`，`llm` 字段说明
- 版本与校验规则（`format_version=1`、zip 安全、tags 缺省忽略 + warning）
- 测试数据推荐约定（指向 `test-data.md`）
- 特殊题型：LLM 调用题、客观题套卷边界

- [ ] **Step 3: 创建 `test-data.md`**

内容：将设计文档第 1.3 节与第 2.3/2.4/2.6 节相关部分改写为用户面向文档，必须包含：

- 推荐 JSONL 字段：`id`/`input`/`expected`/`score`/`tags`/`message`
- 目录约定：`visible.jsonl`/`hidden.jsonl` 或 `cases/visible/*.json`/`cases/hidden/*.json`
- 可见/不可见语义
- Neuro OJ 建议全部正式评分数据使用不可见测试数据
- 样例自测不计分 + 调试信息明确易读
- evaluator 不得泄露隐藏数据

- [ ] **Step 4: 创建 `quality.md`**

内容：将设计文档第 2 节内容改写为用户面向文档，必须包含：

- 题目命名规范（含来源署名格式与示例）
- tag 适用规范（含 LMCC 12 知识领域标签、来源标签、能力/题型标签、数量与命名建议）
- 题面与数据质量
- 评测脚本质量
- 难度与发布流程
- 测试数据可见性策略

- [ ] **Step 5: 提交**

```bash
jj describe -m "docs(root): 新增题目规范及质量要求章节"
```

---

### Task 5: 更新 VitePress 导航

**Files:**
- Modify: `noj-docs/docs/.vitepress/config.ts`

**Interfaces:**
- Consumes: Task 4 创建的 `problemsetters/standards/` 页面
- Produces: 新章节出现在侧边栏

- [ ] **Step 1: 在 `/problemsetters/` sidebar 中新增“题目规范及质量要求”分组**

在 `"/problemsetters/"` 分区之前或之后插入：

```ts
"/problemsetters/": [
  // ... 出题 / 进阶分组 ...
  {
    text: "题目规范及质量要求",
    items: [
      { text: "总览", link: "/problemsetters/standards/" },
      { text: "题目包格式规范", link: "/problemsetters/standards/problem-bundle" },
      { text: "测试数据与样例规范", link: "/problemsetters/standards/test-data" },
      { text: "题目质量要求", link: "/problemsetters/standards/quality" },
    ],
  },
  // ...
],
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "docs(root): 更新文档导航加入题目规范章节"
```

---

### Task 6: 旧页面改重定向并更新交叉链接

**Files:**
- Modify: `noj-docs/docs/problemsetters/support-package.md`
- Modify: `noj-docs/docs/problemsetters/cases.md`
- Modify: `noj-docs/docs/problemsetters/index.md`
- Modify: `noj-docs/docs/problemsetters/quick-start.md`
- Modify: `noj-docs/docs/problemsetters/web-editor.md`
- Modify: `noj-docs/docs/operators/admin-guide.md`
- Modify: `noj-docs/docs/intro/faq.md`

**Interfaces:**
- Consumes: Task 4 新页面路径
- Produces: 旧链接不失效，文档指向新章节

- [ ] **Step 1: 将 `support-package.md` 改为短重定向页**

内容：

```markdown
# 统一题目包（Problem Bundle）

> 本文档已迁移至 [题目包格式规范](standards/problem-bundle.md)。
```

- [ ] **Step 2: 将 `cases.md` 改为短重定向页**

内容：

```markdown
# 测试数据

> 本文档已迁移至 [测试数据与样例规范](standards/test-data.md)。
```

- [ ] **Step 3: 更新 `problemsetters/index.md`**

在文档内容列表中加入新章节入口，例如：

```markdown
- **题目规范及质量要求**：题目包格式、测试数据与样例、题目质量要求，见[题目规范及质量要求](standards/)。
```

- [ ] **Step 4: 更新 `quick-start.md` 中的链接**

将 `[测试数据](cases.md)` 改为 `[测试数据与样例规范](standards/test-data.md)`，将 `[统一题目包](support-package.md)` 改为 `[题目包格式规范](standards/problem-bundle.md)`。

- [ ] **Step 5: 更新 `web-editor.md` 中的链接**

将 `[统一题目包](support-package.md)` 改为 `[题目包格式规范](standards/problem-bundle.md)`，将 `[测试数据](cases.md)` 改为 `[测试数据与样例规范](standards/test-data.md)`；同时将“分类”相关描述更新为“标签”（`categories` 已退役）。

- [ ] **Step 6: 更新 `operators/admin-guide.md` 中的链接**

将 `[出题人文档](../problemsetters/support-package.md)` 改为 `[题目包格式规范](../problemsetters/standards/problem-bundle.md)`；将“题目与分类”标题/描述更新为“题目与标签”。

- [ ] **Step 7: 更新 `intro/faq.md` 中的链接**

将 `[统一题目包](../problemsetters/support-package.md)` 改为 `[题目包格式规范](../problemsetters/standards/problem-bundle.md)`。

- [ ] **Step 8: 提交**

```bash
jj describe -m "docs(root): 旧题目文档改重定向并更新交叉链接"
```

---

### Task 7: 验证一致性

**Files:**
- 无新增文件；运行验证命令

**Interfaces:**
- Consumes: Task 1–6 全部产物
- Produces: 验证通过结论

- [ ] **Step 1: grep 确认 `categories` 不再作为 manifest 字段**

运行：

```bash
grep -rn '"categories"\|categories.*manifest\|manifest.*categories' noj-docs/docs --include='*.md' || true
```

预期：无输出（或仅出现在“已退役/迁移”说明中）。

- [ ] **Step 2: 确认新章节与 OpenSpec 内容一致**

运行：

```bash
grep -rn "LMCC-T 2026 第二轮\|人工智能基础概念\|全部使用不可见" noj-docs/docs/problemsetters/standards openspec/changes/problem-format-and-quality-standards/specs
```

预期：关键术语同时出现在文档与 spec 中。

- [ ] **Step 3: 构建 noj-docs**

运行：

```bash
cd noj-docs && npm run docs:build
```

预期：构建成功，无死链/编译错误。

- [ ] **Step 4: 提交（如有验证修复）**

```bash
jj describe -m "docs(root): 验证题目规范文档一致性"
```

---

### Task 8: 收尾与 OpenSpec 流程交接

**Files:**
- 无新增文件

**Interfaces:**
- Consumes: 全部任务完成
- Produces: 可进入 `/opsx:apply` / `/opsx:archive` / `/opsx:sync`

- [ ] **Step 1: 检查工作区状态**

运行：

```bash
jj status
```

预期：所有计划内文件已提交，无意外改动。

- [ ] **Step 2: 向用户报告完成情况**

列出：OpenSpec 变更目录、noj-docs 新章节、验证结果，并提示下一步可执行 `/opsx:apply` 实施 OpenSpec 变更、`/opsx:archive` 归档、`/opsx:sync` 同步主规范。
