# Composables 参考

所有 `use*` 都在 `composables/`，camelCase 命名；API
调用只在这里封装（业务侧统一 `useApi()`，见 [data.md](data.md)）。文件名靠 `ls`
就能列全，本文只记语义与易踩点。

| composable                                           | 要点                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `useAuth`                                            | `useState<AuthUser \| null>('auth:user')`，含 `must_change_password`                              |
| `useToast` / `useDialog`                             | Nuxt UI `useToast` / `useOverlay` 封装，SSR 安全                                                  |
| `useApi`                                             | 统一 fetch 层，签名与选项见 [data.md](data.md)                                                    |
| `useProblemFilters`                                  | URL 驱动筛选（`useRoute().query` 同步），条件变化重置页码，带防抖                                 |
| `useSubmissionPolling`                               | 轮询 pending 至终态自动停止；分数 `score / 100`；`finished→green`、`error→red`，不再用 AC/WA 文案 |
| `useSearch`                                          | 全局搜索 + 300 ms 防抖，命令面板与结果页共享同一 `useState`                                       |
| `useKnowledge`                                       | 知识图谱挂载与审核；404 `KNOWLEDGE_DISABLED` 时整块隐藏                                           |
| `useWorkspace`                                       | 域上下文（`layouts/workspace.vue` 唯一 `provideWorkspaceContext()`）                              |
| `useDomain*`                                         | 域内题库、比赛、提交、自测、资源、训练、LLM 等                                                    |
| `useEducation*` / `useCommunity*`                    | 教学（班级 / 作业 / 矩阵）与社区                                                                  |
| `useAdminList` / `useInstanceAdmin` / `useAuditLogs` | 管理列表、实例治理、审计日志                                                                      |

## useAuth

- `fetchUser()` 调 `/api/v1/auth/me`，401 时自动 `logout()` 清状态。
- `login(login, password, code?)` / `register(data)` / `logout()`：`code` 为 TFA
  验证码或恢复码。
- `changePassword(oldPassword, newPassword)`：成功后清 Cookie 并跳
  `/login?reason=password_changed` —— 避免旧 JWT
  的改密标记残留，把路由守卫卡成死循环。
- `logout()` 清 `auth:user` + 调 `/api/auth/logout` 删 Cookie。
- 初始化时 Cookie 存在就自动 `fetchUser()`；SSR 阶段由 `/auth/me`
  取得完整用户与权限 （服务端守卫据此重定向）。

## useToast / useDialog

- `showToast(type, title)`：`success` / `error` / `info` / `warning`，3 s
  自动消失，无确认按钮。
- `showConfirm(title, text, danger?)` 返回 `Promise<boolean>`；`danger: true`
  显示红色确认按钮 （删除类操作）。两者都有 `process.client` 守卫，SSR 不执行。

## useProblemFilters

URL 即状态：筛选条件写进 `useRoute().query` 并回灌，条件变化自动回第 1
页；输入类条件防抖， 避免每个按键都发请求。

## useSubmissionPolling

`setInterval` 轮询 pending 提交直至终态并自动停止。分值为 `score / 100`（库里存
×100）； 状态与颜色映射 `finished → green`（已评测 + 分数）、`error → red`
等，界面不再出现 AC/WA 文案。

## useSearch

共享 state 为
`{ open, query, type, groups, flatItems, loading, error }`；`open()` / `close()`
控制命令面板显隐，"全部"模式请求 8 类资源（题目 / 用户 / 帖子 / 评论 / 比赛 /
提交 / 消息 / 公告）并按 `groups` 分组，按类型的结果页读
`flatItems`。`Navbar.vue` 唤起面板， `SearchPalette` 与 `pages/d/[slug]/search.vue`
共写共读。

并发与生命周期（改这段前先读完）：

- 请求序号 `requestSeq` 每次 `search()` 单调递增，过期回调跳过写入，避免
  `abc → ab` 时旧响应 污染新结果。
- `clearTimeout` 必须在短查询（`< 2` 字符）早退**之前**执行，否则 `ab → a`
  会让旧请求继续等。
- 旧 Promise 用 `pendingResolve` 同步 resolve，避免 `await` 挂起泄漏。
- `onScopeDispose` 清理挂起的 debounce 与 Promise，防止组件卸载后写共享 state。
- 同步写入 `query` / `type`，让分页等下游消费者读到最新值；失败显式置
  `state.error`，不静默兜底。
