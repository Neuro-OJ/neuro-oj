## ADDED Requirements

### Requirement: 社区公开页面使用 SSR 可序列化数据加载

社区首页与帖子详情等公开页面 SHALL 使用 `useAsyncData`/`useFetch` 获取配置、帖子列表、帖子详情与评论，不得在 `<script setup>` 顶层使用 `await api.get(...)` 写入普通 `ref`。

#### Scenario: 社区首页 SSR 加载

- **WHEN** 搜索引擎或用户请求 `/community`
- **THEN** 服务端通过 `useAsyncData` 获取配置与帖子列表，结果序列化到客户端 payload，水合不重复请求

#### Scenario: 社区帖子详情 SSR 加载

- **WHEN** 用户请求 `/community/posts/:id`
- **THEN** 服务端通过 `useAsyncData` 获取帖子与评论，页面正常渲染；配置接口失败时降级为空配置而不是 502

### Requirement: 社区强登录页面关闭 SSR

社区收藏、社区通知、举报详情等强登录页面 SHALL 设置 `ssr: false`，由客户端守卫与数据加载接管。

#### Scenario: 收藏页关闭 SSR

- **WHEN** 用户访问 `/community/bookmarks`
- **THEN** 服务端不渲染该页，客户端水合后执行登录校验并加载收藏数据

#### Scenario: 通知页关闭 SSR

- **WHEN** 用户访问 `/community/notifications`
- **THEN** 服务端不渲染该页，客户端水合后执行登录校验并加载通知数据

#### Scenario: 举报详情关闭 SSR

- **WHEN** 用户访问 `/community/reports/:id`
- **THEN** 服务端不渲染该页，客户端水合后执行登录校验并加载举报详情
