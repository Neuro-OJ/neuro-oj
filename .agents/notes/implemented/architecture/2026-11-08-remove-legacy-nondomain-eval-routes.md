# Agent Note: 删除无域评测兼容路由与跨域提交列表接口

Status: implemented

## Problem

`evaluations/routes/` 仍保留 0.11 域化改造前的无域兼容路由：
`POST /problems/:id/self-test`、`GET /problems/:id/self-tests`、
`GET /self-tests/:id`、`GET /queue`、`GET /queue/events`、
`GET /submissions/:id/events`。它们都隐式回落到默认域并绕过域访问校验口径，
第一方（noj-ui、noj-tests、noj-cli、noj-lmcc-extension）已全部改用
`/domains/:slug/...` 与 `/instance/queue`，属于死路由。
另外 `GET /me/submissions` 跨域分页列表没有任何前端入口
（`useOwnSubmissions().list()` 零调用方），与域内提交目录重叠。

## Decision

- 删除上述 6 条无域路由及其服务/应用层只服务它们的代码：
  `listMySelfTests`、`SelfTestSummary`、`SELF_TEST_LIST_*`、
  `submitSelfTestCommand`、`composeEvaluationAdmissionContext` /
  `ComposeEvaluationAdmissionInput`（仅被旧自测路由使用）。
- 只删除 `GET /me/submissions` 路由；服务层 `listOwnSubmissionHistory` 保留，
  域内客观题提交列表 `GET /domains/:slug/objective-submissions` 仍用它按
  “本人 + 本域”查询，口径不变。
- `getSelfTest` 不再允许无域上下文回落到默认域，只有使用域入口可读。
- `/me/submissions/:kind/:id` 详情与 `/me/submissions/submission/:id/artifact`
  产物下载保留。
- 前端管理台队列态势改用 `/api/v1/instance/queue`：数字口径从“默认域”变为
  “全实例”，对平台管理员更准确。

## Alternatives considered

- 保留路由并返回 410：仓库没有通用退役中间件，且调用方为零，直接删除更简单。
- 把 `/me/submissions` 列表保留为域内历史的别名：与
  `/domains/:slug/submissions` 重复，继续增加维护面。

## Consequences

- 旧客户端或外部脚本调用这些路径会得到 404；`noj-docs` 更新日志已登记。
- `noj-tests` 中相关 E2E 已改用域内/实例接口，不再覆盖删除路径。
- 表结构无变化，不需要迁移。
