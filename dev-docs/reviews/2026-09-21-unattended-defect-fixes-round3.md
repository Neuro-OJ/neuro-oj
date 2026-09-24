# 无人值守缺陷修复交付报告（2026-09-21 · 第三轮）

> 承接 `lrwwtnuo`（第二轮报告 + 5 条修复）继续的无人值守缺陷修复与测试栈加强。
> 本文档记录**每条修复的完整证据链**（触发条件 + 修复前真实失败输出 + 修复后
> 真实转绿输出）、受影响模块的验收命令与结果，以及**待人工裁决**的候选。
>
> 本轮共 **18 条**可复现缺陷修复 + 测试栈加强（含 2 条经人工裁决后实施的产品/流程变更），覆盖
> `root` / `core` / `judge` / `ui` / `llm-gateway` / `cli` 六个模块。
> 每条 = 一个独立 jj change，中文 Conventional Commits，GPG 签名。

## 范围约束（自我执行口径）

1. 只修「经自己取证到可复现」的缺陷：每条都有触发条件 + 修复前失败的真实命令
   输出 + 修复后转绿的真实输出。
2. 多模块广撒网：root（仓库级门禁）、core、judge、ui、llm-gateway、cli。
3. 会改变产品行为的候选项**只报告、标「待人工裁决」**，不自行改。
4. 每条缺陷一篇 Agent Note，落在 `.agents/notes/implemented/`，
   通过 `scripts/verify-agent-note-format.ts`。

---

## 一、修复清单（每条 = 一个独立 jj change）

| # | 模块 | 缺陷 | 类别 | Agent Note |
| --- | --- | --- | --- | --- |
| 1 | core | 私信单会话未读数缺少参与者校验（IDOR） | 安全 | `bug-fix/2026-09-21-messaging-unread-count-idor.md` |
| 2 | root | `check-domains` 遗漏 `search` 域，跨域 import 不设防 | 门禁盲区 | `bug-fix/2026-09-21-check-domains-missing-search-domain.md` |
| 3 | root | Deno 版本门禁只校验 noj-core 的 Dockerfile | 门禁盲区 | `bug-fix/2026-09-21-deno-version-gate-missing-dockerfiles.md` |
| 4 | root | 静默跳过扫描对 `ignore: <标识符>` 整类写法失明 | 假绿 | `bug-fix/2026-09-21-silent-skip-ignore-identifier-blind.md` |
| 5 | core | 社区列表端点非法 `limit` 使夹取失效致静默空列表 | 功能 | `bug-fix/2026-09-21-community-query-limit-nan.md` |
| 6 | core | `deleteProblem` 未清理 `self_tests`，有自测的题目无法删除 | 功能（500） | `bug-fix/2026-09-21-delete-problem-self-tests-fk.md` |
| 7 | cli | `stream()` 不消费 stderr，`logs --follow` 管道写满挂死 | 资源/挂死 | `bug-fix/2026-09-21-cli-stream-stderr-deadlock.md` |
| 8 | gateway | BYOK 更新可改写 `enabled` / 负 `cost`（越权与配额退款） | 安全 | `bug-fix/2026-09-21-byok-update-mass-assignment.md` |
| 9 | judge | Redis 集成测试连接失败时静默记为通过 | 假绿 | `testing/2026-09-21-judge-redis-tests-silent-pass.md` |
| 10 | core | 超大 `page` 使 OFFSET 溢出 PG bigint（500） | 功能（500） | `bug-fix/2026-09-21-pagination-offset-bigint-overflow.md` |
| 11 | ui | sitemap 缓存按 Host 无界增长（DoS） | 安全/资源 | `bug-fix/2026-09-21-ui-sitemap-cache-unbounded.md` |
| 12 | root | 覆盖率报告在 TTY 下因 ANSI 转义静默丢失模块 | 假绿/门禁 | `bug-fix/2026-09-21-coverage-report-ansi-parsing.md` |
| 13 | root | 单文件规模棘轮 `SCAN_ROOTS` 遗漏 `noj-cli` | 门禁盲区 | `bug-fix/2026-09-21-file-size-gate-missing-noj-cli.md` |
| 14 | root | Grafana 看板门禁裸前缀匹配让 `up*` 拼错指标逃逸 | 门禁盲区 | `bug-fix/2026-09-21-dashboard-external-prefix-overmatch.md` |
| 15 | root | 测试可发现性门禁的缩进启发式放过控制流块内测试 | 假绿/门禁 | `bug-fix/2026-09-21-test-discovery-indented-test-blind.md` |
| 16 | root | 看板门禁指标兜底把调用点字面量当定义（恒真断言） | 假绿/门禁 | `bug-fix/2026-09-21-dashboard-untyped-literal-fallback.md` |
| 17 | root | `check-all` 与 `check-ci` 门禁清单分叉（本地少 19 项） | 流程/门禁 | `process/2026-09-21-unified-gate-entrypoints.md` |
| 18 | core | 搜索限流登录用户维度不可达（校园机房 NAT 下搜索不可用） | 功能/产品 | `bug-fix/2026-09-21-search-rate-limit-authed-dimension.md` |

