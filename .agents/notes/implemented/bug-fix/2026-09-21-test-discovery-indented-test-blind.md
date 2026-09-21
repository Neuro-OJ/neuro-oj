# Agent Note: 测试可发现性门禁的缩进启发式放过控制流块内的测试

Status: implemented

## Problem

`scripts/check-test-discovery.ts` 用一条行级启发式来区分"真实测试文件"与"测试
工厂"（把 `Deno.test` 包在导出函数里供他人调用的辅助模块，如
`noj-tests/e2e/helper.ts` 的 `e2eTest()`）：

```ts
const hasTopLevelTest = /^(?!\s*(?:\/\/|\*)).*?\bDeno\.test\s*\(/m.test(
  content.split("\n").filter((l) => !/^\s/.test(l)).join("\n"),
);
```

它先**剔除所有以空白开头的行**，再看剩余内容。于是任何写在缩进块里的
`Deno.test`（for / if / try 等控制流块，而非函数体）都被当成"函数体内的工厂
调用"而放过。

触发条件：新增文件名不可发现、但把 `Deno.test` 放进控制流块的文件：

```ts
// noj-core/tests/routes/health.ts（文件名不匹配运行器模式）
for (const c of ["a", "b"]) {
  Deno.test(`case ${c}`, () => {});
}
```

实测（修复前）：

```
$ deno run -A scripts/check-test-discovery.ts
测试文件可发现性检查通过        ← 该文件既不被运行器发现，也不被门禁标记
```

单测：

```
hasFileLevelTest: 识别控制流块内的 Deno.test ... FAILED
findUndiscoverableTests: 控制流块中的测试文件会被报出 ... FAILED
error: AssertionError: 控制流块内的测试文件必须被报出，实际 []
```

这正是门禁立项目标（"写了 Deno.test 但文件名不被运行器发现、永不执行却显示
绿色"）所针对的情形，只是绕过方式是缩进而非函数。

## Decision

用 `hasFileLevelTest(content)` 替换行级启发式：扫描源码（跳过行/块注释与
字符串字面量），维护「未闭合 `{` 是否属于函数体」的栈；只要存在一个
**不在任何函数体内**的 `Deno.test(` 调用，就认定为文件级测试。

- 函数体判定 `looksLikeFunctionBrace`：`function ...(...) {`、`(...) => {`、
  `=> {`、`constructor {`，以及 `function` 与 `{` 之间有返回类型注解的情形；
- 顶层调用、for/if/try 块内的调用都会命中；
- 测试工厂（`e2eTest()` 的调用在函数体内）继续被跳过。

回归用例（`scripts/check-test-discovery_test.ts`）新增 3 条：`hasFileLevelTest`
的 6 组输入、控制流块文件被报出、真实仓库的 `helper.ts` 不被误报。

## Alternatives considered

1. **只把"剔除缩进行"改成"剔除函数体行"（用正则找函数边界）**：拒绝。
   函数边界的正则匹配在箭头函数、返回类型注解、嵌套函数下极易漏判，且无法
   处理 `for {}` 这类非函数块——正是本缺陷的绕过方式。
2. **引入 TypeScript AST（`deno_ast`）解析**：更精确，但会给门禁引入重依赖与
   解析开销；本脚本是"静态棘轮"性质，手写括号栈已足够覆盖真实写法。
3. **直接禁止测试文件里出现非顶层 `Deno.test`**：拒绝。会误伤控制流块内合法
   生成测试的写法（本仓库已存在此类用法），且改变了门禁的判定语义。

## Consequences

- 控制流块内的测试文件自此会被门禁发现；真实仓库当前 0 违规（仍 exit 0）。
- `noj-tests/e2e/helper.ts`（测试工厂）继续被正确跳过，有回归用例锁定。
- 不改动 `DISCOVERY_PATTERNS`、扫描根或报告格式。
