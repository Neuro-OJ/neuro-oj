# Agent Note: 观测域门禁的漏检修复与三项新的静默失效门禁

Status: implemented

## Problem

2026-09-11 对 PR #484 的代码评审发现，该 PR 的核心交付物（可信的域边界/指标门禁）
本身仍有漏检，且有测试与看板表达式永不生效：

1. **`check-domains` 未实现其自身文档承诺的不变量。** `isPublicDomainImport` 对**任何**
   `index.ts` 无条件放行，不看来源域。于是 `domains/submission` import
   `domains/observability/index.ts` 被判合规，而 spec §4.5 规则 2 与
   `domain-boundaries.md` 都写明该 import **仅 admin 可做**（其余业务域只能走 `write.ts`）。
   该函数原本还有一个 `sourceDomain` 参数，在收尾提交里被当作"未使用"删掉了——
   恰好删掉了实现该规则所需的唯一钩子。
2. **`check-domains` 零输入时空过。** 在空目录下执行会打印"域边界检查通过"并退出 0：
   三个扫描函数在目录不存在时静默 `continue`/`return []`。目录改名/移动会让门禁
   静默失效——而同一 PR 已给 `check-runbooks` 补了零注解守卫，属同类问题只修了一半。
3. **`checkAdminObservabilityReadSide` 只看静态 import。** `await import("...services/snapshot.ts")`
   可绕过"admin 不得导入观测域读侧"的约束。
4. **`check-metrics` 完全没覆盖 noj-llm-gateway。** 网关的 `inc()/observe()` 对未定义
   指标是**静默 no-op**，因此一个拼错的指标名会永久丢失该序列，`/metrics` 上看不出
   任何异常。此外 `WRITE_RE` 强制要求前导 `.`，而网关用的是无接收者的裸调用
   `inc("noj_...")`——即便扫到网关，正则也匹配不到（实测：把调用点改成
   `noj_typo_metric_xyz` 仍判通过）。
5. **`noj-core/tests/routes/health.ts` 永不执行。** 文件里有 `Deno.test`，但文件名
   不匹配 Deno 运行器的发现模式（需 `*_test.ts`/`*.test.ts`），而
   `test-shared.sh` 传的是**目录**参数。本地与 CI 都显示绿色，零覆盖。
6. **Grafana 看板裸用直方图家族名。** `noj_llm_request_duration_seconds` 是直方图，
   在 /metrics 中展开为 `_bucket`/`_sum`/`_count`，家族名本身不产生序列，该 panel
   永远为空但不报错。
7. **陈旧文档**：`domain-boundaries.md` 与 `noj-core/CLAUDE.md` 称
   `shared/middleware/` "目录保留兼容"（实际已删除）；域职责表仍列已移除的"管理路由"；
   根 `docs/operators/observability.md` 是与 `noj-docs` 副本漂移的孤儿（无任何入链，
   而全部 runbook 注解都指向 `noj-docs` 副本）。

## Decision

**1. 实现承诺的不变量，并给出可证伪的边界。**
`isPublicDomainImport` 接受 `sourceDomain`，并对 `index.ts` 引入
`INDEX_IMPORT_RESTRICTED = { observability: ["admin"] }`：**只有列在表里的目标域受限**，
其余域的 `index.ts` 仍是公开门面（catalog → identity 等是既有正常用法，不能一刀切）。
首次实现时确实一刀切过，被基线检查当场拦下（大量既有的合法跨域 index import 报违规），
随即收窄——这条弯路记录在此，避免后人重犯。

**2. 零输入守卫。** `scanDomains` 返回实际扫描文件数，`scannedFiles === 0` 时直接失败，
不再打印"通过"。

**3. 动态 import 一并检查。** `checkAdminObservabilityReadSide` 同时匹配
`IMPORT_RE` 与 `DYNAMIC_IMPORT_RE`。

