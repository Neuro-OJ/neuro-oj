# 验证报告：全量测试环境对齐（`test-all.sh`）

对 `.agents/notes/implemented/bug-fix/2026-09-21-core-test-env-alignment.md`
所述修复的**独立复核**。所有结论均以实跑退出码 / 计数为依据，未采信注释中的自述数字。

## 1. 修复本身：复核通过

三份日志为同机、同 PGlite（`env -u DATABASE_URL`）、`BCRYPT_SALT_ROUNDS=4` 实测：

| 环境 | 结果 |
| --- | --- |
| 修复前基线（`NOJ_ENV`、`JWT_SECRET` 均未设置） | `FAILED \| 1240 passed \| 12 failed \| 131 ignored` |
| 仅补 `JWT_SECRET` | `FAILED \| 1311 passed \| 14 failed \| 58 ignored` |
| 修复后 `deno task test`（即 `scripts/test-all.sh`） | `ok \| 1325 passed \| 0 failed \| 58 ignored` |

- 12 处失败与 **73 处静默跳过**（131→58）同时消除，与 note 陈述一致。
- 根因 A/B 可**单文件级**独立复现，不是全量套件的涌现现象：
  `problem-bundle.test.ts` 单独跑，`NOJ_ENV` 未设置时 `11 passed | 8 failed`（429），
  `NOJ_ENV=test` 时 `19 passed | 0 failed`。
- `scripts/test-all.sh` 的兜底优先级正确：外部显式传入 > 脚本兜底，CI 真实
  `JWT_SECRET` 不受影响；`DATABASE_URL` 不兜底，避免 `resetDbForTest()` 的
  TRUNCATE 落到真实开发库。
- 附带核验：`verify-agent-note-format` 通过（142 篇）；`silent-skip-report --check`
  通过（509 处 ≤ 基线 516 处），棘轮方向正确。

## 2. 未修复：测试隔离缺陷仍有第 2、3 处同类实例

note 把根因 C 记为「`admin-settings-email.test.ts` 的 `EMAIL_PROVIDER` 泄漏」并已修。
但同一机制（模块级 `Deno.env.set` 且无还原）在仓库内**至少还有两处**，均未修：

| 文件 | 行 | 泄漏变量 | 还原 |
| --- | --- | --- | --- |
| `src/domains/submission/tests/routes/self-tests.test.ts` | 11 | `RATE_LIMIT_ENABLED=true` | 无 |
| `src/domains/system/tests/middleware/rate-limit.test.ts` | 17 | `RATE_LIMIT_ENABLED=true` | 无 |

两者均在**模块顶层**设 `RATE_LIMIT_ENABLED=true`（注释写着「NOJ_ENV=test 时默认关闭」，
即有意为单文件打开限流），且从不还原。`isRateLimitEnabled()`
（`src/domains/system/services/rate-limit-env.ts:62`）在 test 模式下会读该变量，
因此泄漏会把限流**打开**留给同进程后续文件。

已实测该泄漏确实能打死后续文件：

```
deno test ... self-tests.test.ts problem-bundle.test.ts
→ FAILED | 12 passed | 8 failed   （problem-bundle 全部 429）
```

**当前是否已在 CI 变红：尚未，属于潜伏缺陷。** 依据：

- 全量套件中 `rate-limit.test.ts`（第 2500 行）之后仍有 20 个文件，但未触发失败
  ——因为 `rate-limit-env.ts` 的 test 模式返回值与全量路径的预期恰好一致。
- 更关键的是 **`deno test` 不保留参数顺序**（实测把 `submission/routes` 放在
  `catalog/routes` 之前，执行顺序仍为 catalog 在前），所以「谁污染谁」不由
  `test-parallel.ts` 的 `dirs` 顺序决定，而是按发现顺序固定排列。这既解释了目前
  为何没炸，也说明**一旦文件增删改变相对顺序，失败会以 429 形式突然出现**，
  且报错指向产品限流而非测试污染——与 note 中根因 C 描述的误导性完全同型。

建议：与 `admin-settings-email.test.ts` 采用同一口径修复（`withX()` + `finally` 还原 +
重刷 env 快照/设置缓存）。这两处不是新的独立缺陷，而是根因 C 的**未清理残留**。

