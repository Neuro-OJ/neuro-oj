## Why

noj-ui 当前约 50 个文件、140 处直接调用 `$fetch`，错误处理方式五花八门：有的 catch 后 `toast.error`、有的写表单内联 error ref、有的裸抛（产生 unhandled rejection）、有的静默吞掉；且各调用点错误文案提取逻辑重复（`e.data?.error || e.status` 等），部分场景只显示状态码、丢失后端具体错误原因。需要一个统一的 API 调用层，保证错误提示方式一致、后端具体错误原因（`error` 字段）不丢失。

## What Changes

- 新增 `useApi()` composable 封装 `$fetch`，提供 `api.get/post/put/patch/delete` 方法
- 非 2xx 响应自动提取后端错误响应 `{ error, code, request_id }` 中的 `error` 字段（具体错误原因），通过 `useToast().toast.error()` 弹窗提示
- 错误提示后**重新抛出原错误**（保留 `e.data`/`e.status` 结构），现有依赖错误对象属性的分支代码（如 `USER_BANNED` 专用 banner、editor 404 分支）不受影响
- 支持 `silent: true` 选项：轮询、后台刷新、表单内联错误等无需弹窗的场景静默处理
- 支持 `onError` 自定义回调与 `timeout` 选项（替代现有手写 `Promise.race` 5s 超时）
- 全量迁移现有 `$fetch` 调用点到 `useApi`，删除各调用点重复的 catch + toast 逻辑
- 认证 5 页（login/register/forgot-password/reset-password/change-password）保留内联 banner 模式（`silent: true`），`USER_BANNED` 专用分支不变
- 新增 `utils/apiError.ts` 纯函数错误提取器 + 单元测试

## Capabilities

### New Capabilities

- `ui-api-layer`: 前端统一 API 调用层——封装 `$fetch`、自动提取并弹窗展示后端具体错误原因、支持静默/自定义/超时选项、全量迁移现有调用点

### Modified Capabilities

<!-- 无：nuxt-ui-framework 的现有 REQUIREMENTS 不变（useDialog/useToast 签名保持），本次变更是新增一层而非修改其行为 -->

## Impact

- **代码**：`noj-ui/composables/useApi.ts`（新增）、`noj-ui/utils/apiError.ts`（新增）、`noj-ui/composables/*`（10 个文件迁移）、`noj-ui/pages/*` 与 `noj-ui/components/*`（约 40 个文件迁移）
- **依赖**：无新增依赖（错误弹窗使用现有 Nuxt UI `useToast`，不重新引入 SweetAlert2）
- **行为**：此前静默吞错的裸抛场景（如 admin 页 unhandled rejection）将自动弹出错误提示；轮询/后台场景保持静默
- **测试**：`utils/apiError.ts` 单元测试（deno test）；noj-tests 跨模块 E2E 回归
- **文档**：`noj-ui/CLAUDE.md` API 交互约定补充 useApi 使用规范
