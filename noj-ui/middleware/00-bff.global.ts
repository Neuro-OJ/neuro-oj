/**
 * BFF 只属于具体页面的数据源，不再在全局导航阶段预取并写入共享快照。
 *
 * 页面入口自己拥有 `useAsyncData` 的 key、AbortSignal 和首屏 DTO；这样 SSR、
 * 水合与 SPA 导航都只会消费同一个页面数据键，导航离开时也不会把旧页面的
 * BFF 响应注入另一个异步数据键。身份守卫由 `auth` / `workspace-context` 负责。
 */
export default defineNuxtRouteMiddleware(() => undefined);
