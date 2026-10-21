# Agent Note: P7 批量摘要、页面 BFF 与 IDE 域路由

Status: implemented

## Problem

题单页面需要为每个题目逐项请求 Core，且全局 Nuxt middleware 会在导航阶段预取
并写入共享快照，造成首屏 SSR、水合和 SPA 导航重复取数，也可能把上一个页面的
BFF 响应注入新的异步数据键。IDE 提交仍有旧的全局题目/提交入口，未把域和不可变
题目版本作为提交合同的一部分。

## Decision

- 在 Core 增加 `POST /api/v1/domains/:slug/problem-summaries`，一次接收 1–50
  个题目引用，在同一集合查询中完成域授权、不可变版本和用户进度摘要；不可见
  题目统一返回 `unavailable`，不泄漏存在性。
- 页面拥有自己的 `useAsyncData` key、首屏 DTO 和刷新生命周期；全局
  `00-bff.global.ts` 只保留兼容空 middleware。资源刷新使用可取消、带 generation
  的 `useResourceRefresh`，避免晚到响应写入新页面状态。
- IDE 的题目详情、模板、版本和提交均通过显式 domain 路径；提交 DTO 必须携带
  `problem_ref`、`version_id` 和域 slug，避免提交时重新解析漂移版本。

## Alternatives considered

- 保留全局 BFF 快照并增加更多缓存键：拒绝，因为缓存键数量不能消除页面所有权
  不清晰和 SSR/水合重复取数的问题，也容易把用户相关进度跨页面复用。
- 让 IDE 继续发送旧全局提交 DTO，由 Core 兼容推断域/版本：拒绝，因为这会保留
  旧路由适配层，无法形成可审计的域内不可变版本提交合同。

## Consequences

- 题目数量只扩大一次批量参数，不再线性增加逐题 Core 请求；页面数据刷新边界
  与身份/工作区守卫分离。
- UI 单元测试 `304 passed / 0 failed / 0 ignored`，IDE `npm test` 14 项通过且
  `npm run check` 通过；Core 批量摘要已纳入类型和应用测试。本轮没有真实浏览器
  验收，因此不宣称 SSR、水合和 SPA 的浏览器行为已现场确认。
