# 出题人（problemsetters）文档审计报告

> 审计日期：2026-09-24 ｜ 范围：`noj-docs/docs/problemsetters/` ｜ 事实源：源码优先
> 参照规范：[`RUBRIC.md`](./RUBRIC.md)

## 范围

| 文件 | 改前行数 | 类型 |
|------|:---:|------|
| `index.md` | 17 | 真实内容页 |
| `quick-start.md` | 27 | 真实内容页 |
| `web-editor.md` | 70 | 真实内容页（主要审计对象） |
| `ab-example.md` | 138 | 真实内容页 |
| `llm-problem.md` | 90 | 真实内容页 |
| `support-package.md` | 3 | 存根（跳转 `standards/problem-bundle.md`） |
| `cases.md` | 3 | 存根（跳转 `standards/test-data.md`） |
| `judge-model.md` | 3 | 存根（跳转 `mechanisms/judge-model.md`） |
| `evaluator-sdk.md` | 3 | 存根（跳转 `mechanisms/evaluator-sdk.md`） |
| `solution-sdk.md` | 3 | 存根（跳转 `mechanisms/solution-sdk.md`） |
| `rpc.md` | 3 | 存根（跳转 `mechanisms/rpc.md`） |
| `runtimes.md` | 3 | 存根（跳转 `mechanisms/runtimes.md`） |
| `capability-networking.md` | 3 | 存根（跳转 `mechanisms/capability-networking.md`） |

**存根核对结论**：8 个存根页全部核实为"本文档已迁移至 …"跳转页，跳转目标文件均存在（`mechanisms/` 6 个 + `standards/` 2 个）。措辞正确，未扩写（避免与 mechanisms 重复），仅在每页补一行 `::: info` 说明"本页仅保留跳转"，不改其简洁性。

## 正确性发现