---

## 二、逐条证据链

### 1. 私信单会话未读数 IDOR（core）

- **触发条件**：登录用户（非会话参与者）请求
  `GET /api/v1/conversations/<他人会话 UUID>/unread-count`。
- **修复前**（临时移除校验后运行真实用例）：
  ```
  messages: 非参与者查询他人会话未读数被拒绝（IDOR） ... FAILED
  error: AssertionError: Expected function to reject.
  ```
  即返回了对方会话的消息数（元数据泄露）。
- **修复后**：同一用例 `ok`（1 passed / 0 failed）。
- **实现**：服务入口复用 `assertParticipant`，与同文件其余 5 个读取入口口径一致。

### 2. `check-domains` 遗漏 search 域（root）

- **触发条件**：在 `domains/search/services/search.ts` 顶部加入
  `import { getProblem } from "../../catalog/services/problems/problems-crud.ts"`。
- **修复前**：
  ```
  $ deno run -A scripts/check-domains.ts
  域边界检查通过            ← 违规被完全放行
  ```
  新回归用例：`error: expected search, got null`。
- **修复后**：
  ```
  $ deno run -A scripts/check-domains.ts
  发现 1 条域边界违规:
  - noj-core/src/domains/search/services/search.ts: search 域不得深路径导入 catalog 域
  ```
  真实仓库（无注入）仍 `域边界检查通过`。
- **加固**：新增「磁盘上每个 domains 子目录都被登记」守卫，防未来新域漏登记。

### 3. Deno 版本门禁遗漏 Dockerfile（root）

- **触发条件**：`noj-ui/Dockerfile` / `noj-llm-gateway/Dockerfile` 的
  `denoland/deno` 镜像与 `.dvmrc` 主次版本不一致。
- **修复前**：夹具中 `noj-ui/Dockerfile` 为 `2.8.1`、`.dvmrc` 为 `2.9.5`：
  ```
  error: AssertionError: noj-ui/Dockerfile 的版本漂移应被检出，实际 errors=[]
  ```
- **修复后**：同一夹具报错包含 `noj-ui/Dockerfile`；真实仓库 4 个 Dockerfile
  全部一致，门禁 exit 0。
- **加固**：改为递归扫描全部 `Dockerfile*`（不再写死两项清单）+ 零输入守卫。

### 4. 静默跳过扫描失明（root）

- **触发条件**：`const skip = !hasEnv; Deno.test({ ..., ignore: skip })`。
- **修复前**：
  ```
  error: AssertionError: 5 条 ignore:<标识符> 都应命中，实际 0: []
  ```
  真实仓库扫描命中 **514** 处（`ignore=161`），而这些变量写法全部漏计。
- **修复后**：真实仓库命中 **989** 处（`ignore=636`，文件数 83 → 127）。
  基线同步更新；`--check` 全绿（989 = 989）。
- **说明**：数字跳变是「长期不可见的部分第一次被记账」，非新增跳过。

### 5. 社区非法 limit 静默空列表（core）

- **触发条件**：`GET /api/v1/community/posts?type=discussion&limit=abc`
  （造 25 条讨论帖后）。
- **修复前**：
  ```
  error: AssertionError: Values are not equal:
    limit=abc 应回退到默认 20 条，实际返回 0 条
  ```
  根因：`Number("abc")=NaN` → `Math.min/Math.max` 夹取整体返回 `NaN` →
  Drizzle `.limit(NaN)` **静默省略 LIMIT 子句** → `collected.length <= NaN`
  为 false → 返回空集。
- **修复后**：同一用例 `ok`；`/feed` `/bookmarks` `/notifications`
  `/admin/comments/pending` 同样回退。
