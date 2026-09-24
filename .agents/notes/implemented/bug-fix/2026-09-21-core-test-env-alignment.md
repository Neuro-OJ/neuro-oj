# Agent Note: 全量测试环境对齐（JWT_SECRET / NOJ_ENV / 测试隔离）

Status: implemented

## Problem

`deno task test`（noj-core 全量串行测试）内联了一条命令串，只注入 `BCRYPT_SALT_ROUNDS`：

```
deno run -A scripts/prepare-pglite-template.ts && \
  BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts
```

它缺少 `NOJ_ENV=test` 与 `JWT_SECRET`——而这两项恰是 CI（`.github/workflows/ci.yml`
的 `Inject or validate JWT_SECRET` 步骤加各 job 的 `NOJ_ENV: test`）与
`scripts/test-domain.sh`（`NOJ_ENV:-test`、`JWT_SECRET:-noj-test-...`）都会提供的。
于是「本地全量测试」与「CI 分域测试」跑的并非同一套环境，实测出三类失败。

实测基线（`env -u DATABASE_URL deno task test`）：`1240 passed | 12 failed | 131 ignored`。

**根因 A：缺 `JWT_SECRET`。** catalog admin-problems 5 例、trainings 2 例直接失败，
报「环境变量 JWT_SECRET 未设置，无法签发 JWT」。更严重的是静默跳过：仓库中大量测试文件
以 `Deno.env.get("JWT_SECRET")` 做门控，缺失时整批用例被 **静默 ignore**。实测设置
`JWT_SECRET` 后 ignore 由 131 降至 58、passed 由 1240 升至 1320——即 73 个用例原本
「报告 ok、实则从未执行」，属于假绿而非通过。

**根因 B：缺 `NOJ_ENV=test`。** `isRateLimitEnabled()`
（`src/domains/system/services/rate-limit-env.ts:62`）在 `NOJ_ENV != test` 时读 DB 默认值
`rate_limit_enabled=true`，测试请求被限流成 429。实测仅设 `JWT_SECRET` 而不设
`NOJ_ENV` 时，catalog problem-bundle 9 例以 `429 != 200` 失败——这批用例在缺
`JWT_SECRET` 时被静默跳过，掩盖了限流误伤。

**根因 C：测试间环境泄漏（真实缺陷，非环境问题）。**
`src/domains/system/tests/routes/admin-settings-email.test.ts` 在测试函数内
`Deno.env.set("EMAIL_PROVIDER", ...)` 且从不还原。Deno 测试文件共享同一进程环境，
泄漏后同一次运行中后续文件触发 `ForbiddenError: 邮件服务未配置，暂不接受注册`
（`src/domains/identity/services/auth/auth-register.ts:181`）——
`seed_bootstrap_admin_test` 2 例 + `tests/smoke.test.ts` 3 例共 5 例失败，而报错指向
产品行为（注册被拒）而非测试污染，误导性极强。该缺陷只有在 A/B 修好后门控放开才暴露。

## Decision

1. 新增 `noj-core/scripts/test-all.sh`，与 `test-domain.sh` 对齐地注入
   `BCRYPT_SALT_ROUNDS:-4`、`NOJ_ENV:-test`、`JWT_SECRET:-noj-test-jwt-secret-fixed-value-with-32-chars-min`
   （均可用外部环境变量覆盖，CI 的真实密钥优先），保留 `env -u DATABASE_URL` 走 PGlite
   内存库并先校验模板缓存；`deno.json` 的 `test` task 改为 `bash scripts/test-all.sh`。
   不用内联 `deno task` 写法，因为实测 `deno task` **不展开** `${VAR:-default}`，
   直接写会把这串字面量当成变量值传下去。
2. 该测试文件的所有用例经 `withProvider(provider, fn)` 进入，`finally` 中把
   `EMAIL_PROVIDER` 还原为进入前的值（原本未设置则 `delete`），并重刷 env 快照与
   系统设置缓存。

## Alternatives considered

- 仅在各测试文件里逐个补 `JWT_SECRET` 兜底：只治 A 的失败面，治不了 B，且无法阻止
  新增文件继续用 env 门控造成静默跳过。
- 把 `JWT_SECRET` 写进 `deno.json` 的 `test` task 内联串：实测无效（见上，不展开 shell 默认值）。
- 用 `--env-file=.env`：会引入开发者本地真实配置，可能含真实邮件/存储凭据并让
  `EMAIL_PROVIDER` 等状态进入测试进程，与本缺陷要修的隔离问题相冲突。
- 只在断言前 `Deno.env.delete("EMAIL_PROVIDER")`：失败路径同样会漏，必须 try/finally
  才能保证一个失败用例不放大成跨文件连锁失败。
- 放宽 `EMAIL_PROVIDER` 就绪校验以让 smoke 通过：那会把真实产品约束（未配置邮件不开放
  注册）改掉来迁就测试污染，方向错误。

## Consequences

`bash scripts/test-all.sh`（即 `deno task test`）实测
`1325 passed | 0 failed | 58 ignored`，12 处失败与 73 处静默跳过同时消除。
剩余 58 处 ignore 经核为合理跳过（如 `loginThrottle.test.ts` 依 `REDIS_URL` 门控）。

仓库级静默跳过门禁 `scripts/silent-skip-report.ts --check` 实测通过
（509 处，未超基线 516 处），无需上调基线——本改动使跳过数下降，方向与棘轮一致。

环境变量优先级：外部显式传入 > 脚本兜底，因此 CI 注入的真实 `JWT_SECRET` 行为不变。
`DATABASE_URL` **不**兜底，避免误设时 `resetDbForTest()` 的 TRUNCATE 作用于真实开发库。

未改动 `test:domain` / `test:parallel` / `test:smoke`：前者本就注入环境，后两者语义
不同（`test:parallel` 依赖真实 PG 与 `.env`）。遗留问题是 CI 只跑
`scripts/test-domain.sh <domain>`、从不跑全量 `deno task test`，全量路径仍无 CI 门禁。