| 位置 | 问题 | 证据（路径 + 符号） | 处置 |
|------|------|------|------|
| `ab-example.md` §错误提交 | 称收到 `NotFoundError`"不应被当作系统错误"，但样例实际把该异常向上抛、不输出 `---RESULT---`，最终 verdict 是 **`error`**，文档表述会误导出题人对状态映射的理解 | `noj-core/data/problems-src/1001/evaluate.py`：`except SolutionTimeoutError: raise` / `except Exception as e: print(...); raise`（无 `accept`/`wrong_answer`）；`noj-judge/src/dual/mod.rs` `finalize_outcome()`（无 RESULT → `SystemError`）；`noj-core/src/domains/submission/services/submissions/submissions-crud.ts` `normalizeResultStatus()`（`SystemError` → `error`） | 已修正 |
| `ab-example.md` §调用失败 | 代码块写成 `runtime_error = True` 并吞掉异常，与样例源码（直接 `raise`）矛盾；且暗示捕获后继续评测 | 同上 `1001/evaluate.py` L69–74 实际为 `print(...); raise` | 已修正 |
| `ab-example.md` §上传 | 称 zip 只需"含 `problem.json` + `statement.md` + `evaluate.py`"，未说明上传的 zip 是**导入载体**、必须根级含 `problem.json` | `noj-core/src/domains/catalog/services/bundle-parser.ts` `parseBundleZip()`（根级缺 `problem.json` → 400）；`services/problems/problem-bundle.ts` `stripMetadataEntries()` 后重建纯净包 | 已修正（补 `::: warning`） |
| `llm-problem.md` §前置条件 | 写成"P 型 **或审核通过的官方题**"，但源码 LLM 准入校验只有 `type === "P"`，无"官方/审核"分支；"官方题"仅存在于社区题解语境，会误导读者认为存在审核通道 | `noj-core/src/domains/catalog/services/problems/problems-crud.ts` L177 `if (type !== "P") throw`；`types/problem-bundle.ts` L249 `if ((m.type ?? "U") !== "P")`；schema 无 official 字段（`shared/db/schema/catalog.ts`） | 已修正（改为"必须 P 型"） |
| `llm-problem.md` §安全与限额 | 称"管理后台可配置配额"，但 `llm_quotas` 目前通过后台**接口**维护，管理后台只提供查询 | `llm-limits.ts`（平台默认读 `NOJ_LLM_MAX_CALLS`/`NOJ_LLM_MAX_TOKENS`）；`operators/admin-guide.md` L141"配额目前通过后台接口维护" | 已修正 |
| `llm-problem.md` §在 Evaluator 中调用 | 环境变量清单漏 `NOJ_LLM_PROVIDER_ID`（SDK 文档字符串声明使用） | `noj-judge/src/dual/llm_env.rs` `build_llm_env()` 注入 4 个 `NOJ_LLM_*`；`noj_evaluator_sdk/llm.py` 顶部 env 清单 | 已修正 |
| `web-editor.md` §统一题目包 | "大小受系统限制"含糊，未给出实际上限 | `noj-core/src/domains/catalog/services/support-package.ts` `MAX_SUPPORT_PACKAGE_SIZE = 128 * 1024 * 1024`；`bundle-parser.ts` `MAX_ZIP_ENTRIES=1000` / `MAX_FILE_SIZE=64MiB` / `MAX_TOTAL_SIZE=512MiB` | 已修正 |
| `web-editor.md` §发布前预检 | 称"缺少隐藏数据或标准解属于**质量警告**"，但预检未发现**模板**时也是 warning；缺少可见用例是 error。分级未完整 | `noj-core/src/domains/admin/routes/catalog.ts` preflight：`image/runtime`→error、`support_package`→error、`hidden_cases`→warning、`reference_solution`→warning、`template`→warning | 已修正（改为完整分级表） |
| `index.md` §文档内容 | 列表用纯文本，未与侧边栏 `config.ts` 完全对齐；"产物提交题"无对应独立页面链接 | `noj-docs/docs/.vitepress/config.ts` L111–119（侧边栏仅 5 项，无 `support-package`/`cases`） | 已修正（改为表格并链到 `web-editor.md#产物提交题`） |
| `quick-start.md` / `web-editor.md` §模板 | 三处把 `GET /api/v1/problems/:id/template` 描述为"**支持包模板下载**"。该端点实际返回**编辑器初始代码模板（starter code）**的 JSON（`{content, language}`），与支持包无关；支持包并无"模板下载"入口。**（人工复核发现，子代理沿用了错误措辞）** | `noj-core/src/domains/catalog/routes/problems.ts` `GET /:id/template`（返回 `{content, language}`，缺失 404）；`services/support-package.ts` `getProblemTemplate()`（读 `manifest.template`，缺省 `template.py`）；`noj-ui/utils/problemTemplate.ts` + `components/editor/EditorWorkspace.vue`（仅用于编辑器填充/重置代码） | 已修正（三处改为"初始代码模板"，明示非支持包模板） |

> 说明：未发现题目包目录结构、`manifest` 字段名、`runtime_config` 结构、`evaluate.py` 协议本身的事实性错误——这些已在 `standards/problem-bundle.md` 与 mechanisms 中准确描述，出题人页只需正确指向。

## 可读性改进

| 页面 | 改动 | 理由 |
|------|------|------|
| `index.md` | 无序列表 → 表格（页面 / 讲什么两列）；补 `::: tip 从这里开始` | 扫读成本更低，明确"新出题人先看快速出一题" |
| `quick-start.md` | 补短导语 `>` 引用块 + 出题模型示意代码块；步骤 5 子项改为有序子步骤；新增 `::: tip 提供初始代码模板`、`::: warning 题号仅管理员可指定` | 操作向导需要"先看这里"，并把最易踩坑的导入权限前置 |
| `web-editor.md` | 运行时配置散点列表 → 三列表格（容器/配置项/说明）；发布前预检 → 分级表；新增 5 个容器（`::: info` 仅用于开发环境、`::: warning` 敏感字段、`::: tip` 先保存再上传、`::: warning` 预检只是静态检查、`::: danger` artifact 不支持重测） | 长页层次化；把"会导致评测失败/题包损坏"的硬约束突出，预检误用风险用 warning 强调 |
| `ab-example.md` | 源文件树补注释；`::: info` 数据组织可自由；两处 `::: warning`（状态落地、结果 JSON 无 `status`）；`::: tip`（模板不进包）；用例字段改为可见/隐藏对照表 | 出题人最易误解的"调用异常 ≠ verdict"用容器显式说明 |
| `llm-problem.md` | 前置条件改编号列表；配置项与字段表；新增 3 个容器（`::: info` Solution 无网、`::: warning` 预算天花板、`::: tip` 确定性随机）；验证方法重排 | 把"平台默认是唯一模型来源""预算有天花板"等关键约束显式化 |
| 8 个存根页 | 每页补一行 `::: info`（本页仅保留跳转） | 读者在跳转前知道该页无正文，减少困惑；保持简洁 |
| 全局 | 术语统一为"Evaluator / Solution 容器"；命令、字段、路径统一用行内代码；标题不超过 H3 | 符合 RUBRIC 第三节 |

