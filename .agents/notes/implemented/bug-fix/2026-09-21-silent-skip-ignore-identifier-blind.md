# Agent Note: 静默跳过扫描器对 `ignore: <标识符>` 整类写法失明

Status: implemented

## Problem

`scripts/silent-skip-report.ts` 的 `LINE_RULES` 只识别三种 `ignore:` 字面量写法：

```ts
{ re: /\bignore\s*:\s*true\b/ }
{ re: /\bignore\s*:\s*!/ }
{ re: /\bignore\s*:\s*Deno\.env\.get/ }
```

但仓库里**数量最多**的一类写法是把守卫放进变量再传给 `ignore`：

```ts
const skip = !(hasDb && hasJwt);
Deno.test({ name: "...", ignore: skip, fn: async () => { ... } });
```

实测分布（`rg '\bignore\s*:\s*[A-Za-z_$]'`）：

| 写法 | 处数 |
| --- | --- |
| `ignore: skip` | 382 |
| `ignore: skipEnv` | 32 |
| `ignore: skipDb \|\| skipEnv` | 20 |
| `ignore: skipDb` | 17 |
| `ignore: skip \|\| !hasJwt` | 15 |
| `ignore: skip \|\| !hasRedis` | 9 |

这些**全部**被旧规则漏计——基线 `by_reason.ignore` 只有 161，正是漏计的结果。典型整文件守卫（`messaging/tests/routes/messages.test.ts` 32 处、
`system/tests/services/audit-log.test.ts` 9 处）在报告中零命中。

后果与门禁立项目标直接冲突：往任意测试文件写入

```ts
const skip = !hasEnv;
Deno.test({ name: "真实用例", ignore: skip, fn: () => {} });
```

`deno run -A scripts/silent-skip-report.ts --check` 仍 **exit 0**，新增的
"看起来通过、实则从不执行"用例不会被发现。

## Decision

在字面量规则**之后**追加一条标识符规则：

```ts
/\bignore\s*:\s*\$?(?!false\b|undefined\b|null\b)[A-Za-z_][\w$]*/
```

- 放在最后：`ignore: true` / `!...` / `Deno.env.get(...)` 仍归入原有 reason，
  既有基线的分类口径不变（只新增此前漏计的命中）；
- 排除 `false` / `undefined` / `null`：表示"不跳过"，计入会让基线被噪声灌满；
- 兼容 `$` 前缀（Svelte/模板场景，防御性）。

更新基线：**514 → 989 处**（`ignore` 161 → 636），扫描到的文件数
83 → 127。这不是"跳过变多"，而是**长期不可见的部分第一次被记账**。

回归用例（`scripts/silent-skip-report_test.ts`）新增 3 条：

1. 5 种变量写法都命中且 reason 为 `ignore`（修复前得到 `0` 命中）；
2. `true` / `!` / `Deno.env.get` 的分类不被新规则改变，`false` 不命中；
3. 两个真实文件（`messages.test.ts` / `audit-log.test.ts`）的命中数 > 0。

## Alternatives considered

1. **逐条把 `skip`、`skipEnv`、`skipDb` 等变量名加进正则白名单**：拒绝。
   变量名是任意取的，白名单必然漏；且每加一个新变量名都要改门禁。
2. **用 AST 解析 `Deno.test` 的 `ignore` 字段并求值**：拒绝（本轮）。需要引入
   TS AST 依赖与跨模块解析，成本与风险远超收益；基于行的棘轮本就是该脚本的
   既定设计（`renderReport` 输出"文件/行号/原因"三列）。若未来误报率上升，
   再升级为 AST 方案。
3. **只报告、不纳入基线（避免基线数字跳变）**：拒绝。该脚本自 2026-09-12
   评审起就是"棘轮 + 增长即失败"，不入基线等于放弃本次修复的意义。

## Consequences

- 基线从 514 跳到 989：这是**已存在的真实跳过**被首次记账，不是新增跳过。
  `--check` 仍全绿（当前 989 = 基线 989）。
- 自此新增任何形式的 `ignore: <任意标识符>` 都会让门禁失败，除非显式降低
  跳过数或更新基线并说明原因。
- 已知边界（未在本轮处理）：`if (!ready) return;`（测试体内提前 return，
  变量名任意）、`console.log("...skip...")`（英文 skip 而非"跳过"）仍不被识别。
  它们在基线中体现为 `early-return` 的既有条目；扩大这部分匹配需单独的
  评估（误报风险高于 `ignore:` 字段），不在本次"可复现缺陷"范围内。