- **实现**：新增纯函数 `parseQueryLimit`（5 个调用点复用）+ 6 条纯函数单测。

### 6. `deleteProblem` 与 self_tests 外键（core）

- **触发条件**：题目被任意用户自测过一次后，owner/admin 删除该题。
- **修复前**（真实 PG/PGlite）：
  ```
  Caused by: error: update or delete on table "problems" violates foreign key
  constraint "self_tests_problem_id_fkey" on table "self_tests"
  → 500 INTERNAL_ERROR
  ```
- **修复后**：同一用例 `ok`；题目与自测记录一并清理。
- **依据**：同 schema 中 `objective_*` / `community_posts` / `contest_problems`
  / `training_problems` / `problem_tags` 对 `problems` 全部 `ON DELETE cascade`，
  `self_tests` 的 `no action` 是遗漏；`deleteProblem` 已手动清理 `submissions`，
  只是漏了 `self_tests`。

### 7. cli `stream()` stderr 死锁（cli）

- **触发条件**：`noj-cli logs --follow` / `judge logs --follow` 的子进程
  （`docker compose logs --follow`）向 stderr 写入超过 64 KiB 管道缓冲。
- **修复前**（真实子进程复现，stderr 写 256 KiB）：
  ```
  结果：超时（死锁，stderr 未被消费）
  ```
  单测：`stream 应在子进程退出后返回退出码；超时(-1)说明 stderr 管道未被排空导致死锁`。
- **修复后**：同一用例 `ok`（16ms 返回），stderr 与 stdout 同样逐行回调。
- **实现**：stderr 增加并发排空循环，返回前 `await` 完成；接口签名不变。

### 8. BYOK 更新 mass assignment（gateway）

- **触发条件**：普通用户 `PUT /api/v1/users/me/llm-providers/:id`，body 带
  `enabled:true` 或 `cost_per_1k_tokens:-100000`（core 路由原样转发请求体）。
- **修复前**：
  ```
  providers: BYOK 更新拒绝 enabled（用户不得自行解禁） ... FAILED
  error: Error: expected provider_invalid
  providers: BYOK 更新拒绝负 cost（防止配额退款） ... FAILED
  error: Error: expected provider_invalid for -1
  ```
  负 cost 经 Lua `INCRBY` 会减少 user/global/problem 共享 cost 计数器。
- **修复后**：4 条新用例全绿；管理员行（`created_by="0"`）仍可改 `enabled`/cost。
- **实现**：BYOK 字段白名单 + cost 范围 `[0, 1e6]`。

### 9. judge Redis 测试静默通过（judge）

- **触发条件**：设置了 `REDIS_URL` 但 Redis 不可达（CI service 未起 / 端口错）。
- **修复前**：
  ```
  $ REDIS_URL=redis://127.0.0.1:6398/9 cargo test --test user_claim_redis
  test result: ok. 7 passed; 0 failed; 0 ignored
  ```
  其中包含最关键的 `concurrent_claims_only_one_wins`。
- **修复后**：同一条命令
  ```
  test result: FAILED. 1 passed; 6 failed; 0 ignored
  ```
  未设置 `REDIS_URL` 的本地跳过语义不变（打印提示后跳过）。
- **性质**：测试栈假绿修复，不改动生产代码。

### 10. 分页 OFFSET 溢出 bigint（core）

- **触发条件**：`GET /api/v1/problems?page=9900000000000000000&limit=100`。
- **修复前**：
  ```
  DBG status = 500
  body = {"error":"服务器内部错误","code":"INTERNAL_ERROR","request_id":"16f3..."}
  ```
  单测：`page=99000000000000000 应由 ValidationError 提前拒绝`（实际 200）。
- **修复后**：同一请求 → **400**；`page=1&limit=20` 仍 200。
- **实现**：`MAX_SAFE_PAGE` 单一事实源，`parsePagination` + 6 处内联解析统一上界。

### 11. UI sitemap 缓存无界增长（ui）

- **触发条件**：`NUXT_SITE_URL` 未配置时，对 `/sitemap.xml` 循环发送不同
  `Host`（每个新 Host 是一个永不删除的缓存键，且触发上游扇出）。
- **修复前**：
  ```
  error: AssertionError: sitemap 路由不得再使用无界的裸 Map 作为缓存
  ```
- **修复后**：8 条用例全绿；容量上限 100 + LRU 淘汰；降级分支用 `peekStale`
  回退完整旧缓存（保留既有语义，不受 TTL 约束）。