## 视觉评价

截图落盘 `/tmp/opencode/audit-shots/problemsetters/`（不进仓库），改前 `before-*.png`、改后 `after-*.png`，共 5 个代表性页面 + 1 张存根页。

- **`quick-start`（before-quick-start.png → after-quick-start.png）**：改前是"一堵墙"的 5 条长段落，步骤 5 的子项与后续段落混在一起；改后导语引用块 + 模型示意代码块 + 编号步骤 + 两个容器，读者能一眼定位"5 步"与两个坑点（题号权限、模板起步），信息密度明显下降。
- **`web-editor`（before-web-editor.png → after-web-editor.png）**：改前运行时配置是 3 段长句、发布前预检是连续段落，"warning/danger"级别完全靠读者自行判断；改后配置项表格化、预检分级表格化，容器形成清晰的绿/黄视觉锚点（先保存再上传、敏感字段、产物不可重测）。表格列宽合理，无横向溢出。
- **`ab-example`（before-ab-example.png → after-ab-example.png）**：改前"不应被当作系统错误"是纯文本、极易误解；改后 warning 容器黄底突出该状态映射，用例字段对照表让"隐藏用例不得输出 input/expected"一目了然。
- **`llm-problem`（before-llm-problem.png → after-llm-problem.png）**：改前前置条件 4 条中"或审核通过的官方题"埋没在长句里（事实错误）；改后编号 + 表格 + 容器，平台默认模型为唯一来源、预算有天花板两个关键点被显式标出。
- **存根页（after-stub-support-package.png）**：极简、无冗余，`::: info` 提示"本页仅保留跳转"，渲染正常。

整体评价：出题人页多为操作向导，改后"步骤—约束—细节"三层结构清晰，容器使用克制（每页 1–5 个），未出现"给每段都套容器"的滥用；渲染无 VitePress 语法错误（本地 dev server 水合正常，无裸 `:::` 或未闭合容器）。

## 遗留问题 / 建议

1. **术语不一致（跨页，未改）**：`mechanisms/judge-model.md` 使用 "Solution Host"，出题人页与源码注释使用 "Solution 容器 / host 进程"。建议由 mechanisms 负责方统一。
2. **`index.md` 侧边栏缺页**：`support-package.md` / `cases.md` 未出现在 `.vitepress/config.ts` 侧边栏，读者只能通过正文链接到达。属侧边栏配置问题（本任务禁止改 `config.ts`），列出待编排者确认。
3. **"审核题/官方题"残留措辞（跨页，未改）**：`types/problems.ts` 注释中仍写"仅管理员 P 型/官方题或审核题可启用"，但实现无此分支。已修正出题人页，源码/其他文档的措辞建议同步收敛。
4. **`ab-example.md` 的 `NotFoundError` 行为取舍**：样例选择"抛异常 → error"是一种设计选择，但对新手出题人不友好（一个未实现函数会让整次评测判为系统错误）。建议在 mechanisms/standards 中明确推荐做法（记失败用例 vs 直接抛），出题人页已给出两种写法供选择。
5. **`problems:build` 依赖系统 `zip` 命令**：`ab-example.md` 的打包示例对无 `zip` 的环境不适用；是否改用 JS 打包或补前置说明，需人确认。
6. **预检未执行标准解**：文档已如实说明，但"发布前必须自测"的强制性目前靠人自觉，建议在 `standards/quality.md` 建立可勾选清单。
