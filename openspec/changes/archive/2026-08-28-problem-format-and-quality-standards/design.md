# Neuro OJ 题目包格式与题目质量要求规范设计

- 日期：2026-08-25
- 状态：已与需求方确认，待用户审阅
- 范围：OpenSpec 规范 + noj-docs 文档，无代码变更

## 背景

Neuro OJ 目前已有：

- `openspec/specs/problem-bundle-import`：统一题目包（Problem Bundle）导入规范，定义 zip 结构、manifest 字段、导入语义。
- `noj-docs/docs/problemsetters/support-package.md`：面向出题人的统一题目包文档。
- `noj-docs/docs/problemsetters/cases.md`：测试数据说明。
- `openspec/specs/problem-tags`：双类标签系统（problem / algorithm）。

存在的主要问题：

1. 文档与规范不一致：`support-package.md` 的 manifest 示例仍使用已退役的 `categories`，实际系统与 OpenSpec 已使用 `tags`。
2. 题目包格式规范不够完整：测试数据格式未标准化、特殊题型（LLM 调用题、客观题套卷）未在包格式规范中明确。
3. 缺少独立的“题目质量要求”规范：题目命名、tag 适用、题面/数据质量、评测脚本质量、难度与发布流程、测试数据可见性策略均无成文建议。

## 目标

- 将题目包格式规范进一步规范化，并同步修正文档与实现的不一致。
- 新增题目质量建议规范，覆盖题目命名（含来源署名）、tag 适用（含 LMCC 标签体系）、题面与数据质量、评测脚本质量、难度与发布流程、测试数据可见性策略。
- 在 noj-docs 的 problemsetters 章节下新增“Neuro OJ 题目规范及质量要求”分组，层级化承载上述内容。

## 非目标

- 不引入 `format_version=2`，保持 v1 兼容。
- 不改 noj-core / noj-judge 代码；质量要求为 SHOULD/建议，不进入导入强制校验。
- 不新增数据库字段。
- 不实现导入期质量 warning/error。

## 关键决策

1. **交付物形态**：一个 OpenSpec 变更，包含两个 delta spec（`problem-bundle-import` 修订 + `problem-quality-guidelines` 新增），并同步 noj-docs。
2. **约束强度**：题目包格式为 MUST（导入强制校验）；质量要求为 SHOULD/建议。
3. **版本策略**：保持 `format_version=1`，只做文档对齐、明确既有字段语义、补充推荐性测试数据约定。
4. **文档结构**：noj-docs 在 `/problemsetters/` 下新增 `standards/` 子章节，旧 `support-package.md` / `cases.md` 改为短重定向页。

## 设计内容

### 1. 题目包格式规范修订（delta 到 `problem-bundle-import`）

#### 1.1 对齐现有不一致

