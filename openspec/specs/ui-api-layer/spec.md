## Purpose

定义 noj-ui 前端的统一 API 调用层规范。所有业务代码通过 `useApi()` composable 发起请求，统一处理错误提示、静默模式与自定义错误回调，并迁移现有直接 `$fetch` 调用点。

## Requirements

### Requirement: API 调用统一入口

noj-ui SHALL 通过 `useApi()` composable 提供统一的 API 调用入口，所有业务代码的数据请求 SHALL 经 `api.get/post/put/patch/delete` 方法发起，不得直接调用 `$fetch`（Nitro 代理 `server/api/[...slug].ts` 与 `useApi` 内部实现除外）。

#### Scenario: 统一方法调用

- **WHEN** 页面需要请求 GET /api/v1/problems
- **THEN** 通过 `useApi().api.get('/api/v1/problems')` 发起，返回与 `$fetch` 一致的成功响应数据

#### Scenario: 请求方法覆盖

- **WHEN** 业务需要 GET/POST/PUT/PATCH/DELETE 任意方法
- **THEN** `useApi` 提供对应同名方法，支持 `body`、`query` 等 `$fetch` 选项透传

### Requirement: 错误自动弹窗展示具体原因

`useApi` SHALL 在非 2xx 响应或网络/超时错误时，自动提取错误的具体原因，并通过 `useToast().toast.error()` 弹窗提示，然后重新抛出原错误对象（保留 `data`/`status` 等结构供调用方差异化处理）。

#### Scenario: 后端业务错误展示具体原因

- **WHEN** 后端返回 4xx 且响应体含 `{ error: "用户名已存在" }`
- **THEN** 自动弹出 toast 显示「用户名已存在」（而非仅状态码），错误对象原样抛出

#### Scenario: 无 error 字段时的兜底文案

- **WHEN** 非 2xx 响应体不含 `error` 字段
- **THEN** 弹出结构化兜底文案（如「请求失败（HTTP 500）」），避免只显示状态码

#### Scenario: 网络错误兜底

- **WHEN** 请求因网络不可达失败
- **THEN** 弹出「网络连接失败，请检查网络」类提示

#### Scenario: 超时兜底

- **WHEN** 请求超过 `timeout` 选项设定的毫秒数
- **THEN** 弹出「请求超时，请稍后重试」类提示并抛错

#### Scenario: 调用方差异化处理不破坏

- **WHEN** 调用方 catch 后检查 `e.data?.code` 或 `e.status`
- **THEN** 错误对象结构保持 `$fetch` 原样，现有分支代码继续工作

#### Scenario: SSR 端不弹窗

- **WHEN** 请求发生在服务端渲染阶段
- **THEN** 不触发 toast，仅抛错

### Requirement: 静默与自定义错误处理选项

`useApi` SHALL 支持 `silent`、`onError` 与 `redirectOnUnauthorized` 选项：`silent: true` 时不弹 toast（错误仍抛出）；提供 `onError` 回调时用回调替换默认 toast（不重复弹窗）；`silent` 与 `onError` 同时给出时 `silent` 优先；`redirectOnUnauthorized: false` 时，401 错误 SHALL 不触发登录页跳转，但仍 SHALL 原样抛出供调用方处理。默认情况下，非认证页面中的 401 请求 SHALL 保持统一跳转登录页行为。

#### Scenario: 轮询静默

- **WHEN** 轮询请求失败且调用方传 `silent: true`
- **THEN** 不弹 toast，错误照常抛出由调用方处理

#### Scenario: 自定义错误处理

- **WHEN** 调用方传 `onError(err)` 回调
- **THEN** 执行回调且不再自动弹 toast

#### Scenario: 静默优先

- **WHEN** 调用方同时传 `silent: true` 与 `onError`
- **THEN** 不弹 toast，`onError` 仍被执行

#### Scenario: 可选认证后台请求收到 401

