# Agent Note: 删除实例级提交与题单页面

Status: implemented

## Problem

0.11 起提交、竞赛、题单都归属使用域（`/d/:slug/...`）。实例级
`pages/submissions/` （1255 行）与 `pages/trainings/`（288
行）仍保留完整实现，但全局中间件 `default-workspace.global.ts` 早已在页面 setup
前把 `/submissions/**`、`/trainings/**` 301 到 `main`
域，这些页面实际不可达，只是在维护两套实现（#698 N3）。

## Decision

- 删除两组实例级页面，以及只被它们使用的 `TrainingCard`、`TrainingFormModal`、
  `TrainingProblemList`、`TrainingProblemManager`、`SubmissionOutputPanel`
  组件与测试。
- 参照已处理的 `pages/contests/[...slug].vue`，各保留一个 `[...slug].vue`
  兜底路由， 保证旧链接有路由可匹配，由全局中间件完成跳转。
- Core 的实例级只读接口保持不变：`trainingRef` 解析仍依赖
  `GET /api/v1/trainings/:id`， CLI 与 IDE 也可能调用
  `GET /api/v1/submissions`。

## Alternatives considered

- 保留为“跨域视图”：中间件已强制跳转，保留页面没有任何用户可见收益。

## Consequences

- 旧书签与外链继续 301 到 `main` 域对应页面；浏览器 E2E 的 `/trainings`
  跳转用例覆盖。
