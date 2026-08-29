## Purpose

定义 noj-ui 页面 SSR 渲染规范，包括 Nuxt 数据获取、禁止顶层 await 反模式、ssr:false 边界与 SSR 非关键数据降级。

## Requirements

### Requirement: 页面初始数据使用 Nuxt 数据获取

noj-ui 的所有页面 SHALL 将“页面初始数据”通过 `useAsyncData` 或 `useFetch` 获取，以便 SSR 结果序列化到客户端 payload；交互操作、轮询与表单提交 SHALL 通过 `useApi` 发起。

#### Scenario: 公开列表页 SSR 获取数据

- **WHEN** 用户请求题库、题单、竞赛等公开列表页
- **THEN** 页面在 SSR 阶段通过 `useFetch`/`useAsyncData` 获取数据，并将结果序列化到客户端 payload，水合时不重复请求

#### Scenario: 交互操作走 useApi

- **WHEN** 用户提交表单、点赞、发布评论或轮询状态
- **THEN** 页面通过 `useApi` 发起请求，不绕过统一 API 层

### Requirement: 禁止顶层 await + 普通 ref 作为 SSR 数据获取

页面 SHALL NOT 在 `<script setup>` 顶层使用 `await api.get(...)` 写入普通 `ref` 来获取 SSR 初始数据；此类数据 MUST 使用 `useAsyncData`/`useFetch` 或让页面明确 `ssr: false`。

#### Scenario: 社区首页不再出现顶层 await 反模式

- **WHEN** 社区首页在 SSR 渲染
- **THEN** 帖子、计数与配置通过 `useAsyncData`/`useState` 序列化到客户端，不因普通 `ref` 未序列化而在水合时重复请求

#### Scenario: 纯客户端页面声明 ssr:false

- **WHEN** 页面完全依赖客户端交互且无 SEO/首屏价值
- **THEN** 页面设置 `ssr: false`，服务端不渲染该页面，客户端负责数据获取与守卫

### Requirement: ssr:false 边界明确

纯交互或强登录页面 SHALL 设置 `ssr: false`，包括私信、我的题目、设置、队列、竞赛排名、社区收藏、社区通知、社区举报详情；管理后台、编辑器、新建/编辑题目、竞赛做题页保持 `ssr: false`。内容/SEO 页面 SHALL 保持 SSR。

#### Scenario: 私信页关闭 SSR

- **WHEN** 用户访问 `/messages`
- **THEN** 服务端不渲染聊天内容，客户端水合后由客户端守卫与数据加载接管

#### Scenario: 竞赛详情保持 SSR

- **WHEN** 用户访问公开竞赛详情页
- **THEN** 服务端渲染竞赛公开信息，题目与排行等客户端交互部分仍由组件按需加载

### Requirement: SSR 非关键数据失败时降级

SSR 阶段对非关键数据（社区配置、首页公告、题解入口等）的获取失败 SHALL 降级为安全空态/默认值，不得导致整页渲染失败或返回错误页。

#### Scenario: 社区配置接口失败

- **WHEN** 社区配置接口在 SSR 阶段返回 5xx 或网络错误
- **THEN** 页面以默认配置渲染社区容器或显示“功能暂未启用”，不抛出未捕获异常导致 502

#### Scenario: 首页公告接口失败

- **WHEN** 首页公告接口失败
- **THEN** 轮播区域显示默认欢迎占位，不阻塞首页其余内容渲染
