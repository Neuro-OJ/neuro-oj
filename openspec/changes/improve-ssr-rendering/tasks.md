## 1. 基础与止血

- [x] 1.1 修改 `useApi`：服务端使用 `useRequestFetch` 统一转发 Cookie/请求头，替换手动 `useRequestHeaders(['cookie'])`
- [x] 1.2 将 `useAdminList`、`useAuditLogs`、`useSearch`、`useBanStatus`、轮询类 composable 中的 `useApi()` 调用移到 composable 同步 setup 顶部
- [x] 1.3 修改 `useCommunity.loadConfig`：`api.get` 失败时 catch 并返回安全默认配置，不向上抛错
- [x] 1.4 修改 `community/index.vue` 与 `community/posts/[postId].vue` 的初始化流程：配置失败不得导致 SSR 502
- [x] 1.5 迁移 `pages/problems/[id].vue` 中两处直接 `$fetch` 到 `useApi`/`useAsyncData`

## 2. 社区 SSR 改造

- [ ] 2.1 `community/index.vue` 改用 `useAsyncData` 获取配置、帖子列表与计数，移除顶层 `await init()`
- [ ] 2.2 `community/posts/[postId].vue` 改用 `useAsyncData` 获取帖子、评论与配置，移除顶层 `await load()`
- [ ] 2.3 `community/bookmarks.vue` 设置 `ssr: false` 并移除顶层 `await loadBookmarks()`
- [ ] 2.4 `community/notifications.vue` 设置 `ssr: false` 并移除顶层 `await load()`
- [ ] 2.5 `community/reports/[id].vue` 设置 `ssr: false` 并移除顶层 `await load()`
- [ ] 2.6 移除 NOJ-317 客户端强制刷新社区 config 的 workaround（若服务端权限已完整）

## 3. ssr:false 边界调整

- [ ] 3.1 `messages/index.vue` 设置 `ssr: false`
- [ ] 3.2 `my/problems.vue` 设置 `ssr: false`
- [ ] 3.3 `settings.vue` 设置 `ssr: false`（或改为显式 auth guard）
- [ ] 3.4 `queue.vue` 设置 `ssr: false`
- [ ] 3.5 `contests/[contestId]/ranking.vue` 设置 `ssr: false`
- [ ] 3.6 `contests/[contestId]/index.vue` 移除 `server: false`，恢复竞赛公开信息 SSR；确认题目/排行等子模块仍按需客户端加载

## 4. SSR 认证增强

- [ ] 4.1 `useAuth` SSR 阶段检测到 `noj:session` 时调用 `/api/v1/auth/me` 获取完整用户信息（含 `permissions`），写入 `useState`
- [ ] 4.2 调整 `middleware/auth.ts` 与 `middleware/admin.ts`：服务端基于完整 `auth:user` 做重定向，不再无条件 `if (import.meta.server) return`
- [ ] 4.3 处理 SSR 认证失败场景：token 失效按未登录处理，不渲染受保护内容
- [ ] 4.4 验证社区权限在 SSR 后完整，删除依赖客户端二次刷新的降级路径

## 5. SEO

- [ ] 5.1 为动态内容页添加 `useSeoMeta`/`useHead`：题目详情、用户主页、社区帖子、提交详情、公告详情、竞赛详情
- [ ] 5.2 新增 `server/routes/sitemap.xml.ts`，从 noj-core 拉取公开资源并输出 XML（短 TTL 缓存）
- [ ] 5.3 新增 `public/robots.txt`，允许公开路径、禁止 admin/editor/settings/私信等
- [ ] 5.4 完善 `app.vue`/`nuxt.config.ts` 全局默认 OG 与描述

## 6. 缓存

- [ ] 6.1 在 `nuxt.config.ts` 为公开接口增加 `routeRules` 缓存：problems、rankings、contests、trainings、announcements、tags、stats
- [ ] 6.2 为认证/个性化接口（auth、submissions、queue、社区权限相关）设置 `no-store` 或排除缓存
- [ ] 6.3 验证 `deno-server` 预设下 `routeRules` 行为；若不支持则在 Nitro 代理层对公开 GET 设置 `Cache-Control: s-maxage`
- [ ] 6.4 按需调整 `deploy/nginx/default.conf` 的缓存头（保留 SSE `proxy_cache off`）

## 7. 错误处理

- [ ] 7.1 新增自定义 `error.vue`，覆盖 404/500/网络错误
- [ ] 7.2 为 SSR 非关键数据增加降级：首页公告、社区配置、题目页题解入口等失败时显示空态/占位
- [ ] 7.3 验证 community 配置失败时页面不再返回 502

## 8. 验证与文档

- [ ] 8.1 运行 `deno task check`
- [ ] 8.2 运行 `deno task build`
- [ ] 8.3 启动构建产物并 curl 验证关键页面：`/`、`/problems`、`/community`、`/messages`、`/trainings/mine`
- [ ] 8.4 运行 noj-tests 中相关 E2E（社区、认证、SSE 降级）
- [ ] 8.5 更新 `noj-ui/CLAUDE.md` 的 SSR 数据获取约定与 `ssr:false` 边界说明
- [ ] 8.6 如实现完成，执行 `/opsx:apply` 后归档本次变更