- manifest 字段统一为 `tags`（字符串数组），删除文档中的 `categories` 示例。
- 明确 `description` 与 `statement.md` 二选一、文件优先。
- 明确 `template` 为纯文件名（禁止 `/`、`\`、`..`）。
- 明确 `runtime_config` 直接引用 `problem-runtime-config` 规范，不重复定义。
- 补充 `llm` 字段到 manifest 表：`{ provider_id, model }`，仅 P 型 + evaluator 联网可启用。

#### 1.2 补全包结构 / 版本 / 校验

包结构树：

```text
<任意名>.zip
├── problem.json      # 必需：manifest
├── evaluate.py       # 必需：评测脚本（根级）
├── statement.md      # 可选：题面（与 manifest.description 二选一，文件优先）
├── visible.jsonl     # 可选：可见测试数据（推荐约定）
├── hidden.jsonl      # 可选：不可见测试数据（推荐约定）
└── assets/           # 可选：evaluate.py 依赖的其他文件
```

- `format_version=1` 为当前唯一支持版本；未知版本导入返回 400。
- 校验规则：保留 zip 安全（路径穿越、条目数、单文件/总大小）；补充 manifest 字段类型/枚举校验；`tags` 按 name 匹配已有标签，缺省忽略 + warning；`llm` 校验（P 型 + network enabled）。
- 构建/导入流程：`problems:build` 排除 `template.py`/`submission*`/`__pycache__`/`.git`；导入时剥离 `problem.json`/`statement.md` 后存储纯净评测包。

#### 1.3 标准化测试数据格式（推荐约定，非强制）

- 推荐 JSONL 格式字段：`id`、`input`、`expected`、`score`、`tags`、`message`。
- 目录约定：`visible.jsonl` / `hidden.jsonl`，或 `cases/visible/*.json` / `cases/hidden/*.json`。
- 可见/不可见语义：
  - 可见测试数据：用于做题人调试展示（输入、期望、实际结果）。
  - 不可见测试数据：用于正式评分，默认不向用户展示输入/期望/细节。
  - Neuro OJ 建议全部使用不可见测试数据（与 LMCC 官方“可见/不可见”标准对齐，但更严格）。
- evaluator 不得泄露不可见测试数据：不可见用例的输入、期望答案、评分细节不得写入面向用户的 `details`。

#### 1.4 覆盖特殊题型

- LLM 调用题：manifest 增加 `llm` 字段说明（`provider_id`/`model`），必须 P 型 + `runtime_config.evaluator.network.enabled=true`；引用 `llm-problem.md` 的安全与配额要求。
- 客观题套卷：明确不通过统一题目包导入（无 `evaluate.py`/`runtime_config`），走 Web 编辑器/API 管理；包格式规范只覆盖 U/P 评测题。

### 2. 题目质量建议规范（新增 `problem-quality-guidelines`）

#### 2.1 题目命名规范

- 标题简洁、准确、无歧义；中文建议 5–30 字，英文 3–20 词。
- 来源署名（必须）：
  - 官方/样例题在标题中标注来源，格式为 `[来源] 题目名`，例如：
    - `[LMCC-T 2025 交流活动] 古诗词题目格式标准化`
    - `[LMCC-T 2026 第一轮] 大模型基础概念`
    - `[LMCC-T 2026 第二轮] 数学作业批改助手`
  - 客观题是第一轮认证中使用的，同样标注 `[LMCC-T 2026 第一轮]`。
  - 第三方出题组举办的比赛，在进入主题库前必须在标题上署名（如 `[XX杯 2026] 题目名`）。
- 避免：`测试题`、`未命名`、`A+B` 这类无信息量命名；避免把题号/难度/类型写进标题（`display_id` 由系统生成）。
- 语言：与题面语言一致，项目以中文为主，可中英双语。
- 可搜索性：包含核心知识点/能力关键词，便于搜索。
- 风格：不用 emoji、特殊符号、过长副标题。

#### 2.2 tag 适用规范（含 LMCC 调研结论）

- 双类语义：
  - `problem` 标签：人人可见，用于来源、知识领域、题型/能力。
  - `algorithm` 标签：通过后可见，仅用于真正的算法/数据结构（如 `DP`、`图论`、`滑动窗口`）。
- LMCC 知识领域标签（建议用 `problem` kind，基于 CCF 大纲 12 模块）：
  `人工智能基础概念`、`大模型基础概念`、`模型架构`、`预训练技术`、`指令微调`、`人类对齐`、`解码与部署`、`提示学习`、`复杂推理`、`智能体`、`模型评测`、`模型伦理与安全`。
- 来源标签（`problem` kind）：
  `LMCC 样例题`、`LMCC-T 2025 交流活动`、`LMCC-T 2026 第一轮`、`LMCC-T 2026 第二轮`、`第三方比赛` 等。
- 能力/题型标签（`problem` kind，可选）：
  `客观题`、`编程题`、`材料题`、`代码实现`、`API 调用`、`RAG/检索增强`、`文本解析`、`信息提取`、`结构化输出`、`知识应用` 等。
- 数量：建议 2–5 个，最多不超过 8 个；避免堆砌。
- 命名：使用社区/大纲通用术语，避免自造词、过细标签；同义标签应合并。
- 避免：与标题重复、过于宽泛（`难题`）、过于具体（`2026-08-25 测试`）、误导性标签。
- 客观题套卷：不得关联算法标签（系统强制）。

#### 2.3 题面与数据质量

- 题面结构：题目描述、输入格式、输出格式、样例、数据范围/限制、说明/提示。
- 清晰性：无歧义；输入输出格式明确；样例覆盖典型与边界。
- 数据范围：明确给出；覆盖最小值、最大值、空输入等边界。
- 测试数据：建议全部不可见；可见用例仅用于题面示例/调试；隐藏用例覆盖边界、极端、随机/压力。
- 数据强度：至少包含样例 + 边界 + 随机/压力；LLM 题考虑多样性与评分稳定性。
- 样例即测试：题面中的样例应同时作为 evaluator 的可见自测用例，参与评测但不计分，用于给选手提供友好调试输出。

#### 2.4 评测脚本质量

- 健壮性：处理异常、超时、非法输入，不崩溃。
- 不泄露隐藏数据：不可见用例的输入/期望/细节不写入面向用户的 `details`。
- 可重复性：无随机/时间依赖（或固定种子），结果确定。
- 资源使用：合理设置 time/memory，避免死循环/无限等待。
- 安全：不注册通用转发 capability；密钥不入包/题面；LLM 题走 `noj-llm-gateway`。
- 样例自测：evaluator 应运行题面给出的样例（不计分），并输出对选手友好的调试信息。
- 调试信息应明确易读：结构化、标注输入/期望/实际、错误原因，方便选手定位问题。

#### 2.5 难度与发布流程

- 难度：`easy`/`medium`/`hard` 与题面/数据强度匹配；新题建议从 easy/medium 开始。
- 发布前自测清单：参考答案提交、隐藏用例可见性、资源限制、rejudge。
- 审核：P 型/LLM 题需 admin 审核；U 型可自行发布，但建议遵循质量规范。

#### 2.6 测试数据可见性策略

- 明确 LMCC 官方标准：测试数据分为可见与不可见。
- Neuro OJ 建议：全部使用不可见测试数据；可见数据仅用于题面示例/调试。
- evaluator 必须保证不泄露不可见测试数据：不可见用例的输入、期望答案、评分细节不得出现在用户可见结果中。
- 样例：可见、不计分、可展示调试信息。
- 隐藏用例：不可见、正式计分、不展示输入/期望/细节。

### 3. noj-docs 文档结构

在 problemsetters 下新增子章节：

```text
noj-docs/docs/problemsetters/standards/
├── index.md            # 章节首页：总览 + 阅读导航
├── problem-bundle.md   # 题目包格式规范（从 support-package.md 迁移并增强）
├── test-data.md        # 测试数据与样例规范（从 cases.md 迁移并增强）
└── quality.md          # 题目质量要求（命名/tag/题面/evaluator/难度/发布/可见性）
```

导航配置（`config.ts`）新增 sidebar 分区：

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
]
```

旧页面处理：

- `problemsetters/support-package.md`、`problemsetters/cases.md` 改为短重定向页，指向新章节对应页面。
- `problemsetters/index.md` 更新为指向新章节。
- 原 `support-package.md` / `cases.md` 的完整内容迁移到新章节并增强。

### 4. OpenSpec 变更结构

```text
openspec/changes/problem-format-and-quality-standards/
├── .openspec.yaml
├── proposal.md
├── design.md
├── tasks.md
└── specs/
    ├── problem-bundle-import/spec.md        # 修订现有规范（delta）
    └── problem-quality-guidelines/spec.md    # 新增规范
```

## 验证方式

- 纯文档/规范变更，无代码、无测试。
- 验证点：
  - `grep` 确认 noj-docs 中不再把 `categories` 作为 manifest 字段。
  - 确认新章节与 OpenSpec 规范内容一致。
  - 运行 `noj-docs` 构建（`npm run docs:build` 或等价命令）确认文档站可正常构建、导航无死链。

## 后续流程

- 按 OpenSpec 工作流：`/opsx:propose` 起草 → 评审 → 实现（写文档）→ `/opsx:apply` → `/opsx:archive` → `/opsx:sync`。
- 本设计文档经用户审阅后，进入 `writing-plans` 制定实施计划。
