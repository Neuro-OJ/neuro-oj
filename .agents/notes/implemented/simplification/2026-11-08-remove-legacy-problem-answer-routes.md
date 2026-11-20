# Agent Note: 删除无域题目界面与统计接口

Status: implemented

## Problem

做题页、竞赛编辑器都已改用域内接口，但无域的 `GET /api/v1/problems/:id/ui`、
`/:id/stats`、`/:id/stats/public` 以及模板接口的 `?contest_id=` 分支仍在。
前端唯一的统计调用方 `useProblemStats` 已无人使用；题目页统计改由域内题目查询的
`statistics` 字段提供（`read-models/queries/services/domain-query.ts`），
`problems-stats.ts` 因此成了第二套统计实现。

## Decision

- 删除 `problem-ui.ts` 路由、两个统计路由和 `problems-stats.ts` 服务及其测试。
- 模板接口不再接受 `?contest_id=`，竞赛模板统一走
  `/api/v1/domains/:slug/contests/:id/problems/:label/template`；随之删除只为它
  存在的 `evaluateProblemAccessWithContestId`，相关访问判定测试改为直接组合
  `verifyContestAccess` 与 `evaluateProblemAccess`。
- 管理页与 E2E 仍在使用的 `/:id`、`/:id/draft*`、`/:id/versions*`、
  `/:id/support-package`、`/:id/template` 保留。

## Alternatives considered

- 一并删除 `/:id` 等管理页接口：需要先把三个管理页迁到域内接口，留待后续。

## Consequences

- 外部调用被删接口会得到 404。
- 统计口径只剩域内一套实现。
