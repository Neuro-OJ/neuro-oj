# Agent Note: 无人值守缺陷修复的评审收尾——BYOK 白名单作用域、门禁自测登记与分页上界

Status: implemented

## Problem

PR #541 的取证与修复质量高，但评审发现 **1 处本次引入的功能回归** 与 **2 处
「测试栈加强」实际未生效**，另有两处同类缺陷漏网：

1. **BYOK 白名单按「行的归属」判定，误伤管理端**（本次引入的回归）。
   `updateProvider` 用 `existing.created_by !== "0"` 决定是否套用
   `BYOK_UPDATABLE_FIELDS`。但管理端编辑**用户自建** Provider 时，core 走的是
   **不带** `created_by` 的 `PUT /internal/providers/:id`
   （`noj-core/.../llm.ts:265`），而管理端 UI 的保存载荷恒带 `enabled` 与
   `cost_per_1k_tokens`（`noj-ui/pages/admin/llm/providers.vue`）。
   于是：`rejected = ["enabled","cost_per_1k_tokens"]` → 400 `provider_invalid`。
   后果是**管理员无法再启用/停用/改价用户自建 Provider**（唯一出路是删除），
   且管理端列表不暴露归属，管理员无从预判。白名单的语义是"用户不能自改管理面
   字段"，归属应来自**请求来源**而不是行。

2. **两个守卫测试不在任何执行入口内**。`scripts/gate-list_test.ts` 与
   `scripts/coverage-report_test.ts`（后者本次扩展了 ANSI 回归用例）都不在
   `GATE_SELF_TESTS` 里；全仓对它们的引用只出现在注释与文档中。这正是本 PR
   反复强调的"写了测试却永不执行、本地与 CI 都显示绿色"（假绿）——
   修复 #17（门禁单一事实源）与 #12（coverage 报告剥离 ANSI）因此没有防回归
   闸门。另有 4 个存量门禁自测同样无人执行（`test-baseline` / `verify-md-links` /
   `verify-export-jsdoc` / `verify-agent-note-format`）。

3. **分页上界仍有同类漏网**：`admin/routes/community.ts` 的 `parsePage`
   （`Number.isInteger(1e20) === true`）与 `noj-llm-gateway` 的 `/internal/usage`
   `page`（无上界，且 `OFFSET` 是字符串插值）都会让 `OFFSET` 溢出 PG bigint →
   `bigint out of range` → 500。可达者为持 `community_moderation` 的账号与管理员
   （非匿名）。

4. **`check-test-discovery` 的启发式双向失准**：方法简写/class 方法里的
   `Deno.test` 被误判为"文件级"（会把合法测试工厂报红），而
   `(() => { Deno.test(...) })()` 这类**确实会执行**的测试被漏判
   （放过永不执行的测试）。

5. **搜索限流的认证维度语义有残留风险**（人工裁决项）：`auto` 下登录用户
   完全不进 IP 桶——这解决了校园机房 NAT 的误伤，但也让"注册多账号轮换"可以
   绕过 IP 维度，且认证用户的搜索洪水不在 IP 键上留痕（运维少一条线索）。

6. 次要：`command.ts` 的 stderr 排空把诊断输出并入 stdout 的同一回调
   （`logs --follow` 会混入 compose 告警，`--json` 多一路文本）；
   `pagination.test.ts` 的用例名说"抛 ValidationError"，断言却写 500，
   容易让读者以为"修复目标就是 500"。

## Decision

1. **白名单绑定请求作用域**：`updateProvider` 增加 `scope: "user" | "admin"`
   参数（默认 `"admin"`），路由按"请求是否带 `created_by`"传入
   （`routes/internal.ts`）。管理端可正常改 `enabled`/`cost_per_1k_tokens`，
   用户自助路径的拒绝语义不变。补两条回归测试：
   「管理端更新用户自建 Provider 的 enabled/cost 必须放行」与
   「用户路径仍不得改 enabled/cost」。
2. **把漏登记变成可发现的失败**：`GATE_SELF_TESTS` 补入本次提及的两个 +
   4 个存量漏网；`gate-list_test.ts` 新增自检
   「`scripts/*_test.ts` 必须全部登记」——以后漏登记会让 root-gates 直接红，
   而不是靠人记得。
3. **补两处分页上界**：admin community 的 `parsePage` 用 `MAX_SAFE_PAGE` 夹取
   （`per_page` 另夹到 ≤100）；gateway `/internal/usage` 的 `page` 加上界并把
   `LIMIT/OFFSET` 改为参数化（消除字符串插值面）。
