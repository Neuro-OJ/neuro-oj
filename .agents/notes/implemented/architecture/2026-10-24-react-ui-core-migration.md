# Agent Note: React 与 shadcn/ui 首批前端迁移

Status: implemented

## Problem

原前端的 72 个页面和 99 个组件依赖 Nuxt/Vue，认证、SSR、Monaco 资源与 Deno
部署也与 Nuxt 构建耦合。用户选择全部前端使用 React +
shadcn/ui，并要求分批交付、先完成基础与核心流程，界面只保留原项目文案。

## Decision

首批源码集中在 `noj-ui/react/`，通过 `/react`
提供首页、登录、题库、题面、代码工作区、文件提交和评测结果。 React Router
管理子路由；单个 Nuxt 适配页面提供按请求的预取、SSR、水合及 Cookie
请求上下文。原路由与其他领域的 Vue
页面继续提供服务，专用客观题与界面题作答入口指向原页面。

通用组件采用 shadcn/ui，主题映射既有 NOJ token，布局使用 Tailwind。 TSX 使用
React JSX 文件声明和局部编译插件，避免 Vue JSX/全局 Refresh 配置污染原页面。
用户会话与资源数据按请求创建，组件样式由静态 Tailwind CSS 输出；React API
使用既有同源代理，JWT 仍只存在于 HttpOnly Cookie。

Markdown 渲染抽为共享纯函数，Vue 和 React 同用原有净化、公式与图片策略。
代码草稿按账号、题目、版本、语言隔离；模板响应不覆盖用户编辑；代码、文件和自测均携带作答版本。
版本冲突不自动换版重提。非终态提交采用 SSE
加轮询，自测采用轮询，卸载和终态释放资源。

Deno 单测覆盖路由、回跳、API、SSR 隔离及 Markdown；React SSR
测试覆盖首屏组件与会话隔离；浏览器夹具覆盖桌面/手机的登录、政策同意、版本、草稿、代码/文件提交、自测和结果。
CI 包含 React 类型、SSR 和生产构建浏览器检查。

本地验证通过 270 项 Deno 单测、110 项原有组件测试、2 项 React SSR 测试，
以及桌面/手机的核心流程与原编辑器主题回归。Deno
单二进制编译通过，核心流程也在该编译产物上执行。

## Alternatives considered

- 全量一次性替换
  Nuxt：与用户选择的分批迁移不符，且跨认证、编辑器和部署的回归边界过大。
- 新建第二个前端服务与认证代理：过渡期重复维护安全边界与部署，增加 Cookie
  与路由漂移。
- 在 React 中仿写现有通用 UI：没有利用已选定的 UI 库，维护成本和一致性更差。
- 全局启用 React JSX/Refresh 插件：影响现有 Vue 文件；局部 TSX
  转换保留两者各自的运行时。

## Consequences

首批页面可与旧系统同源运行，Deno 构建和生产镜像入口保持兼容。依赖安装通过 Deno
更新锁文件，并对齐原 package.json 已声明但旧锁文件尚未覆盖的 Nuxt/Router 版本。

这是一批已交付的迁移入口，尚不代表全站 React
替换完成。竞赛、训练、社区、管理、出题和账户设置仍在原页面中。
后续迁移以逐领域行为验收为基础；只有全部功能和构建链路完成后才移除 Nuxt/Vue。
