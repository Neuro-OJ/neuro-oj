## Context

noj-ui 现有约 50 个文件、140 处直接 `$fetch` 调用，错误处理有 5 种模式并存：

| 模式 | 场景 | 问题 |
|------|------|------|
| catch + `toast.error(err.message)` | admin 表单提交 | 文案提取逻辑重复，部分只显示 `err.message`（丢失后端 `error` 字段） |
| catch + 表单内联 error ref/banner | 认证 5 页、admin 列表 | 是刻意设计，保留 |
| catch 静默 | 轮询、后台刷新 | 有意静默，保留 |
| 无 catch 裸抛 | admin/community load、contests 参与者 | unhandled rejection，用户无感知 |
| allSettled / 错误对象分支 | useSearch、admin/index、editor 404、USER_BANNED | 依赖 `$fetch` 抛错对象的结构 |

后端（noj-core）错误响应格式统一为 `{ error: "<具体原因>", code: "<机器码>", request_id, ...meta }`，Nitro 代理（`server/api/[...slug].ts`）原样透传 status + body。因此「具体错误原因」在前端始终可提取，只是各调用点提取方式不一致。

项目约束：弹窗/通知统一使用 Nuxt UI（`useToast`/`useDialog`），SweetAlert2 已移除且不重新引入；`$fetch` 抛错对象结构（`e.data`/`e.status`）被现有分支代码依赖，不能破坏。

## Goals / Non-Goals

**Goals:**
- 统一 API 调用入口，杜绝直接 `$fetch` 散落各处
- 非 2xx 自动提取后端 `error` 字段并通过 `useToast().toast.error()` 弹窗，保证具体原因不丢失、提示方式一致
- 保留轮询/后台/表单内联场景的静默能力（`silent: true`）
- 迁移全部现有调用点，删除重复的 catch + toast 逻辑
- 兼容现有依赖抛错对象结构的代码（重抛原错误）

**Non-Goals:**
- 不改变后端 API 契约（错误响应格式保持 `{ error, code, request_id }`）
- 不引入新依赖（不重新引入 SweetAlert2）
- 不统一认证 5 页的内联 banner 为 toast（表单内联错误是刻意设计）
- 不做全局 `$fetch` 拦截（避免影响 Nitro 代理与 `useAsyncData` 的隐式行为）
- 不处理 Vue 组件内非 API 的错误（本地校验等）

## Decisions

### D1: 以 composable（`useApi`）而非全局 $fetch 拦截器实现

**选择**：`composables/useApi.ts` 导出 `useApi()`，返回 `api.get/post/put/patch/delete` 方法。
**理由**：
- Nuxt `$fetch` 全局拦截（`$fetch.create`/plugin）会影响 SSR 与 Nitro 服务端代理路径，风险高；
- composable 内可安全使用 `useToast()`（Nuxt 自动注入），并可用 `import.meta.client` 守卫 SSR 端不弹窗；
- 与项目现有 `useAuth`/`useMessages` 等 composable 封装模式一致（CLAUDE.md「API 调用封装在 composables/ 中」）。
**替代**：`$fetch.create()` 单例 + 拦截器——被否：无法优雅使用 Nuxt UI composable，且拦截器内重抛/静默的选项传递笨拙。

### D2: 错误提示后重抛原错误对象

**选择**：API 层 catch 到错误 → 提取文案 → toast → **`throw err`（原样重抛）**。
**理由**：现有代码依赖 `$fetch` 抛错对象结构——`login.vue` 检查 `e.data?.code === "USER_BANNED"`、`editor/[id].vue` 检查 `err.statusCode !== 404`、`useSearch` 的 `allSettled` rejected 分支。重抛原对象使这些分支零改动继续工作；调用方仍可用 `try/catch` 做差异化处理，且 `silent` 选项只是跳过 toast 不改变抛错。
**替代**：包装为自定义 ApiError——被否：会破坏所有现有 `e.data` 访问，迁移成本与回归风险大增。

### D3: 错误文案提取为纯函数（`utils/apiError.ts`）