**4. `check-metrics` 扩展到网关，并修掉正则的接收者假设。**
`WRITE_RE` 的接收者改为可选（`(?:\.|\b)`），因模式后半段强制 `"noj_` 字面量，
放宽不会引入误报（已加"无关 set/inc 不误报"的回归用例）。网关的已知集合**只取
`META` 表里的定义**（`name: { help:`），不能用"源码里出现过的任何 `noj_*` 字面量"
——后者会把拼错的调用点也当成定义，形成恒真断言（实测确实如此，已修正）。

**5. 新增 `check-test-discovery` 门禁。** 扫描含 `Deno.test(` 但文件名不匹配运行器
发现模式的文件。排除两类误报：非测试模块（无 `Deno.test`），以及**测试工厂**
（把 `Deno.test` 包在导出函数里供他人调用的辅助模块，如
`noj-tests/e2e/helper.ts` 的 `e2eTest()`——判定为「无顶层 `Deno.test` 调用」）。
同时删除冗余的 `tests/routes/health.ts`：其两条断言（`/health/live` 200、
`/metrics` 文本类型）已被 `health.test.ts` 以更强的形式覆盖（后者还断言了
不泄露动态标识符）。

**6. 新增 `check-dashboards` 门禁。** 校验看板表达式中引用的指标存在，且直方图
不得裸用（必须走 `histogram_quantile(..._bucket...)` 或 `_sum`/`_count`）。
并修复那条永远为空的 panel。

**7. 清理陈旧文档与孤儿副本。**

## Alternatives considered

- **把 `observability/index.ts` 从 `PUBLIC_SUBPATHS` 移除、不做来源域区分。** 否决：
  会让 admin 的合法用法（规则 6 的例外）也报违规。需要按来源域区分，而不是按目标文件。
- **对 `index.ts` 一刀切禁止跨域。** 否决（且实测会误报）：其他域的 `index.ts` 是
  公开门面，跨域导入是既有约定。只有明确受限的域才特殊处理。
- **为 `check-test-discovery` 用「文件路径白名单」而非命名约定。** 否决：运行器按
  文件名发现，门禁必须校验**同一**判据，否则门禁通过但运行器仍不执行——那正是
  要消灭的失效模式。
- **把 `tests/routes/health.ts` 改名保留。** 否决：内容与 `health.test.ts` 重复，
  保留只会增加维护面；两份重复测试还会在改动时漂移。删除并把覆盖归并到更强的那份。
- **只看 `_bucket` 出现与否来判断直方图用法。** 已采用并验证：`histogram_quantile`
  与 `rate(..._bucket[...])` 都能识别，`_sum`/`_count` 直接使用也放行。
- **给网关指标也建一份静态清单文件。** 否决：会与 `META` 表漂移；直接从
  `META` 抽取定义可保证单一事实源。

## Consequences

- `check-domains` 现在真正强制 spec §4.5 规则 2/6；`submission → observability/index.ts`
  报违规、`admin → observability/index.ts` 放行，两者都有回归用例。
- 三个扫描器不再零输入空过；门禁在目录结构变化时会**失败**而不是假绿。
- `check-metrics` 覆盖网关；网关的拼错指标名会被 CI 拦下（变异测试确认）。
- 新增两条仓库级门禁（`check-test-discovery`、`check-dashboards`），均已接入
  `check-ci.ts`（CI）与 `check-all.ts`（本地），并各自带单元测试（含非空转用例）。
- 实测无效资产减少：`tests/routes/health.ts`（永不执行）、
  根 `docs/operators/observability.md`（孤儿且已漂移）被删除；
  Grafana 的 LLM 耗时 panel 从"永远为空"变为可用的 p95。
- 文档与代码现状对齐：`shared/middleware/`、观测域职责、测试目录说明均已订正。
- 未做（评审提到但超出本 PR 范围）：`check-runtime-contract` 的 descriptor 运行时
  接线（`healthUrl`/`metricsUrl`/`heartbeatKey` 目前只有静态检查读取）、
  `registerBusinessMetric` 失败的日志与 `reason` 标签、`/health` 顶层依赖字段的
  guard。这些属功能补齐而非门禁修复，留作后续项。
