## ADDED Requirements

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
