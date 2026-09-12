# Agent Note: 加固"假绿灯"门禁并新增四个棘轮门禁

Status: implemented

## Problem

架构评审发现一类系统性问题：门禁存在、进 CI、打印"通过"，但判定条件已因代码重构而永久失效或从未正确锚定。实证：

- `verify-capability-seams.ts`：白名单路径全部指向已不存在的旧目录，且比较的是"相对导入文件的说明符"与"相对 src 根的路径"（永不相等），还漏了动态 `import()` → 规则从未生效却报绿；
- `verify-export-jsdoc.ts`：`exports === 0` 时覆盖率被定义为 **100%** → 扫描器失效即"满分通过"；
- `verify-md-links.ts`：不跳过代码块（文档引用正则即误报）、扫到 0 个文件也通过；
- `gen-route-catalog.ts`：正则未锚定接收者，365 行目录里 112 行是 `c.get("userId")` 这类伪造条目，而 `--check` 只比对"文件与生成结果一致"；
- `check-metrics.ts`：文档自称被它校验，实际从不读取（35 个平台指标只登记 23 个）；
- `silent-skip-report.ts`：只写报告、从不 exit 1（CI 步骤名即"静默跳过扫描（报告）"）；
- `verify-domain-ci.ts`：jj 工作区（无 `.git`）下 `git ls-files` 失败后回退遍历未跳过 `node_modules`，把 1.3 万个依赖文件当受跟踪文件 → 该门禁在 jj 工作区完全不可用。

## Decision

统一采取"自检 + 棘轮"两条手段：

1. **每个门禁必须有自检**：扫描不到对象（0 文件/0 条解析结果/0 处引用）即**失败**，防止路径漂移后恒真；capability-seam 与 schema-parity 额外检测"规则已成恒真断言"。
2. **计数类门禁改棘轮**：登记基线，**增长即失败**，下降要求同步下调基线。
   - `silent-skip-report.ts --check` + `test-silent-skips.baseline.json`（515 处，含按原因/按文件维度，覆盖"此消彼长"）；
   - `check-file-size.ts`（>1200 行必须登记，5 个存量文件入基线）；
   - `check-write-rate-limits.ts`（含写路由的文件必须有限流证据或登记理由，暴露 3 项欠债）；
   - `gen-route-catalog.ts` 加路由数下限与"路径必须以 `/` 开头"断言。
3. **新增一致性门禁**：`check-migration-safety.ts`（迁移写法）、`noj-core/scripts/check-schema-parity.ts`（schema-ddl ↔ Drizzle 表/列）。
4. **运维测试进 CI**：`test-deploy.sh` / `test-backup.sh` / `test-restore-drill.sh`（三者均为"无 Docker + fake docker"测试）。

## Alternatives considered

- 用"通用路径存在性扫描"审计所有门禁：噪声过大（大量测试夹具与"故意不存在"的路径），已实测否决。
- 只修 capability-seam 一处：其余同源缺陷（jsdoc/md-links/route-catalog/metric-catalog）会继续报绿。
- 把静默跳过改成"直接失败"：511+ 处跳过多数是有意的环境守卫，只能棘轮治理。

## Consequences

- capability-seam 从"解析到 0 处引用"变为 8 处真实装配点引用；路由目录 365→253 行、伪造 0 行；平台指标 23→35 全覆盖。
- 门禁自身也有测试：`scripts/*_test.ts` 已加入 `check-ci.ts` 的测试列表（本次共新增 5 个门禁测试文件）。
- md-links 检查器新增"跳过围栏代码块与行内代码"，修掉了对代码示例的误报。
- 仍然存在的外部依赖：门禁依赖仓库根为 cwd；jj 工作区通过回退遍历的排除清单支持。