- **实现**：抽出 `server/utils/sitemap-cache.ts`（可测的 `SitemapCache`）。

### 12. 覆盖率报告 ANSI 解析（root）

- **触发条件**：在 TTY（本地终端）执行 `deno run -A scripts/coverage-report.ts --report`。
  `deno coverage` 会给单元格着色，输出形如
  `| \x1b[0m\x1b[32m    100.0\x1b[0m |`。
- **修复前**：
  ```
  ⚠ noj-ui 未解析到覆盖率数据（exit 0），请检查 test:coverage 任务输出
  ⚠ noj-llm-gateway 未解析到覆盖率数据（exit 0），请检查 test:coverage 任务输出
  ```
  即使两个模块都 exit 0 且覆盖率远超阈值，报告中仍缺失它们的行。单测：
  ```
  coverage-report: 带 ANSI 转义码的行也能解析 ... FAILED
  coverage-report: 带 ANSI 的完整表格仍能汇总 ... FAILED
  ```
- **修复后**：同一命令
  ```
  覆盖率报告已写入 dev-docs/engineering/test-coverage.md
  ```
  报告含 `| noj-ui | 94.6% | 92.1% | 93.5% |` 与
  `| noj-llm-gateway | 85.3% | 81.4% | 83.1% |`（不再有"未解析"告警）。
- **实现**：新增 `stripAnsi()` 在解析前剥离 SGR 序列；3 条回归用例。

### 13. 单文件规模棘轮遗漏 noj-cli（root）

- **触发条件**：在 `noj-cli/src/` 下新增一个 3000 行文件。
- **修复前**：`deno run -A scripts/check-file-size.ts` 仍
  `单文件规模检查通过（扫描 572 个源文件 / 超阈值 3 个均已登记）`——
  `noj-cli` 的 3 个既有超阈值文件（lifecycle.ts 2097 行、cli.ts 1611 行、
  config.ts 1218 行）从未受约束。单测：
  ```
  check-file-size: noj-cli 的超阈值文件被纳入扫描 ... FAILED
  check-file-size: 夹具中的 noj-cli 文件超阈值会失败 ... FAILED
  ```
- **修复后**：门禁报告 `扫描 638 个源文件 / 超阈值 6 个均已登记`（新增 3 个
  已登记基线，只允许下调）。
- **实现**：`SCAN_ROOTS` 补入 `noj-cli/src` + 2 条回归用例。

### 14. Grafana 看板门禁裸前缀匹配（root）

- **触发条件**：dashboard 引用 `up` 开头的自造/拼错指标
  （如 `sum(upload_failed_requests_total)`）。
- **修复前**：`isExternalMetric` 末条 `name.startsWith(p)` 使下划线边界失效：
  `upload_failed_requests_total`、`uptime_seconds`、`postgresql_x` 全被判为
  "标准导出器指标"，`引用了未定义的指标` 永不触发。单测：
  ```
  isExternalMetric: 不做裸前缀匹配（up*/postgres* 拼错不得放行） ... FAILED
  checkExpression: 拼错的 up* 指标会被报为未定义 ... FAILED
  ```
- **修复后**：改为精确匹配 + 下划线边界（带下划线前缀按下划线边界，不带下划线
  的前缀只允许 `p_`）。真实 dashboard 仍 `Grafana 看板表达式检查通过`。
- **实现**：`isExternalMetric` 边界修正 + 2 条回归用例。

### 15. 测试可发现性门禁的缩进启发式（root）

- **触发条件**：文件名不可发现、且 `Deno.test` 写在 for/if/try 控制流块内。
- **修复前**：`hasTopLevelTest` 剔除所有缩进行后再找 `Deno.test(`，于是控制流块
  内的调用被当成函数体工厂而放过；该文件既不被运行器发现也不被门禁标记。
  ```
  hasFileLevelTest: 识别控制流块内的 Deno.test ... FAILED
  findUndiscoverableTests: 控制流块中的测试文件会被报出 ... FAILED
  error: AssertionError: 控制流块内的测试文件必须被报出，实际 []
  ```
- **修复后**：改为括号栈判定「未闭合 `{` 是否属于函数体」（跳过注释/字符串），
  控制流块内的调用会被识别；真实仓库仍通过，`helper.ts`（工厂）不被误报。
