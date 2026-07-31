## 1. API 层基础设施

- [ ] 1.1 新建 `noj-ui/utils/apiError.ts`：`extractApiError(err)` 纯函数，从任意异常提取 `{ message, code, status, requestId }`，覆盖后端错误响应（`data.error` 字符串）、无 error 字段兜底（`请求失败（HTTP <status>）`）、AbortError/超时（`请求超时，请稍后重试`）、网络错误（`网络连接失败，请检查网络`）、未知错误兜底（`操作失败，请稍后重试`）
- [ ] 1.2 新建 `noj-ui/composables/useApi.ts`：`useApi()` 返回 `api.get/post/put/patch/delete`；内部封装 `$fetch`，非 2xx/网络/超时错误自动 `useToast().toast.error()` 后原样重抛原错误；支持 `{ silent, onError, timeout }` 选项（`silent` 优先于 `onError`，`timeout` 用 `AbortSignal.timeout`）；`import.meta.client` 守卫 SSR 端不弹窗
- [ ] 1.3 为 `utils/apiError.ts` 编写单元测试（`tests/apiError_test.ts` 或 utils 旁置测试文件）：覆盖后端错误、无 error 字段、网络错误、AbortError 四类；`deno.json` 增加 `test` 任务
- [ ] 1.4 验证：`deno task lint` + `deno task fmt` + `deno task test` 全部通过

## 2. 迁移 composables

- [ ] 2.1 迁移 `useAuth.ts`：5 个认证方法换 `api` 调用 + `silent: true`（页面统一展示错误）；login 的 5s 超时手写 `Promise.race` 替换为 `timeout` 选项；`fetchUser`/`logout` 保持静默 + 自动登出语义
- [ ] 2.2 迁移 `useMessages.ts`（7 个方法）与 `useRankings.ts`：换 `api` 调用，保持裸抛语义（由调用方 catch），默认自动 toast
- [ ] 2.3 迁移 `useCommunity.ts` / `useContests.ts` / `useCommunityNotifications.ts`：换 `api` 调用；通知未读数轮询用 `silent: true`
- [ ] 2.4 迁移 `useSearch.ts`：换 `api` 调用 + `silent: true`（`Promise.allSettled` 分支与 `state.error` 逻辑保留）
- [ ] 2.5 迁移 `useAdminList.ts` / `useAuditLogs.ts` / `useBanStatus.ts` / `useSubmissionPolling.ts`：换 `api` 调用；保留 error state 消费逻辑，轮询/后台用 `silent: true`
- [ ] 2.6 验证：`deno task lint` + `deno task build` 通过；grep 确认 composables 目录不再有直接 `$fetch`

## 3. 迁移 pages + components

- [ ] 3.1 认证 5 页（login/register/forgot-password/reset-password/change-password）：换 `api` + `silent: true`，保留内联 banner、`USER_BANNED` 专用分支与 `useFormError` 模式不变
- [ ] 3.2 admin 表单提交页（community/contests/users/roles/settings/blacklist/judge-images/submissions/problems/categories/index）：删除 catch 中重复 `toast.error`，依赖 API 层自动弹窗；error ref 内联场景改 `onError`/`silent`；消灭裸抛（load/Promise.all 无 catch 场景）
- [ ] 3.3 社区/消息页（community/index、posts/[postId]、notifications、bookmarks、messages/index、users/[id]）：换 `api` 调用，删除重复 toast，保留静默场景
- [ ] 3.4 轮询/后台静默场景（queue、submissions/[id]、UserMenu 未读数、LatestSubmissions、RandomProblems、index 签到、problems 通过状态、ChatSidebar、ProblemEditor 下拉加载、contests 下拉）：换 `api` + `silent: true`
- [ ] 3.5 `useAsyncData` 包裹场景（about、problems、community posts）与 allSettled 场景（admin/index、community/index、useSearch 已迁移）：换 `api` + `silent`，错误仍由 useAsyncData/allSettled 状态接管
- [ ] 3.6 验证：`deno task lint` + `deno task fmt` + `deno task build` 通过；grep 复查全仓 `$fetch` 仅存在于 `useApi.ts` 与 `server/api/` 代理

## 4. 回归验证与文档

- [ ] 4.1 本地启动 dev 手动验证：登录失败内联 banner 显示具体原因（无 toast 叠加）；admin 提交失败 toast 显示后端具体原因；轮询失败无弹窗；断网场景显示网络兜底文案
- [ ] 4.2 更新 `noj-ui/CLAUDE.md`：API 交互约定补充 `useApi` 层说明（默认自动弹窗、silent/onError/timeout 选项、禁止直接 $fetch）
- [ ] 4.3 运行 noj-tests 跨模块 E2E 回归（`cd noj-tests && deno task test`），确认无回归
- [ ] 4.4 归档 OpenSpec 变更（/opsx:archive 流程）
