# Agent Note: 文档审计遗留的 A/C 类事实性缺口修复

Status: implemented

## Problem

2026-09-24 的文档可读性审计（7 组子代理 + 人工复核）在报告里登记了一批**跨出文档
范围**的事实性缺口，需要拍板后修复。用户决策：文档定位为「**尽力而为的契约**——
不保证完全准确，但应尽可能准确易用」，并指示：

- **A 类**（事实性缺口）：本 PR 内修复；
- **C 类**（编排者可自决项）：自主修复；
- **B 类**（产品/运营决策）：只发 issue，不修复。

### A 类四项

1. **`memory_kb` 契约冲突（两层混淆）**：`details.cases[].memory_kb` 被
   `JUDGE_CASE_ALLOWED_KEYS` 白名单静默丢弃（`consumer.ts` 精确匹配后 `continue`），
   而 `mechanisms/evaluator-sdk.md` 声称「可见与隐藏用例都可给」，`standards/test-data.md`
   却说「会被丢弃」——两页结论相反（修正后确认：`evaluator-sdk.md` 侧描述正确）。顶层 `result.memory_kb` 则是正常落库的
   （`submissions-result.ts`）。
2. **`samples` 死字段**：manifest 接受并**严格校验** `samples`（`{input,output}`
   数组，非法即 400），但 `rg samples` 排除类型定义后无任何下游消费者——出题人认真
   填写却毫无效果。
3. **样例题时间限制自相矛盾**：`data/problems-src/1001/statement.md` 写「时间限制
   1000ms」，`problem.json` 的 `evaluator.time_limit_ms` 实为 `30000`（30 倍差异）。
4. **`.env.example` 存储目录注释漂移**：注释写「默认 `data/support-packages`」，
   实现是 `data/storage`（`local.ts`），且该变量名是保留的历史配置名。

## Decision

**A2-1 `memory_kb`：加白名单（让 SDK 文档契约成真）**
`JUDGE_CASE_ALLOWED_KEYS` 增加 `"memory_kb"`，并更新 `consumer.test.ts` 断言
（原测试用例刻意用 `secret` 验证被丢弃，现在同时验证 `memory_kb` 被保留）。
同步修正 `test-data.md` 与 `quality.md` 两处「会被丢弃」表述（`evaluator-sdk.md` 原本即为正确契约，无需改动）。

**A2-2 `samples`：软废弃（容忍 + 告警），而非硬移除**
保留字段容忍但不落库，在三处补可见 warning，避免"写了没效果还不报错"：

- core 校验层（`types/problem-bundle.ts`）：静默容忍（`types/` 层不引入 logger，
  保持分层纯净）；
- core 服务层（`services/problems/problem-bundle.ts`）：导入时记录一次 warning；
- noj-cli `lint.ts`：新增 `quality/deprecated-samples` 质量规则（warn 级）+ 两个测试。

**为什么不硬移除**：`validateBundleManifest` 对未知顶层键是**容忍**的，但显式
`remove + 不再校验` 与 `保留校验但拒绝` 的行为差异会影响存量题包；采用「保留容忍 +
全链路告警」既兼容存量、又让新题包不再误用。noj-cli vendored 副本**同步修改**
（`vendor/problem-bundle.ts` 是 #514 决策的刻意副本，头注释要求两处同步）。

**A2-3 样例题：题面限制改为与 `runtime_config` 一致**
`1001/statement.md` 原写「时间限制 1000ms」，而 `problem.json` 是
`evaluator.time_limit_ms=30000` / `solution.call_timeout_ms=5000`，相差 30 倍。
最初尝试直接删除题面里的时间/内存两行（理由是前端从 `runtime_config` 渲染权威值），
2026-09-25 三轮评审实测**非 owner / 竞赛页拿不到 `runtime_config`**，删除会造成决定性
信息缺失；已改为在题面写出与配置一致的三行（总时限 30000ms、单次调用超时 5000ms、
内存 256MB），并保留数据范围约束。代价是数值在题面与配置各存一份（见「未引入自动化
门禁」一条）。

**A2-4 `.env.example`：对齐实现**
注释改为「默认 `data/storage`，与构建产物目录 `data/packages/` 分离」，
示例值同步为 `./data/storage`。

**C 类三项**

