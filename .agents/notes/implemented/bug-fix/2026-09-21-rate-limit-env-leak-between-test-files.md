# Agent Note: rate-limit 测试的模块级环境泄漏污染同进程后续文件

Status: implemented

## Problem

`RateLimitEnabled` 开关（`src/domains/system/services/rate-limit-env.ts`）在
`NOJ_ENV=test` 下默认关闭，需要它的测试文件用 `Deno.env.set` 显式打开。但两个文件
把这件事写在了**模块顶层**，且从不还原：

| 文件 | 行（修复前） | 泄漏变量 |
| --- | --- | --- |
| `src/domains/submission/tests/routes/self-tests.test.ts` | 11 | `RATE_LIMIT_ENABLED=true` |
| `src/domains/system/tests/middleware/rate-limit.test.ts` | 17 | `RATE_LIMIT_ENABLED=true` |

Deno 的测试文件在同一次运行中**共享进程环境**，模块级 `set` 因此对随后执行的
文件持续生效。`isRateLimitEnabled()` 在 test 模式下会读该变量，于是后续文件的
请求被意外限流成 429。

实测（`REDIS_URL` 已设置，限流路径才会真正生效）：

```text
problem-bundle.test.ts 单独跑                      → ok | 19 passed | 0 failed
self-tests.test.ts + problem-bundle.test.ts 同进程  → FAILED | 12 passed | 8 failed
```

8 处失败全部是 429 —— 与 `problem-bundle` 自身逻辑无关（单独跑全绿），纯属上游
文件的环境泄漏。

该缺陷此前不可见，是因为 `deno test` **不按命令行参数顺序执行**：文件以目录为
单位被运行时重新排序，泄漏是否命中取决于相对顺序。任何新增文件改变相对顺序都会
让它以「莫名其妙的 429」形式浮出水面，属于典型的潜伏型脆弱测试。

## Decision

两个文件各自引入 scoped guard，把开关限制在真正需要它的用例内，并用
`try/finally` 在结束（含失败）时还原为进入前的值（原本未设置则 `delete`）：

```ts
async function withRateLimitEnabled<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = Deno.env.get("RATE_LIMIT_ENABLED");
  Deno.env.set("RATE_LIMIT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("RATE_LIMIT_ENABLED");
    else Deno.env.set("RATE_LIMIT_ENABLED", previous);
  }
}
```

`rate-limit.test.ts` 的 9 个用例保持**逐个显式书写** `ignore: !hasEnv` 与
`withRateLimitEnabled(async () => { ... })`，没有抽成注册器。原因是
`scripts/silent-skip-report.ts` 是**静态文本扫描**（按 `ignore:` 字面量计数并纳入
棘轮基线）：曾尝试用 `rateLimitTest()` 注册器统一补 `ignore: !hasEnv`，结果 9 处
字面量收敛成 1 处，扫描命中数由 509 掉到 502——即 8 处静默跳过对治理门禁**变得
不可见**，等于悄悄放宽了棘轮。已回退为逐用例显式书写，命中数恢复 509。

`self-tests.test.ts` 只有「超过每用户限流阈值返回 429」一个用例需要该开关，单独包裹。
`rate-limit.test.ts` 中「重复触发 `_resetRateLimitForTest` 不抛错」是同步用例、只调
重置辅助函数，不需要限流开关，故未包裹——已实测在 `RATE_LIMIT_ENABLED=false` 下
单独跑该用例仍通过，证明它确实不依赖该变量。

## Alternatives considered

- **在文件末尾 `Deno.env.delete`**：模块顶层无法可靠地在「本文件全部用例结束后」
  执行（`Deno.test` 是异步注册/执行模型），失败路径更不会走到；scoped guard 才能
  保证还原。
- **测试启动时统一 `--allow-env` 白名单隔离**：Deno 的环境变量在单进程内无文件级
  隔离能力，做不到按文件重置。
- **把 `ignore: !hasEnv` 与 env 设置都塞进每个用例的 `fn` 开头**：可行但重复度高、
  易漏，且忽略「用例中途断言失败也要还原」这一点；注册器 + `try/finally` 更稳。
- **让限流测试改用显式传参而非环境变量**：属产品代码的行为变更，需人工裁决。

## Consequences

实测三个场景全部转绿，且用例仍真实执行（未被 skip 掉）：

```text
self-tests + problem-bundle 同进程    → ok | 28 passed | 0 failed
rate-limit + problem-bundle 同进程    → ok | 28 passed | 0 failed
rate-limit.test.ts 单独               → ok |  9 passed | 0 failed
```

`noj-core` 模块全量套件 `bash scripts/test-all.sh` 保持
`ok | 1325 passed | 0 failed | 58 ignored`。

同机制还存在于 `tests/smoke.test.ts` 等文件的 `false` 方向设置，方向相反
（关掉限流）故不产生 429，未在本修复中改动。