4. **修正启发式并写反例**：`looksLikeFunctionBrace` 增加"方法简写/class 方法"
   识别（排除 `if/for/while/switch/catch` 等关键字），并新增
   `isImmediatelyInvoked` 识别 IIFE——IIFE 内的测试会在文件加载时执行，
   因此仍算"文件级"。三类反例（方法简写、class 方法、带返回注解的方法、
   IIFE、`.call`）全部写进 `check-test-discovery_test.ts`。
   已知局限：`function make() { Deno.test(…) } make();` 这种"先定义、后另行
   调用"的形态仍会被当工厂放过（需要作用域分析，超出本门禁成本预算）。
5. **搜索限流补粗粒度 IP 兜底**：新增设置
   `rate_limit_search_max_ip_total`（默认 600，窗口与搜索限流一致，0 = 关闭）。
   认证用户在用户桶之外还要通过该 IP 上限——量级远高于用户桶（120），
   正常 NAT 出口不会撞到，但账号轮换与洪水会在 IP 键上留痕并可见。
   补一条路由级回归测试。
6. **`CommandRunner.stream` 增加 `onStderr`**：缺省仍与 stdout 同等对待
   （保证排空的字节可见，这是挂死修复的安全默认），调用方可传回调分流或
   传 `false` 只排空；两个调用点显式给出路由。
7. **测试断言文案校正**：`pagination.test.ts` 的用例注释说明"harness 无
   onError → 500；生产为 400"，避免断言语义与修复目标相反。
8. **`check-deno-version` 跳过点开头的目录**（`.deno_cache` 等缓存目录会随
   依赖膨胀拖慢门禁）。

## Alternatives considered

- **把 BYOK 行也允许管理端改、靠 UI 隐藏按钮**：拒绝。UI 只是客户端，
  服务端必须按请求来源判定；且管理端列表本就不暴露归属，靠 UI 无法自洽。
- **给 `PUT /internal/providers/:id` 加显式 `scope=user|admin` 查询参数**：
  可行但会改动 core 与 gateway 两侧契约；`created_by` 已是既有请求参数，
  复用它不引入新契约面。
- **直接放弃 IP 兜底，只把残留风险写进 Agent Note**：部分采纳——风险确实可
  接受（用户桶仍生效），但"多人共用出口 + 账号轮换"是真实场景，粗粒度上限
  成本极低（一次 INCR），因此选择实现并同时记录权衡。
- **用 `Deno.statfs` 判断空间**：Deno 2.9 稳定 API 不存在（既有结论），
  继续用 `df -Pk`。

## Consequences

- 管理端恢复可编辑用户自建 Provider 的启用状态与单价；用户侧约束未放松
  （两条新测试锁定双向语义）。
- `scripts/*_test.ts` 的漏登记会直接让 root-gates 失败，不再有"写了却永不执行"
  的灰色地带。
- 两处分页 500 在解析层被拒（400 / 夹取），`/internal/usage` 的 SQL 不再有
  插值面。
- 门禁启发式同时减少误红（测试工厂）与漏判（IIFE）；反例已入测试。
- 认证用户搜索多一个 IP 维度兜底；管理员若不需要可把
  `rate_limit_search_max_ip_total` 设为 0 关闭。
- `logs --follow` 的 stderr 行不再与日志正文混在同一通道（可分流控制）。
- 已知残留：`command.ts` 的 `stream()` 仍是"逐行回调"接口，未提供结构化
  `{stream, line}` 标识；本 PR 只补齐路由能力。

## 关于静默跳过基线 +1

本次新增的 IP 兜底回归测试（`search.test.ts`）遵循该文件既有的
`ignore: skip`（`skip = !JWT_SECRET`）模式——整个文件 7 个路由级用例都如此，
因为路由级测试需要 JWT 与 Redis。在完整测试环境（`deno task test` / CI）中
`JWT_SECRET` 恒被设置，因此该用例**会真正执行**；`ignore` 只在缺环境的裸跑
下生效。总命中数因此 992 → 993，按门禁提示的口径
「若确实新增的跳过，请改为真正执行测试或说明原因」以
`silent-skip-report --update-baseline` 更新，并在此说明原因：
这 1 处是**新增的回归保护**（覆盖"认证用户仍受 IP 兜底约束"），
不是既有守卫的削弱。
