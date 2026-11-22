# Agent Note: 收敛空间首页 BFF 首屏合同

Status: implemented

## Problem

空间首页已经提供按域聚合的 BFF 端点，但 SSR 首屏仍由多个组件分别直读 Core。这样会让文档中的“首页单次聚合读取”合同失效，也会让登录用户的关注流响应形状在 SSR 中触发运行时异常。

## Decision

首页按 `domain + viewer` 使用一个 BFF 快照读取轮播、签到、公告、教学、随机题、最新评测和关注流，并把各 section 作为组件的初始数据传入；事件和重试仍保留为后续局部刷新。页面统一解包 `read` section 的 `{ data }` 响应，SSR 验收脚本只将布局级 API 读取视为预期的附加请求，并覆盖游客、学生、教练和助教身份。

## Alternatives considered

继续让每个组件独立请求 Core，或只在客户端水合后加载聚合数据。前者无法满足 SSR/SPA 的单次读取合同，后者会把首屏数据和身份分支推迟到浏览器并放大闪烁与重复请求，因此不采用。

## Consequences

首页首屏在同一域和查看者上下文内只建立一个聚合数据边界；某个 section 失败时仍可局部降级和重试。Core 的 home envelope、Nuxt SSR 夹具和组件测试桩需要同步维护，真实浏览器矩阵仍需在具备浏览器运行时的环境补验。