- **实现**：`hasFileLevelTest` 替换行级启发式 + 3 条回归用例。

### 16. 看板门禁指标兜底（root）

- **触发条件**：源码出现自造 `"noj_..."` 字面量，dashboard 引用同名指标。
- **修复前**：`collectDefinedMetrics` 的兜底 `/"(noj_[a-z0-9_]+)"/g` 把**调用点**
  也登记为已定义 → `引用了未定义的指标` 永不触发。与 `check-metrics.ts` 早已
  修复的同一缺陷（其注释记录了该恒真断言）口径不一致。单测：
  ```
  collectDefinedMetrics: 调用点字面量不得被当作指标定义 ... FAILED
  collectDefinedMetrics: 真实仓库不产生 unknown 兜底条目 ... FAILED
  实际 [["noj_oauth_state","unknown"],["noj_api_error_rate_percent","unknown"],
       ["noj_api_average_latency_ms","unknown"],["noj_observability_write_errors_total","unknown"],
       ["noj_observability_metric_dropped_total","unknown"]]
  ```
- **修复后**：收紧为 `name:\s*"noj_..."`（与真实定义字段一致）；真实仓库
  `unknown` 兜底条目 5 → 0，拼接错指标会被报出，门禁仍 exit 0。
- **实现**：兜底正则收紧 + 2 条回归用例。

### 17. 门禁入口统一到单一事实源（root，人工裁决后实施）

- **触发条件**：本地跑 `deno run -A scripts/check-all.ts`。
- **修复前**：该入口比 CI 的 `check-ci.ts` 少 19 项门禁（静默跳过棘轮、迁移安全、
  迁移快照链、日志迁移/一致性、文件规模、写端点限流、Deno 版本、schema parity
  及 9 个自测）——本地显示"全部检查通过"而同一份代码在 CI 红灯。
- **修复后**：新增 `scripts/gate-list.ts` 作为清单单一事实源
  （`REPO_GATES` 29 条 + `MODULE_CHECKS` 3 条），两个入口都从它派生；
  `check-all.ts` = `REPO_GATES` + `MODULE_CHECKS`，**严格覆盖 CI**。
  防分叉守卫 `scripts/gate-list_test.ts`（6 条用例，含"两个入口不得再手写
  `run([...])`"与"关键门禁不得删除"）。
- **实测**：`deno run -A scripts/check-all.ts` → 仓库级门禁 + 模块级 check 全绿。

### 18. 搜索限流的登录用户维度（core，人工裁决后实施）

- **触发条件**：多用户共享同一出口 IP（校园机房 / 企业 NAT），匿名请求把
  `rate_limit_search_max_anon` 打满。
- **修复前**：`GET /api/v1/search` 永远传 `searchRateLimit("anon")`，已登录
  用户也按 IP 计数 → 被匿名配额 429；`rate_limit_search_max_authed` 为死配置，
  与 `CLAUDE.md`「登录用户 30s/120 次」的承诺不符。单测：
  ```
  search route: 登录用户走用户维度桶，不受共享 IP 匿名配额影响 ... FAILED
  error: AssertionError: 登录用户不得被共享 IP 的匿名配额挤占（NAT 场景）
  ```
- **修复后**：中间件新增 `"auto"` 维度（按是否登录自动选择），路由改用
  `searchRateLimit("auto")`；**登录用户只走用户桶、不叠加 IP 桶**，匿名行为不变。
- **实现**：2 条回归用例（NAT 场景 + 用户维度超限 429）。

---

## 三、受影响模块验收（真实命令与结果）

| 模块 | 命令 | 结果 |
| --- | --- | --- |
| root | `deno run -A scripts/check-ci.ts` | 通过（含 157 个门禁自测） |
| root | `deno run -A scripts/verify-agent-note-format.ts` | 通过（161 篇） |
| root | `deno run -A scripts/check-test-discovery.ts` | 通过 |
| root | `deno run -A scripts/check-domains.ts` | 通过 |
| root | `deno run -A scripts/check-file-size.ts` | 通过 |
| core | `deno task check` | exit 0（fmt + lint + typecheck） |
| core | `deno task test` | `1343 passed / 0 failed / 58 ignored` |
| core | `deno task test:parallel` | 全分片通过，`1060 passed / 0 failed / 11 ignored` |
| core | `deno task test:domain {messaging,community,catalog,admin,identity}` | 67 / 64 / 195 / 9 / 297 passed，全 0 failed |
| cli | `deno task check` / `deno task test` | exit 0；`731 passed / 0 failed / 4 ignored` |
| gateway | `deno task check` / `deno task test` | exit 0；`73 passed / 0 failed / 1 ignored` |
| gateway | `deno task test:coverage` | 通过（含新增用例的类型检查） |
| ui | `deno task check:types:nuxt`（vue-tsc） | 通过 |
| ui | `deno task test` / `deno task lint` | `145 passed / 0 failed`；lint 干净 |
| ui | `deno task test:coverage` | `All files 94.6%` |
| judge | `cargo test --all-targets` + `REDIS_URL=... cargo test --all-targets` | 全绿 |
| judge | `cargo fmt --check` / `cargo clippy --all-targets` | 干净（0 warning） |

