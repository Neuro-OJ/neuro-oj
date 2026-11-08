# Agent Note: rc/v0.11 审计回归修复（权限、租约、预审与 E2E 门禁）

Status: implemented

## Problem

对 `rc/v0.11`（#717 固定角色收敛 + #718 教学界面验收之后）做代码级审计，发现一组由重构
收敛引入的回归，以及两处半成品：

1. **平台管理员通配能力丢失**：`checkPermission` 在 #717 中改为只按能力集合判断，
   `admin:full_access` 不再短路，平台管理员访问旧入口能力时被拒。
2. **旧社区入口按平台角色放行**：`/api/v1/community/*`（固定默认域）直接用平台角色判定
   `community:*`，与「域内有效角色才是社区权威」冲突：默认域外成员在旧入口仍可写。
3. **社区能力字符串未收窄**：`loadCommunityScope` / `withDomainCommunity` 的 `permission`
   参数是裸 `string`，拼错或跨域能力名无法在编译期发现。
4. **域可见性 SQL 双份实现**：`access/workspace/services/access.ts` 与 `policy.ts`
   各维护一份 `domainMemberWhere` / `domainReadableWhere`，修改一处会静默漂移。
5. **批任务条目租约无闸门**：心跳续租失败后派发仍继续，同一 `job_item` 可能被两个 worker
   同时处理（重复推送 judge 任务、重复执行升级事务）。
6. **`platformAdmin` 布尔口径混用**：管理端提交视图既能看结果又能看实时队列位置，
   审计要求区分「取证」与「赛中视图」两种语义。
7. **新用户预审是半成品**：`pending` 帖子只对审核员可见，作者发完即「凭空消失」；
   `/config` 也不下发预审状态，前端无法在提交前提示。
8. **E2E 门禁在 macOS 必失败**：`scripts/e2e/setup.sh:43` 的 `$NOJ_E2E_SESSION` 紧跟全角
   「）」，bash 3.2 把全角字符并入变量名，`set -u` 下报 `unbound variable`，
   `check-setup.sh` 第 8 节因此长期无法通过。

## Decision

逐项就地修复，不引入新抽象：

- `permissions.ts` 恢复 `ADMIN_FULL_ACCESS` 短路（`has("admin:full_access") || has(permission)`），
  并在 JSDoc 明确「通配只在本函数生效，域内能力必须走 `assertWorkspacePermission`」。
- 抽出 `CommunityCapability` 联合类型（`community:read|create|comment|report|moderate`），
  `loadCommunityScope`、`withDomainCommunity`、`withDefaultCommunity`、域路由 `write()` 全部改用它。
- 旧入口 `/api/v1/community/*` 中间件改用 `isModerator`（平台通配或默认域有效角色含
  `community:moderate`）与 `hasDefaultCommunityPermission`（`loadWorkspace` +
  `assertWorkspacePermission(workspace.context, permission)`）；`/config` 的
  `permissions` 与 `contestSilence` 同步改用请求级 `moderator` 标志。
- `access.ts` 的 `domainMemberWhere` / `domainReadableWhere` 改为转调 `policy.ts` 同名实现
  （别名导入），删除重复 SQL。
- 租约：`JobItemLeaseHeartbeat` 增加 `assertHeld()`，记录 `inflight` 续租结果并允许「失败后
  补一次续租成功」；`dispatch-job-item.ts` 引入 `LeaseGate`，在 `pushJudgeTask` 前与
  `dispatchObjectiveUpgrade` 事务前断言，失败抛
  `AppError("批任务条目租约已丢失，中止本次派发", 409, "JOB_LEASE_LOST")`；
  worker 把该错误计为 `deferred`，交给 sweeper 重新入队，而不是标记失败。
- `platformAdmin` 由 `boolean` 改为 `"live_status" | "forensics"`：管理端提交路由传
  `"forensics"`（可看结果详情），管理端比赛路由传 `"live_status"`（可看队列位置），
  结果筛选只在非 `forensics` 时生效。
- 预审补齐三处：`listPosts` 非审核员分支放行「作者本人非删除内容」（与 `listComments`
  同一口径）；`/config` 增加 `under_review`；UI 编辑器在 `under_review` 时提示
  「新账号内容需经审核后公开」。
- `setup.sh` 改用 `"${NOJ_E2E_SESSION}"` 显式定界；`check-setup.sh` 第 8 节增加
  `grep -Fq 'unbound variable'` 回归守卫（缺少会话上下文时必须报可读错误，而不是崩溃）。

## Alternatives considered

- **给旧入口单独建一套域权限中间件**：与域路由的 `withDomainCommunity` 重复；改为复用
  `loadWorkspace` + `assertWorkspacePermission`，保持单一权限真相源。
- **租约只靠心跳线程标记失败**：心跳与派发之间没有原子性，仍可能在「判定失败 → 停止派发」
  窗口内写入；改为写前同步断言（允许一次补救续租）。
- **预审期直接让作者看到 `pending` 帖但列表不计数**：保留现状（`countPostsByType` 仍只统计
  `published`），因为计数是公开聚合值，把待审内容算进去会向他人泄漏存在性。
- **`platformAdmin` 拆成两个布尔**：两个布尔可组合出非法状态，联合字面量更窄。

## Consequences

- 回归测试：新增 `noj-core/.../tests/routes/default-community-permissions.test.ts`（成员/非成员/
  普通成员删除他人帖/平台管理员四类），`community.test.ts` 增加预审可见性与 `under_review` 用例。
- 已验证：`deno task check`（core）、`test:domain communication` 89 passed、
  `test:domain access` 403 passed、`test:domain evaluations` 472 passed、
  `noj-ui` `deno task check` / `deno task test` 345 passed / `test:components` 421 passed、
  `bash scripts/e2e/check-setup.sh` exit 0。
- 已知取舍：待审内容不计入 Tab 计数（见上）；`under_review` 只由账号年龄决定，
  新注册的管理员同样会提示，但不影响其审核权限。
- 旧入口的域内授权现在依赖默认域的成员身份；平台管理员仍凭 `admin:full_access` 通配放行。
