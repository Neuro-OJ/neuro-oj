# Agent Note: 公开赛关联题目对非所有者/管理员 404 并在题目页提示保密

Status: implemented

## Problem

题库里的一道题（尤其 P 型主题库题，`visibility` 恒为 `public`）一旦被加入竞赛，
它在题库入口、搜索、直链、训练题单、外部客户端里**依然对所有人可见**：题面、
标签、通过率、starter code 全部可读，也能从独立入口提交（相当于绕开竞赛窗口做题）。
运营上需要的语义是："这道题已经归某场公开赛用了，赛前/赛中不能让外人看见"。

需求（用户拍板的口径）：

1. 题目被加入**公开赛**（`contests.kind='public'`，邀请赛除外）后，除**题目所有者**
   与**管理员**外，所有人访问该题目的页面与接口都按"不存在"处理（404）；
2. 所有者/管理员打开该题时看到横幅：`当前题目已经被关联到竞赛 <竞赛名>，仅管理员和
   题目所有者可见，请注意保密工作`（竞赛名带链接）；
3. 时间窗口：**赛前 + 赛中**隐藏，竞赛 `end_time` 一过自动恢复（赛后复盘、补题、题解
   继续可用）；
4. 列表不排除（题库/搜索仍保留条目，点进去 404）——用户明确选择；
5. 参赛者从独立路径（无竞赛上下文）同样 404；携带**有效竞赛上下文**时放行；
6. 独立提交/自测路径被拦下时返回 **403**（与读路径的 404 区分）；
7. 触发条件只看 `kind='public'`，不区分 `is_public`（链式/隐链公开赛同样保密）。

## Decision

**判定收口在既有纯函数 `resolveProblemAccess`**（`catalog/services/problem-access.ts`），
新增输入 `secrecy: { contestIds }`，判定顺序变为：

`admin → owner → 竞赛上下文（不回退 public）→ 公开赛保密 → visibility`

- 保密分支置于**竞赛上下文之后**：`contestAccess.allowed` 已由 contest 域证明"该用户是
  这场竞赛的参赛者 + 这道题属于这场竞赛 + 窗口 running/ended"，因此客观题套卷竞赛页
  （`GET /:id/questions?contest_id=`）与编辑器 starter code
  （`GET /:id/template?contest_id=`）零改动继续可用；独立入口不携带上下文，
  因此对参赛者也返回 404/403（"收藏直链"会失效，属本次规则的有意代价）。
- 取数口径由 contest 域新增 `loadPublicContestSecrecy(problemId)`
  （`contest_problems ⋈ contests`，`kind='public'` + `unendedWindowCondition(end_time)`）；
  时间比较复用 `contest-window.ts` 的 `::timestamptz` + 形态守卫写法（**不按文本字典序**），
  形态非法时 fail-closed（按未结束处理，继续保密）。`unendedWindowCondition` 与既有
  `runningWindowCondition` 同源同风格。
- **取数+判定统一入口**：新增 `catalog/services/problem-access-check.ts`
  （`evaluateProblemAccess` / `evaluateProblemAccessWithContestId`），8 个既有
  `resolveProblemAccess` 调用点全部改走它，避免"某个调用点忘记取保密事实"导致规则漏判
  （这是本次改动唯一的架构性新增；纯函数保持无 DB 依赖）。
- **覆盖面**：`GET /problems/:id`、`/stats/public`、`/template`、`/support-package`、
  `GET /problems/:id/questions`、`POST /problems/:id/submit`（客观题）、
  `POST /submissions`、artifact 提交、self-test。
- **提示字段**：`GET /problems/:id` 对 owner/admin 追加
  `contest_secrecy: [{ public_id, title }]`；判定顺序保证该字段的读者只有这两类人。
- **UI**：新增 `components/problem/ProblemContestNotice.vue`（inline、**不可关闭**、
  复用 `warning-*` token、竞赛名链到 `/contests/<public_id>`），落在题目详情页、
  题目编辑页、编辑器页（非竞赛模式）；详情页与编辑页补齐 404 渲染
  （此前 404 会退化成"题目加载失败"面板 / 空白编辑表单），编辑器页在竞赛模式下
  为 starter code 请求附带 `contest_id`。

## Alternatives considered

1. **新建独立判定函数 / 在每个路由各写一次**：会造成多处规则漂移，且调用点容易漏判；
   故只扩展既有单一判定点 + 一个取数封装。
2. **把保密做成题目/竞赛上的一列**（如 `contests.hide_problems` 或题目级开关）：
   需要迁移与状态翻转任务，还要处理"赛前/赛后"翻转时机；而时间窗口判定纯派生自
   `end_time`，无状态、无多副本共享状态，符合"禁止新增进程内可变状态"的约束。
3. **把竞赛关联的题目从题库列表/搜索中一并排除**：用户明确选择保留条目
   （改动面更小，且避免"题目凭空消失"的困惑）；代价是标题、描述摘要、通过率、
   标签仍可被未授权者看到，点进去才 404。已在该取舍下记录风险。
4. **只挡读路径、放行独立提交**：会让非参赛者仍能从 `/api/v1/submissions` 提交并拿到
   评测详情（含可见用例输出），等于绕开竞赛窗口，故拦（403）。
5. **support-package 路由复用完整的 resolver 判定**：会把"私有题包 403"改成 404，
   属于另一套基于角色的包权限控制；最终选择**只拦 `contest-secret`**，
   既有 403 口径不变。

## Consequences

- 已知取舍/影响：
  - 题库与搜索仍展示被保密题目的条目（点入 404），标题与统计信息不算"已保密"；
  - 被公开赛引用过的题目在竞赛结束前，**独立入口**对参赛者也不可用（须走竞赛入口）；
    收藏夹/外部链接会 404；
  - `POST /api/v1/submissions` 从不接受竞赛上下文（`body.contest_id` 被路由丢弃），
    因此竞赛提交必须走 `POST /api/v1/contests/:id/submit`：
    e2e `priority_queue` 用例据此调整（medium 提交移到建赛之前，high 改走竞赛入口，
    并补报名步骤）；
  - `noj-lmcc-extension` 只走题库入口，故竞赛关联题目在插件中"能搜到但不能提交"——
    已在 `noj-docs/docs/users/lmcc-extension.md` FAQ 与 `security.md` 记录；
    LMCC 若以公开赛承载考试，需改用邀请赛或扩展插件携带竞赛上下文。
- 无 schema 变更、无迁移、无新增进程内状态；每次判定固定多一次
  `contest_problems ⋈ contests` 索引 join（owner/admin 也不走捷径，换取"调用点无法漏判"）。
- 后续可选优化：`contest_problems(problem_id)` 目前无独立索引（既有 `problem-exposure`
  同样按该列查询），比赛规模变大时可加索引迁移。
