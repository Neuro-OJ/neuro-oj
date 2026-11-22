# 数据获取、SSR 与路由守卫

`ssr: false` 与 `useApi` 的硬规则见 [AGENTS.md](../AGENTS.md)
§1；本文是做法与边界。

## 数据获取策略

| 场景               | 方法                        | 说明                                                         |
| ------------------ | --------------------------- | ------------------------------------------------------------ |
| 页面初始数据       | `useAsyncData` / `useFetch` | SSR 时在服务端取，结果序列化进 payload，水合复用             |
| 交互 / 轮询 / 表单 | `useApi`                    | 统一错误处理；禁止在 setup 顶层 `await api.get` 写普通 `ref` |
| 轮询               | `useSubmissionPolling`      | `setInterval`，状态终态自动停止                              |
| 表单提交           | `useApi`                    | 直接展示后端返回的错误信息                                   |

## SSR 约定

- 页面初始数据 MUST 用页面自己的 `useAsyncData` / `useFetch`，不得在
  `<script setup>` 顶层 `await api.get(...)` 写普通
  `ref`；不得依赖全局中间件提供共享 BFF 快照（见 [bff.md](bff.md)）。
- `useApi` 服务端通过 `useRequestFetch` 转发 Cookie / 请求头；`useApi()` MUST
  在同步 setup 上下文调用，异步回调里不得再调。
- 非关键数据（社区配置、首页公告等）SSR 失败 MUST 降级为空态 /
  默认值，不得导致整页 502。
- 内容页与 SEO 页保持 SSR；错误态返回对应 HTTP 状态。

## `ssr: false` 边界

开关只写 `nuxt.config.ts` 的 `routeRules`，**不写
`definePageMeta`**；客户端页面清单的唯一真相 是 `utils/ssr-routes.ts` 的
`CLIENT_ONLY_ROUTES`（改清单改这里，别在页面里散着写）。当前覆盖：

- 实例管理与所有 `/admin/**`（依赖客户端状态，SSR 无意义且可能暴露敏感数据）。
- 题目编辑器 `/problems/*/edit`、`/problems/new/*`、`/my/problems`。
- 域内作答与比赛 `/d/*/solve/*`、`/d/*/contests/*/solve/*`。
- 设置与队列 `/settings`、`/d/*/queue`、`/d/*/settings/*`。
- 社区通知与举报
  `/messages`、`/community/notifications*`、`/community/reports/*`（含域内同名路径）。
- 本人提交目录 `/submissions`。

## 路由守卫

| 中间件                 | 路径           | 行为                                                            |
| ---------------------- | -------------- | --------------------------------------------------------------- |
| `auth`                 | 所有需登录页面 | 无 `noj:session` → `/login`；需要校验时 `fetchUser()`，5 s 超时 |
| `admin`                | `/admin/*`     | 非管理员 → `/`（静默重定向）；未登录 → `/login`                 |
| `community-moderation` | 社区管理页     | 管理员或持 `community_moderation:review` 的审核员               |

- 两个守卫 SSR 阶段同样执行（服务端基于 `/auth/me`
  的完整用户状态判断），客户端水合后再校验一次。
- `admin` 读 `noj:session` 的 `is_admin`（由 `role === "admin"` 计算，登录与
  `/auth/me` 下发）， 非管理员静默重定向、不报错。
- 强制改密：`user.must_change_password === true` 时强制跳
  `/change-password`，白名单 `/change-password`、`/login`、`/logout` 放行。

## useApi 统一调用层

业务代码**禁止直接 `$fetch`**（Nitro 代理与 `composables/useApi.ts` 内部除外）：

```ts
const { api } = useApi();
await api.get<T>(url, options?); // 原 $fetch<T>(url)
await api.post<T>(url, body?, options?); // 原 $fetch<T>(url, { method: 'POST', body })
await api.put<T>(url, body?, options?);
await api.patch<T>(url, body?, options?);
await api.delete<T>(url, options?);
```

- 默认错误处理：非 2xx / 网络 / 超时自动提取后端 `error` 字段，经
  `useToast().toast.error()` 弹窗（5 s
  自动消失），随后**原样重抛**原错误对象（保留 `data` / `status`，`e.data?.code`
  之类的分支照常可用）。
- 选项：`silent: true` 不弹 toast（轮询、后台刷新、列表 error
  ref、表单内联错误），错误仍抛； `onError(err, info)` 替换默认 toast，与
  `silent` 同时给时 `silent` 优先；`timeout`（ms）透传 ofetch（内部
  `AbortSignal.timeout`），替代手写
  `Promise.race`；其余选项（`params`、`headers`、 `query` 等）原样透传
  `$fetch`。
- 错误文案：要写进页面 error ref 时用 `extractApiError(e).message`
  （`import { extractApiError } from '~/utils/apiError'`），禁止手写
  `e.data?.error || e.status`。
- SSR 端不弹 toast（UToaster 只在客户端），仅抛错。
- 后端错误响应固定为
  `{ error: "<具体原因>", code: "<机器码>", request_id }`（noj-core `AppError`
  体系）。
