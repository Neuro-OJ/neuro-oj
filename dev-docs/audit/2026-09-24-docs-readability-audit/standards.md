# standards 组文档审计报告

> 审计对象：`noj-docs/docs/standards/`（面向主题 → 题目规范及质量要求）
> 执行日期：2026-09-24　依据：`RUBRIC.md`（含第四节「接口语义必须先取证再落笔」）

## 范围

| 文件 | 行数（改前 → 改后） |
|------|:---:|
| `noj-docs/docs/standards/index.md` | 14 → 22 |
| `noj-docs/docs/standards/problem-bundle.md` | 131 → 172 |
| `noj-docs/docs/standards/test-data.md` | 115 → 133 |
| `noj-docs/docs/standards/quality.md` | 93 → 107 |

改前全组**零 VitePress 容器**；改后每页 2–5 个容器（index 1、problem-bundle 5、test-data 4、quality 3），符合 RUBRIC 的建议区间。

## 正确性发现

| 位置 | 问题 | 证据（路径 + 符号） | 处置 |
|------|------|------|------|
| `problem-bundle.md` manifest 字段表 `samples` | 原写「预留；**缺省从题面自动提取**」。实际 `samples` 只在 `validateBundleManifest` 做结构校验（`{input,output}` 字符串数组），**从不落库**，导入路径 `importProblemBundle` 也未把它传给 `createProblem`/`updateProblem`，更不存在"从题面自动提取"的任何实现。 | 校验：`noj-core/src/domains/catalog/types/problem-bundle.ts:191`（`m.samples` 分支）；落库：全仓 `rg samples` 在 `services/problems/*` 无命中，`problem-bundle.ts` 的 `createViaCrud`/`updateExisting` 均未传 `samples`。 | 已修正：改为「仅做 `{input,output}` 数组结构校验，**当前不会落库**；题面样例由题面正文承载」 |
| `problem-bundle.md` 包结构说明 | 原写打包排除「`template.py` / `submission*` / `__pycache__` / `.git`」，漏了「**manifest 声明的模板文件**」。自定义模板名（如 `starter.py`）同样会被排除，仅写死 `template.py` 会误导。 | `noj-core/scripts/noj.ts:54`（`resolveTemplateExclude`）、`noj-cli/src/problem/pack.ts:34`（`shouldExclude` 中 `base === templateName`）。 | 已修正：改为「`submission*`、manifest 声明的模板文件、`__pycache__` 与 `.git`」，并补 `noj-cli problem pack` 同规则 |
| `problem-bundle.md` manifest 字段表 | 缺 `submission_mode` / `artifact_max_size_mb` 两个**已实现**字段（`validateBundleManifest` 校验、导入落库均支持），读者无从得知。 | `problem-bundle.ts:220-241`（校验）、`services/problems/problem-bundle.ts:294-295`（更新落库）、`:565-566`（创建落库）。 | 已修正：补两行，含取值范围与「客观题包禁止提供」 |
| `problem-bundle.md`「特殊题型 → 客观题套卷」 | 只给了一句 `questions.json` 示例，未说明 `type` 仅 `single/multiple/judge`、`answer` 规则、`options` 对 `judge` 型可省、`sort_order` 非负且不重复等**会被 400 拒绝**的约束。 | `noj-core/src/domains/catalog/types/problem-bundle.ts:313`（`validateObjectiveQuestions`）、`noj-core/src/domains/objective/types/objective.ts:127/140/168`。 | 已修正：新增字段表 + 约束容器 |
| `problem-bundle.md`「导入语义与存储」 | 未提及客观题**禁止提供** `runtime_config`/`llm`/`template`/`submission_mode`/`artifact_max_size_mb`（提供即 400），也未提及客观题禁止算法标签（400）。 | `problem-bundle.ts:256-271`（禁止字段）、`services/problems/problems-tags.ts:44`（客观题禁算法标签）。 | 已修正：在 manifest 表后新增 `::: danger`，客观题示例段补标签约束 |
| `problem-bundle.md`「版本与校验」 | 缺上传 zip 本体大小上限 **128 MiB**（`MAX_SUPPORT_PACKAGE_SIZE`），读者可能只看到 ZIP 解压三限而忽略压缩包上限。 | `noj-core/src/domains/catalog/services/support-package.ts:23`；路由 `noj-core/src/domains/catalog/routes/problems.ts:392`。 | 已修正：并入 ZIP 约束容器 |
| `problem-bundle.md` 上传入口 | 未说明 multipart 字段名必须是 `file`、Content-Type 白名单，踩坑时无从排错。 | `noj-core/src/domains/catalog/routes/problems.ts:373-390`。 | 已修正：并入 ZIP 约束容器 |
| `test-data.md` details.cases 表 `memory_kb` | 文档把 `memory_kb` 列为可用字段，但 core 侧落库前白名单 `JUDGE_CASE_ALLOWED_KEYS` **不含** `memory_kb`，judge 回传的该字段会在 `sanitizeJudgeDetails` 中被静默丢弃，提交详情页实际拿不到。 | `noj-core/src/domains/submission/mq/consumer.ts:42-51`（无 `memory_kb`）、`:169`（调用处）；对照 `noj-core/src/domains/submission/tests/mq/consumer.test.ts:229-246` 用例只保留 `case_id/status/visibility`。 | 已修正（文档侧）：在表中标注「当前 core 侧白名单未收录，写入后会被丢弃，暂不会展示」——这是**实现与文档的真实差异**，未改源码（超出范围），详见「遗留问题」 |
| `quality.md`「难度与发布流程 → 审核」 | 原写「P 型/LLM 题需 admin 审核；U 型可自行发布」。源码中并不存在 P 型题目"审核"状态机；实际是「P 型仅 admin 可创建」「U 型由 owner 管理，可经 `PUT /:id/visibility` 转公开」「批量转公开/转 P 由评定队列（`problem:create_p`）处理」。 | `noj-core/src/domains/catalog/routes/problems.ts:301`（visibility）、`noj-core/src/domains/admin/routes/catalog.ts:259/309`（review 队列，queue=public/p）。 | 已修正：改写为按创建/管理权限描述 |
| `quality.md`「发布前自测清单」 | 清单写「触发 rejudge」，但对 artifact 题不成立（产物提交**不支持 rejudge**）。 | `noj-core/AGENTS.md`「服务层业务规则」artifact 行；`noj-ui/pages/editor` 与 `problemsetters/web-editor.md` 的 `::: danger` 一致表述。 | 已修正：新增 `::: danger` 说明不适用 artifact |
| `quality.md`「评测脚本质量」 | 未写明「脚本自身异常必须上抛、不输出 `---RESULT---`」这一关键失败语义（否则故障被掩盖成 `finished`+0 分）。 | 样例题骨架注释 `noj-core/scripts/problems-init.ts:217`；实现 `noj-core/data/problems-src/1001/evaluate.py:66-74`。 | 已修正：新增 `::: warning` |
| `index.md`「内容导航 / 约束强度」 | 用纯列表罗列三页，约束强度信息（MUST/SHOULD）藏在下方段落，扫读成本高。 | 文档结构问题。 | 已改进：改三列表格并标注每页约束强度；补「导入成功 ≠ 题目合格」 |