---

## 四、测试栈加强（本轮的三个横切修复）

| 主题 | 缺陷 | 修复 |
| --- | --- | --- |
| 静默跳过 / 假绿 | 扫描器只看三种 `ignore:` 字面量，变量守卫（475 处）全部漏计 | 补标识符规则，基线 514 → 989 |
| 假绿 | judge Redis 测试把「连不上」当「未配置」跳过，记为 passed | 区分两种语义，连不上即失败 |
| 门禁盲区 | `check-domains` 漏 `search` 域；`check-deno-version` 漏非 core Dockerfile | 补登记 + 递归扫描 + 防漏登记守卫 |

**三条测试路径行为一致性**（本轮实测口径，均已统一）：

| 路径 | 命令 | 用例数 | 结果 |
| --- | --- | --- | --- |
| PGlite 全量 | `deno task test` | 1343 passed / 58 ignored | 全绿 |
| 并行分片 | `deno task test:parallel` | 1060 passed / 11 ignored | 全绿 |
| 分域（真实 PG） | `deno task test:domain <d>` | 逐 domain 见上表 | 全绿 |

---

## 五、待人工裁决清单（不自行改）

> 以下两项已经人工裁决并实施，见上文修复 #17 / #18：
> `check-all` 与 `check-ci` 门禁清单分叉、`searchRateLimit("authed")` 维度不可达。
2. **`silent-skip-report.ts --check` 会先覆写受版本控制的报告文件**
   - 观察：门禁失败前已把 `dev-docs/engineering/test-silent-skips.md` 写入磁盘。
   - 为何不自改：涉及「生成产物是否提交」「失败时是否应保持只读」的流程取舍。
3. **judge 时间配置无上界**
   - 观察：`JUDGE_MAX_EVALUATOR_TIME_MS` / `JUDGE_USER_CLAIM_TTL_MS` 只
     `env_var_parse` + `.filter(> 0)`，无上限；`main.rs` 的启动期安全不变量校验
     用 `as i64` 比较，`> i64::MAX` 的合法 u64 会回绕为负，校验被静默跳过。
   - 为何不自改：需决定是否引入配置上界（会让既有部署的启动行为变化），
     属产品/运维策略。
4. **gateway / judge 先整读上游响应体再判大小上限**
   - 观察：`llm.ts` 与 `dual/mod.rs` 都先 `await response.text()` 才比较
     1 MiB 上限；上限不约束内存占用。
   - 为何不自改：改流式读取会改变错误处理路径与返回结构，需裁决。
5. **`noj-lmcc-extension` 未纳入 `check-test-discovery` / `silent-skip-report` 扫描根**
   - 观察：该模块有 `src/test/{api,polling}.test.ts`（`node --test` 体系）。
   - 为何不自行纳入：会改变门禁覆盖口径与基线；测试体系不同，判定规则需先明确。

---

## 六、附：已取证但判定为「非缺陷」的候选（避免误报）

- **`check-migration-snapshot-chain.ts --check`**：`--check` 在此脚本是位置参数
  （脚本签名接受路径），误传会让 Deno 报 `readdir '--check'` 不存在。核查
  `check-ci.ts` 中该门禁**不带 `--check`**，属调用方误用而非脚本缺陷。
- **支持包权限的 `package_manage_any`「口径漂移」**：核查
  `checkSupportPackagePermission` 与 `getSupportPackageBytes` 对 P/U 型的判定
  完全一致，不构成越权放大。
- **分页小页码（如 `page=9.9e16` 且 `per_page=20`）不溢出**：属边界量级差异，
  本轮按"必然溢出"的上界统一处理，不构成独立缺陷。
