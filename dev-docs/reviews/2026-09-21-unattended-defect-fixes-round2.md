# 无人值守缺陷修复交付报告（2026-09-21 · 第二轮）

> 承接 noj-cli 纯 TS 重写栈顶端（`main` + CLI 提交 + 上一轮 5 条修复）继续的
> 无人值守缺陷修复与测试栈加强。本文档记录**每条缺陷的证据链**、受影响模块的
> 验收命令与结果，以及**待人工裁决**的候选。

## 范围约束（自我执行口径）

1. 只修「经自己取证到可复现」的缺陷：每条都有触发条件 + 修复前失败的真实命令
   输出 + 修复后转绿的真实输出。
2. 覆盖多模块：本轮的修复落在 `root`（仓库级门禁）、`core`、`judge`。
3. 会改变产品行为的候选项**只报告、标「待人工裁决」**，不自行改。
4. 每条缺陷一篇 Agent Note，落在 `.agents/notes/implemented/bug-fix/`，
   通过 `scripts/verify-agent-note-format.ts`。

## 修复清单（每条 = 一个独立 jj change）

| # | change | 模块 | 缺陷 | Agent Note |
| --- | --- | --- | --- | --- |
| A | `nvulypux` | root | 迁移门禁不拦截硬编码 `REFERENCES "public".` 前缀 | `2026-09-21-migration-public-schema-prefix-gate.md` |
| B | `nnsowonv` | root | 静默跳过 / 测试可发现性门禁遗漏 `noj-cli` | `2026-09-21-silent-skip-gate-missing-noj-cli.md` |
| C | `vowvzuks` | core | `test:parallel` 分片静默遗漏 observability/admin 与顶层测试 | `2026-09-21-test-parallel-shard-coverage-gap.md` |
| D | `slvtrvvw` | judge | `mq.rs` 日志截断在多字节边界 panic | `2026-09-21-judge-log-truncate-utf8-boundary.md` |

### A. 迁移门禁：`REFERENCES "public".` 无静态拦截

- **触发条件**：迁移文件含 drizzle-kit 生成的 `REFERENCES "public"."t"("id")`。
- **修复前**（父提交 `zkqtpovz` 的门禁 + 历史迁移原文 fixture）：
  `errors.length = 0` / exit 0 —— 完全放行。
- **修复后**：同一 fixture `errors.length = 1` / exit 1；真实仓库 CLI 仍 exit 0。
- 自测新增 5 条，含「字符串字面量不误报」与「合成语句自检防恒真门禁」。

### B. 静默跳过 / 可发现性门禁遗漏 noj-cli

- **触发条件**：往 `noj-cli` 测试注入 `ignore: true`，或放入命名不可发现的
  `Deno.test` 文件。
- **修复前**：`silent-skip-report --check` 仍 `通过`（exit 0）；discovery 检查
  `通过`（exit 0）。
- **修复后**：分别报「静默跳过数量增长」与列明不可发现文件，均 exit 1。

### C. `test:parallel` 分片覆盖漂移

- **触发条件**：并行分片（CI `core-test-sharded` job）的目录集合遗漏 domain。
- **修复前**：逐文件覆盖判定显示 **21 个测试文件从未执行**（observability 8 +
  admin 2 + search/consumer 1 + `tests/` 顶层 9 + 守卫自身）。
- **修复后**：`deno task test:parallel` 用例数 `997 → 1051`，全分片通过；
  新增覆盖守卫断言「每个测试文件都被覆盖（除登记豁免）」。
- **路径一致性**：`test:domain observability`（19 passed）与 `admin`（9 passed）
  与并行路径口径现已一致。

### D. judge `mq.rs` 日志截断多字节边界 panic

- **触发条件**：坏 JSON 消息 / fallback 文件反序列化失败，且被截断的消息第
  1024 字节落在多字节字符内部。
- **修复前**：`rustc` 复刻复现
  `end byte index 1024 is not a char boundary`；真实模块上 2/4 回归失败。
- **修复后**：4/4 通过；`cargo test --all-targets` 全绿；`cargo fmt --check` /
  `cargo clippy` 干净。

## 受影响模块验收（真实命令与结果）

| 模块 | 命令 | 结果 |
| --- | --- | --- |
| root | `deno run -A scripts/check-ci.ts` | 通过（exit 0，含 148 个门禁自测） |
| root | `deno run -A scripts/verify-agent-note-format.ts` | 通过（150 篇） |
| core | `deno task check` | exit 0（fmt + lint + typecheck） |
| core | `deno task test` | `1325 passed / 0 failed / 58 ignored` |
| core | `deno task test:parallel` | 全分片通过，`1051 passed / 0 failed` |
| core | `deno task test:domain observability` / `admin` | 19 / 9 passed |
| cli | `deno task check` | exit 0 |
| cli | `deno task test` | `730 passed / 0 failed / 4 ignored` |
| judge | `cargo test --all-targets` | 全绿 |
| judge | `cargo fmt --check` / `cargo clippy --all-targets` | 干净（0 warning） |
| ui | `deno task test` | `139 passed / 0 failed` |
| gateway | `deno task test` | `69 passed / 0 failed / 1 ignored` |

## 待人工裁决清单（不自行改）

以下为**会改变产品行为或配置**的候选，按约束只报告、不修改：

1. **`drizzle.config.ts` 设 `schemaFilter` 从源头不再生成 `REFERENCES "public".`**
   - 现状：A 只加了静态门禁兜底，`db:generate` 仍会生成前缀。
   - 为何不自改：`schemaFilter` 会改变 drizzle-kit 对多 schema 的差异计算，
     可能影响 `check-migration-snapshot-chain.ts` 的严格一致性门禁；需重新验证
     `db:generate` 输出与全部快照。属配置/行为变更。
2. **`silent-skip-report.ts --check` 会先覆写受版本控制的报告文件**
   - 观察：门禁失败前已把 `dev-docs/engineering/test-silent-skips.md` 写入磁盘，
     产生「门禁失败却留下文件改动」的副作用（本地实测）。
   - 为何不自改：涉及「生成产物是否提交」「失败时是否应保持只读」的产品/流程
     取舍，需裁决。
3. **`test-parallel.ts` 的 `core-perf` 关系**：性能基准 `perf/` 已显式登记豁免，
   但 `core-test-sharded` 仍只跑单元/DB 分片，不含 perf。是否需要在并行路径补
   「仅校验 perf 用例可编译/可发现」的轻量 job，属 CI 策略取舍。
4. **noj-core 开发库迁移状态落后**（本地 `noj` 库 58 表 vs 最新迁移集）：属本地
   环境状态，非代码缺陷；未改动。

## 附：本轮**未**采纳的候选（已取证但不满足「可复现真实缺陷」标准）

- `utils/sanitize.ts` 在「闭合括号与引号交错」的畸形输入下会重构出被截断的标签
  （如 `<img src=x alt="a>b">` → 属性值被提前闭合）。经在真实浏览器语义下逐条
  分析，**重构结果不可执行**（无事件处理器、属性仍被双引号包裹、危险属性被过滤），
  不构成可利用缺陷，故未作为修复；仅在此记录，供后续加固参考。
- `test:parallel` 中 `tests/perf` 不在分片内：属**有意设计**（需 `NOJ_RUN_PERF=1`
  + 外部 DB + 种子），不是缺陷，已在 C 的守卫中以登记豁免形式显式化。