> 未发现事实错误的既有内容（已复核无误）：`format_version=1`、`difficulty` 三值、`type` U/P、`template` 路径穿越校验、ZIP 三限（1000 / 64 MiB / 512 MiB）、`evaluator.command` 默认值 `python3 /workspace/evaluate.py`、`llm` 仅 P 型 + 联网、`tags` 不存在的名字 warning 忽略、客观题不产生评测包存储、`GET /problems/:id/template` 语义（本文档未涉及该端点，未望文生义）。

## 可读性改进

| 页面 | 改动 | 理由 |
|------|------|------|
| `index.md` | 导航列表 → 「页面 / 内容 / 约束强度」三列表格；开篇加一句「三页各司其职」导语；约束强度段落改为 `::: warning` | 规范类读者首先要知道「哪页是硬约束」，表格一屏看清 |
| `index.md` | 新增「导入成功 ≠ 题目合格」提示 | 防止读者把 MUST 校验误当质量背书 |
| `problem-bundle.md` | 开篇 `> 引用块` 结论先行（本页是 MUST、400 语义） | 扫读成本 |
| `problem-bundle.md` | 新增 `::: danger`「三种根级缺失导致 400」 | 「根级」是最常见踩坑点（`assets/evaluate.py` 不算） |
| `problem-bundle.md` | manifest 字段表补全 `submission_mode`/`artifact_max_size_mb`，`samples` 改为准确描述 | 字段清单表格化、逐字段可校验 |
| `problem-bundle.md` | 新增 `::: danger`「客观题禁止字段」+ `::: tip`「artifact 入口 `submission.py`」 | 禁止项用 danger、易混淆约定用 tip |
| `problem-bundle.md` | ZIP 安全 + 上传入口合并为一个 `::: warning` | 两段原本分散，合并后集中「上传会被拒的情形」 |
| `problem-bundle.md` | LLM 片段补注「需补齐 `runtime_config` 其余字段」 | 避免读者照抄导致结构非法 |
| `problem-bundle.md` | 客观题 `questions.json` 字段表 + 约束容器 | 规范类文档要"照着校验" |
| `test-data.md` | 开篇 `> 引用块` 区分「格式建议」与「`details.cases` 协议强制」 | 澄清 SHOULD 与 MUST 边界 |
| `test-data.md` | 新增 `::: tip`「`id` 不是 `case_id`」 | 高频混淆点 |
| `test-data.md` | 新增 `::: info`「静态预检只识别 `visible.jsonl` / `hidden.jsonl` / `hidden/`」 | 解释为何推荐这两种命名 |
| `test-data.md` | 新增 `::: danger`「隐藏用例 MUST NOT 写敏感输出」+ `::: warning`「`hidden` 缺失 = 整份不返回」 | 泄题与 fail-safe 是最需要「不看会踩坑」的两点 |
| `quality.md` | 开篇 `> 引用块` 澄清 SHOULD 但有硬性项 | 降低「建议=可不做」的误读 |
| `quality.md` | 新增 `::: tip`「模板名可经 `manifest.template` 更改」+「starter code 与支持包无关」 | 承接已有的端点澄清，避免与支持包混淆 |
| `quality.md` | 新增 `::: warning`「脚本异常要上抛」+ `::: danger`「artifact 不支持 rejudge」 | 失败语义与不可逆操作 |
| 全组 | 长清单用有序/无序列表与表格替代纯段落 | 提升可扫读性 |