- **WHEN** 后台状态探测请求传入 `redirectOnUnauthorized: false` 且服务端返回 401
- **THEN** 不跳转登录页，错误仍被抛出并由调用方静默处理

#### Scenario: 默认认证失败跳转

- **WHEN** 非认证页面的业务请求未传 `redirectOnUnauthorized: false` 且服务端返回 401
- **THEN** 清除本地登录态并跳转登录页，同时保留当前页面作为回跳地址

### Requirement: 认证内层调用不弹窗

`useAuth` 的 `login/register/forgotPassword/resetPassword/changePassword` 内层 API 调用 SHALL 使用静默模式，错误由认证页面内联展示（banner/表单错误），避免双重提示；`fetchUser` 与 `logout` SHALL 保持静默 + 失败自动清登录态语义。

#### Scenario: 登录失败单次提示

- **WHEN** 登录失败（如密码错误）
- **THEN** 仅页面内联 banner 显示后端错误原因，不叠加 toast

#### Scenario: fetchUser 失败自动登出

- **WHEN** `fetchUser()` 请求失败（含 401）
- **THEN** 不弹 toast，清除本地登录态并返回 null

### Requirement: 现有调用点全量迁移

noj-ui SHALL 将现有页面与组件的直接 `$fetch` 调用全量迁移至 `useApi`，删除各调用点重复的 catch + `toast.error` 逻辑；轮询、后台刷新、表单内联错误等场景 SHALL 显式使用 `silent`/`onError` 保持既有语义。

#### Scenario: 管理端提交失败统一提示

- **WHEN** admin 表单提交失败
- **THEN** 由 API 层自动弹出后端具体错误原因，页面不再各自手写 toast 逻辑

#### Scenario: 裸抛场景获得提示

- **WHEN** 原先无 catch 的加载调用（如 admin/community 统计加载）失败
- **THEN** 自动弹出错误提示，不再产生 unhandled rejection

#### Scenario: 后台刷新保持静默

- **WHEN** 页面后台静默刷新（如未读数、通过状态）失败
- **THEN** 不弹 toast，行为与迁移前一致

### Requirement: SSR 页面初始数据不绕过统一数据获取层

页面在 SSR 阶段获取初始数据 SHALL 使用 `useAsyncData`/`useFetch`，不得在 setup 顶层直接调用 `$fetch` 或 `api.get` 写入普通 `ref`；`useApi` 用于交互、轮询与表单提交。

#### Scenario: 页面初始数据经 useAsyncData

- **WHEN** 页面在 SSR 渲染时需要公告、竞赛或社区内容
- **THEN** 初始数据通过 `useAsyncData`/`useFetch` 获取并可序列化到客户端 payload

#### Scenario: 交互请求经 useApi

- **WHEN** 用户点击报名、发布、点赞等
- **THEN** 请求通过 `useApi` 发起，保持统一错误处理

### Requirement: useApi 服务端统一转发请求头

`useApi` 在服务端 SHALL 使用 `useRequestFetch`（或等价机制）转发原始请求的 Cookie 与请求头，取代手动拼接 `cookie` header；`useApi()` 调用 SHALL 发生在同步 setup 上下文，异步回调内不得再调用 `useApi()`。

#### Scenario: SSR 登录态请求

- **WHEN** SSR 阶段通过 `useApi` 请求需要登录的接口
- **THEN** 请求携带原始 Cookie，noj-core 能识别当前用户

#### Scenario: 异步回调不调用 useApi

- **WHEN** 轮询、搜索或列表加载等异步回调需要发请求
- **THEN** 使用外层 setup 已获取的 `api` 实例，不在回调内重复调用 `useApi()`

### Requirement: 清理残留直接 $fetch

所有业务页面 SHALL 移除直接 `$fetch` 调用，统一迁移到 `useApi` 或 Nuxt 数据获取层。

#### Scenario: 题目详情题解请求迁移

- **WHEN** 题目详情页加载题解列表与发布资格
- **THEN** 请求通过 `useApi` 或 `useAsyncData` 发起，不再直接使用 `$fetch`