**选择**：`extractApiError(err): { message, code, status, requestId }` 纯函数，无 Nuxt/`import.meta` 依赖。
**理由**：可独立单元测试（deno test）；提取逻辑唯一化；兜底文案集中管理：
- 后端响应（`err.data.error` 为字符串）→ 直接使用（后端消息本身就是具体原因）
- 有 status 但无 error 字段 → `请求失败（HTTP <status>）`（避免只显示状态码，但给出结构化兜底）
- `AbortError`/超时 → `请求超时，请稍后重试`
- 网络层错误（`TypeError: fetch failed` / `Failed to fetch`）→ `网络连接失败，请检查网络`
- 未知 → `操作失败，请稍后重试`

### D4: 选项设计 `{ silent?, onError?, timeout? }`

- `silent: true`：不弹 toast（轮询、后台刷新、表单内联、auth 内层调用）；错误仍抛出
- `onError(err, info)`：自定义处理（如 admin 页面写 error ref），提供后**替换**默认 toast（不重复弹）
- `timeout`（ms）：内部 `AbortSignal.timeout()` 实现，替换 `useAuth` 手写 `Promise.race` 5s 超时；超时错误文案按 D3 兜底
- 三者可组合；`onError` 与 `silent` 同时给出时 `silent` 优先（不弹窗，onError 仍执行）

### D5: 迁移策略（按调用模式分组，避免行为回归）

1. **composables 优先**（useAuth/useMessages/useRankings/useSearch/useAdminList/useAuditLogs/useBanStatus/useCommunity/useContests/useSubmissionPolling/useCommunityNotifications）：下层统一后，页面迁移面自然缩小；
2. **认证 5 页**：`silent: true` + 保留内联 banner（`USER_BANNED` 分支不变）——API 层只负责网络错误兜底，表单错误仍由页面展示；
3. **admin 表单提交**：删 catch 中 `toast.error`，依赖 API 层自动弹窗（文案从 `err.message` 升级为后端 `error` 字段）；error ref 内联场景改 `onError`/`silent`；
4. **轮询/后台**：`silent: true`，语义不变；
5. **裸抛场景**（admin/community load、contests 参与者、ChatSidebar）：换 `api` 后自动获得 toast，消灭 unhandled rejection（这是行为改进）；
6. **allSettled / useAsyncData 包裹**：`silent: true`（错误由既有状态接管），不破坏分支逻辑。

### D6: 认证内层调用默认不弹窗（login/register 等由页面统一展示）

`useAuth.login/register/forgotPassword/resetPassword/changePassword` 使用 `silent: true`（或 `onError` 透传），错误由认证页面内联 banner 展示——避免「页面 banner + toast 双重提示」。`fetchUser`/`logout` 保持静默 + 自动登出语义。

## Risks / Trade-offs

- [**双弹窗风险**] 页面 catch 中已有 `toast.error` 的调用点迁移遗漏时，会出现 toast 重复 → 迁移清单覆盖全部 140 处调用点；迁移后 grep `toast.error` 与 `$fetch` 复查，确保 `$fetch` 仅存在于 `useApi.ts` 与 Nitro 代理
- [**行为改变**] 裸抛场景从「无提示」变为「弹窗」，可能暴露后端内部错误文案 → 后端 onError 已统一 `{ error }` 文案且 production 隐藏内部细节（`服务器内部错误`），风险可控
- [**SSR 端弹窗**] `useToast` 依赖客户端 UToaster → `useApi` 内 `import.meta.client` 守卫，SSR 端只抛错不弹窗
- [**超时语义变化**] `AbortSignal.timeout` 与手写 `Promise.race` 行为略异（AbortError 而非 Error('timeout')）→ `extractApiError` 对 AbortError 兜底「请求超时」，文案一致
- [**回滚**] 变更可逐步回滚：`useApi` 保留向后兼容签名，单文件 revert 不影响整体；`$fetch` 直接调用始终可用

## Migration Plan

1. Phase 1：新建 `utils/apiError.ts` + `composables/useApi.ts` + 单元测试（lint/fmt/test 绿）
2. Phase 2：迁移 composables（10+ 文件），lint/build 绿
3. Phase 3：迁移 pages/components（约 40 文件，按 D5 分组），lint/fmt/build 绿
4. Phase 4：dev 手动验证 + CLAUDE.md 文档 + noj-tests E2E 回归