- **C1 存根页**：11 个「已迁移至 …」跳转页中，`users/ranking.md`、
  `users/search-messages.md`、`operators/storage.md` **缺少** `::: info` 说明段，
  格式不统一。补齐说明段（不删除——它们是 2026-08-25 重组计划 Task 7 **有意保留**
  的旧 URL 保活页，删除会让旧书签 404）。
- **C2 术语澄清**：`reference/glossary.md` 新增「初始代码模板」词条，明确
  `GET /api/v1/problems/:id/template` 返回 starter code、**不是**支持包模板下载
  （本轮审计中真实发生过的误述）。
- **C3 `deploy/monitoring` 漂移**：`noj-alerts.yml` 注释与
  `NojRestoreDrillStale` description、`README.md` §4 仍指向已弃用的
  `scripts/deploy/backup.sh` / `restore-drill.sh`，实际写入方已是 `noj-cli`
  （`prod/backup/metrics.ts`、`prod/drill/report.ts`）。改为 `noj-cli` 并保留
  历史说明。

**B 类：只发 issue**（#579–#583，不在此 PR 修复）
签到活跃榜无 UI 入口、LLM 配额无管理页、提交日期筛选未暴露、竞赛相似度缺文档、
进行中竞赛榜单只返回本人行。

## Alternatives considered

- **A2-1 走文档修正（统一为"暂不支持"）**：否决。SDK 文档的契约意图是对的（用例级
  内存是有用信息），且白名单只差 1 行；改源码让契约成真比削弱文档收益更大。
- **A2-2 硬移除（校验拒绝）**：否决。会让带 `samples` 的存量题包导入 400，破坏兼容；
  且用户明确倾向「文档是尽力而为的契约」而非严格门禁。
- **A2-2 完全静默**：否决。写一个字段毫无效果且无任何反馈，正是本次审计要消灭的
  「死字段」体验。
- **A2-2 warning 放在 `types/` 校验层**：否决。`types/` 层无 logger 先例，
  引入 logtape 破坏分层；warning 归服务层与 lint 层。
- **A2-3 改 `problem.json` 为 1000ms**：否决。30s 是样例题（A+B）的实际评测配置，
  改配置会改变已上线行为；题面不该重复承载会漂移的数值。
- **C1 删除存根页**：否决。重组计划 Task 7 明确保留它们以保证「无死链，旧链接可跳转」。
- **C3 留作后续**：否决。纯注释/doc 修正、零功能风险，且会持续误导运营者排查备份告警。

## Consequences

- **`memory_kb` 现在真的生效**：`details.cases[].memory_kb` 会随结果落库；三处文档
  从"会被丢弃"改为可正常使用。**注意**：这是行为变更，存量评测脚本若已写该字段，
  行为从"静默丢弃"变为"保留"（正向，无破坏）。
- **`samples` 成为显式废弃字段**：导入仍兼容但会告警；`noj-cli problem lint` 新增
  `quality/deprecated-samples` 规则（warn 级，`--strict` 下影响退出码）。
- **共享 fixture 语义更新**：`fixtures/problem-bundle-manifest.json` 的正例改名为
  「artifact 提交 + 标签 + 已废弃 samples（非法形状仍被容忍）」，且 `samples` 取
  **非法形状**（字符串）——这样"将来重新收紧校验"的漂移会被 core 与 noj-cli 两侧契约
  测试立刻发现（合法形状在收紧前后都被接受，锁不住该语义）。
- **样例题题面保留限制数值**：与 `problem.json` 一致（30000ms / 5000ms / 256MB），
  做题人无需依赖 `runtime_config` 即可看到权威限制（2026-09-25 三轮评审修正）。
- **补齐测试**：core 侧新增「已废弃 samples（含非法形状）导入成功」用例；noj-cli 侧
  断言该规则 `level === "warn"`（防止被误升级为 error 而拒绝存量题包）；
  `scripts/problems-init.ts` 的 evaluate.py 骨架注明"用例级 memory_kb 可选、本骨架
  不产出（Evaluator 读不到 Solution 容器内存，提交级峰值由评测机回填）"。
- 19 个文件变更（core 5、noj-cli 3、fixtures 1、docs 6、deploy 2、.env.example 1、
  data 1）；核心测试（noj-cli 745 通过、core catalog/submission 契约与单元全绿）、
  `deno fmt`/`deno lint`/`deno check`、docs 构建与链接检查全部通过。
- 未引入自动化门禁（语义漂移仍靠人工审计 + 共享 fixture 契约测试兜底最关键的
  双份实现漂移）。