## 视觉评价

截图落盘 `/tmp/opencode/audit-shots/standards/`（`before-*` / `after-*` / `final-*`），逐页目视：

- **`index.md`（before vs final）**：改前只有两段纯文本，页面空旷、层次弱；改后表格 + `::: warning` 把「三页 + 约束强度」在首屏讲清，密度适中，不再是"一堵墙"。
- **`problem-bundle.md`**：改前是「连续 bullet + 大 JSON + 长表格」的单调节奏；改后开头有结论块，中段有 danger 容器打断长文本，容器颜色（红/黄/绿）形成清晰锚点。改后约 5 个容器，未到泛滥程度。
- **`test-data.md`**：改前 115 行几乎无视觉停顿；改后 tip/info/danger/warning 四个不同色块分别承担「混淆点 / 背景 / 危险 / 前置条件」，读者可凭颜色快速定位。渲染确认容器均成对闭合、无破版。
- **`quality.md`**：改前 93 行全是平铺要点；改后在模板、脚本质量、发布三处插入容器，长页出现呼吸感，且三处恰是"不看会踩坑"的位置。
- 整体：本组原为零容器，改后平均每页约 3 个，颜色语义与 RUBRIC 第三节一致，未出现整段套容器的问题。表格在 1440px 下无横向溢出。

## 遗留问题 / 建议

1. **`memory_kb` 的真实不一致（需人拍板，跨页）**：`test-data.md` 与 `mechanisms/evaluator-sdk.md:132` 都把 `memory_kb` 当可用字段，但 core 侧 `JUDGE_CASE_ALLOWED_KEYS`（`noj-core/src/domains/submission/mq/consumer.ts:42`）未收录，落库前即被丢弃。二选一：
   - 源码侧把 `memory_kb` 加入用例白名单（推荐，与 evaluator-sdk / 样例题契约一致）；
   - 或文档统一改为"暂不支持"。
   当前仅在 standards 文档做了准确标注，未越界改源码与 mechanisms 页。
2. **`samples` 字段的定位（建议）**：manifest 接受 `samples` 却不落库、也不自动提取。要么实现落库/展示，要么考虑从 manifest 类型中移除该"死字段"，避免出题人误以为它生效。已在文档标注"当前不会落库"。
3. **`questions.json` 字段缺少权威文档页（跨页）**：客观题导入约束现补充在 `problem-bundle.md`；`features/objective.md` 仅指向本页，未重复字段表——目前一致，但后续两处易漂移，建议 objective 页显式引用本页锚点。
4. **重复内容（跨页，未越界修改）**：`problemsetters/web-editor.md`、`quick-start.md` 已多处引用本组页面，内容分工清晰（出题人流程 vs 规范细节），无矛盾；但 `problemsetters/cases.md`、`support-package.md` 已是纯跳转壳页，长期看可与 standards 合并，减少"跳转空洞"。
5. **样例题 `statement.md` 的限制与 `problem.json` 不一致（源码侧，超范围）**：`data/problems-src/1001/statement.md` 写"时间限制 1000ms"，`problem.json` 为 `evaluator.time_limit_ms: 30000` / `solution.call_timeout_ms: 5000`。属样例题内容问题，非本组文档职责，仅记录。
6. **`llm` 旧字段容忍的表述**：`problem-bundle.ts:108` 的注释说未知键（含 `provider_id`/`model`）忽略，`isValidLlmConfig` 只校验 `max_calls`/`max_tokens`，文档表述与实现一致，已保留。

## 2026-09-25 复核补充（第三轮评审）

7. **`test-data.md` 的计分归因是错的（本报告漏检，已修）**：该页在本次审计中被改写为
   「正式评分只使用不可见测试数据（**与样例题骨架的 `evaluate.py` 一致：分数只来自隐藏用例**）」，
   但骨架 `noj-core/data/problems-src/1001/evaluate.py:150-155` 实际把可见与隐藏用例
   **等权计入** `score_content`（10 可见 + 10 隐藏 → 每例 0.4 分）。即：建议本身可以接受，
   但"与骨架一致"的归因是虚假事实，且与本报告 RUBRIC 要求的"接口语义先取证再落笔"相违。
   已改为如实描述骨架口径 + 明确标注"只按隐藏用例计分需自行实现"。
8. **索引清单类表述**：`data-dictionary.md` 各表小节的索引行以封闭列表形式给出但不完整
   （如 `submissions` 3/8），已在页首加"主要索引（不完整）"限定（该页属 #577，非本组）。