## 3. 未修复：全量路径仍无 CI 门禁（note 已自述，此处补充可执行依据）

note 的 Consequences 承认「CI 只跑 `scripts/test-domain.sh <domain>`、从不跑全量
`deno task test`」。补充两点实测：

1. `scripts/test-all.sh` 除 `noj-core/deno.json` 的 task 定义外，**无任何 CI/gate
   引用**（对 `.github/`、`scripts/`、`noj-core/scripts/` 全量搜索无命中）。
   即本次修复的这条路径本身仍不受门禁保护，同一类环境漂移可再次静默发生。
2. 域门禁只校验「domain 有 tests 目录」，**不校验测试文件是否真被执行**：
   `scripts/verify-domain-ci.ts` 仅有 `fail("src/domains/<d> 缺少 tests 目录")`，
   `scripts/test-domain.sh` 的 domain 白名单与全部 14 个 domain 一一对应（无遗漏）。

## 4. 新增发现：3 个测试文件永不被任何路径执行

`tests/` 下的裸文件既不被 `test-shared.sh`/`test-parallel.ts`（按**显式子目录**
枚举，不含 `tests/*.ts` 通配）、也不被 `test-domain.sh`（按 domain）覆盖。当前无
CI/gate/脚本引用命中：

- `noj-core/tests/security-headers.test.ts`（1 例）
- `noj-core/tests/types_safety_test.ts`（2 例）
- `noj-core/tests/defensive-patterns_test.ts`（2 例）

`_setup.ts` 不是孤儿（由 `00_migrate_test.ts` 与 `check-schema-parity_test.ts` 共用）。
上述 3 个文件用例本身**全部通过**（本地 12 passed / 0 failed，含
`check-schema-parity_test.ts`），属「零成本可补门禁」而非产品缺陷。

两个相关的门禁盲区解释了为何无人察觉：

- `deno.json` 的 `test:coverage` 是**全树**扫描，因此覆盖率报告**包含**这些
  永不执行的用例——覆盖率会误导性地偏好它们。
- `scripts/check-test-discovery.ts` 只检查**文件名**可发现性，且扫描范围硬编码为
  `["noj-core", "noj-ui", "noj-tests", "noj-llm-gateway"]`，不含 `noj-cli`、
  `noj-lmcc-extension`、`scripts`。实测这三个目录当前无命名不合规的测试文件
  （唯一点名的 `scripts/check-test-discovery.ts` 是自指误报），故属**范围风险**而非
  现存缺陷；但该扫描也管不到「文件名合规却无人调用」这一类，正是上面 3 个孤儿的情形。

## 5. 复核通过的两处「疑似问题」（澄清，避免误报）

- **`core-perf` 缺 `NOJ_ENV=test`**：确实缺，但**不构成缺陷**。`core-perf` 只跑
  `tests/00_migrate_test.ts tests/perf src/domains/search/tests/perf`，这些性能用例
  不经过 HTTP/限流路径（无 `createApp`/`.request`/`fetch` 调用），
  `isRateLimitEnabled()` 不在链路上，故 429 误伤不适用。
- **根目录 `scripts/check-schema-parity_test.ts` 无引用**：误报。该路径系
  `discovered.txt` 记录时缺 `noj-core/` 前缀所致；实际文件为
  `noj-core/scripts/check-schema-parity_test.ts`，由根 `scripts/check-ci.ts:63`
  显式执行（7 例）。
- `tests/perf/community_search_bench.test.ts` 亦非孤儿：位于 `tests/perf` 目录内，
  由 `core-perf` 的目录参数覆盖。

## 6. 附带核验：`--env-file` 相关两处，结论与 note 一致

- `deno task test:parallel` 经 `deno.json` 的 `--env-file=.env` 运行，实测
  `NOJ_ENV=test` / `JWT_SECRET` / `EMAIL_PROVIDER=mock` 已正确进入
  `Deno.env`（`deno task` 确实解析并加载该文件），故 note 的「优先级靠 shell env」
  结论成立。
- `--env-file` 指向不存在的 `.env` 时 Deno **仅告警不报错**（实测 exit 0），
  因此 CI 中 `working-directory: noj-core` 找不到 `.env` 不会导致失败，
  只会退回 CI 注入的 job env——即 note 所说「CI 靠 job env」在行为上成立。
