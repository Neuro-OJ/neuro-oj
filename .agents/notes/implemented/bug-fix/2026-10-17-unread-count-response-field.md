# Agent Note: 修复导航栏未读消息角标恒为 0

Status: implemented

## Problem

`noj-ui/components/layout/UserMenu.vue` 的未读消息轮询按 `res.data.unread_count`
读取 `/api/v1/conversations/unread-count`。该接口在
`noj-core/src/domains/messaging/routes/conversations.ts` 直接返回顶层
`{ unread_count }`，Nitro 代理透明透传、`useApi` 也不做 `{ data }` 解包，因此
`res.data` 恒为 `undefined`，角标永远落到 `?? 0` 的兜底值——用户即使有未读私信，
导航栏红点也不显示（#657）。

同仓库 `noj-ui/composables/useMessages.ts` 的 `fetchUnreadCount()` 读的是
`res.unread_count`，是正确写法；本次缺陷只出现在组件内的重复实现上。

## Decision

把 `UserMenu.vue` 的泛型改为 `{ unread_count: number }`，取值改为
`res?.unread_count ?? 0`，与 `useMessages` 保持一致，保留原有「失败静默、异常不打扰
用户」的行为。

同时全仓库排查了 `unread_count` 的读法：

- `useMessages.fetchUnreadCount()` / `fetchUnreadCountByConversation()`：已是顶层读取，正确。
- `useCommunityNotifications.loadUnreadCount()`：读 `result.data.unread_count`，
  对应后端 `/api/v1/community/notifications/unread-count` 返回的
  `{ data: { unread_count } }`，正确，未改动。
- `ChatSidebar.vue` 用的是会话列表项自带的 `conv.unread_count`，与本次无关。
- `noj-tests/e2e/*` 对两个接口分别按 `data.unread_count` 与 `unread_count` 断言，与后端一致。

补充 `tests/components/UserMenu.spec.ts`：挂载组件、mock `useApi` 返回顶层
`{ unread_count: 3 }`，断言角标渲染为 `3`，并覆盖 `0` 时不渲染角标。该测试在还原
缺陷写法后会失败，可防止回归。

## Alternatives considered

- **只改组件、不加测试**：缺陷本质是「响应结构与读法不一致」，纯类型层面无法拦截
  （`res.data` 对 `{ data: ... }` 泛型是合法的），必须有断言响应形状的测试。
- **把未读数逻辑抽到 `utils/` 纯函数再单测**：能测到解析，但测不到组件是否真的用对
  结果；组件测试基础设施（vitest + @vue/test-utils）已存在，直接挂载更贴近真实路径。
- **在 `UserMenu` 里复用 `useMessages().fetchUnreadCount()`**：会额外创建一整套消息
  状态（会话列表、轮询等），为读一个计数引入无关依赖，且 30s 轮询逻辑仍需保留，收益不足。

## Consequences

- 修复后角标按真实未读数显示（`> 99` 仍显示 `99+`），无 API、数据库或配置变更。
- `UserMenu.vue` 显式 `import { nextTick, onMounted, onUnmounted, ref, watch } from "vue"`，
  使组件可在 vitest 中脱离 Nuxt 自动导入独立挂载；行为不变。
- 未读数响应若未来改为 `{ data: ... }`，本测试会立即失败，需要同步调整读法。
- 未覆盖：真实浏览器中 30s 轮询与登出清零的端到端行为（本机未启动后端，仅做了组件级验证）。
