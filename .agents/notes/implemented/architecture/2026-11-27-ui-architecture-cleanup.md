# Agent Note: 前端架构评估问题集中修复

Status: implemented

## Problem

对 `noj-ui` 进行架构评估后，确认存在六类可立即在前端内部闭环修复的结构性问题：

1. `components/shared/MarkdownRenderer.vue` 同步全量导入 `highlight.js`（约 190 种语言定义），并在 `<script setup>` 内部按组件实例重复构造 `markdown-it`，增加题面/社区/公告页包体积与列表渲染开销。
2. `ssr: false` 路由的单一事实来源发生分裂：除 `utils/ssr-routes.ts` 外，`nuxt.config.ts` 又散落硬编码了 11 条 `ssr: false` 规则，`docs/data.md` 也停留在旧路由口径。
3. `middleware/community-moderation.ts` 直接调用 `$fetch('/api/v1/community/config')`（违反 `noj-ui/AGENTS.md` 禁令 1），且仍使用旧的 `useAuthReady(loading)`，未与 `auth`/`admin` 守卫统一为 `ensureAuthReady()`。
4. `app.vue` 的 `resolvePageTitle` 仅覆盖旧根路由，导致未显式调用 `useHead`/`useSeoMeta` 的 `/d/:slug/*` 与 `/admin/*` 页面在浏览器标签页退化为统一 `"Neuro OJ"`。
5. 样式与设计 Token 存在漂移与重复：4 个认证页面/组件（`register.vue`、`AuthFormCard.vue`、`change-password.vue`、`reset-password.vue`）各自拷贝 65–75 行非 scoped `<style>` 动画；`error.vue` 使用违规圆角 `rounded-2xl`；47 个页面/组件中存在 121 处面板级硬编码 `bg-white` 阻碍语义表面 token 一致性；`assets/css/main.css` 的 `.contest-protected` 暗色规则未兼容 `.editor-dark`。
6. `pages/settings.vue`（911 行）耦合个人资料、头像、TFA、OAuth、PIPL 数据隐私与账号注销六个独立功能域，维护成本高。

## Decision

1. **按需高亮与模块级单例**：将 `MarkdownRenderer.vue` 改为 `highlight.js/lib/core` 并按需注册 24 种竞赛与 AI 工程高频语言（附 `types/highlight-languages.d.ts` 类型声明），将 `markdown-it` 实例与纯渲染函数提升至 `<script lang="ts">` 模块级，对不含 `$` 的文本直接跳过 LaTeX 正则扫描。
2. **收口 SSR 客户端路由真相**：将 11 条散落的 `ssr: false` 路径全部迁入 `utils/ssr-routes.ts`，新增 `withClientOnlyRouteRules()` 在 `nuxt.config.ts` 中无损叠加响应头与 `ssr: false`，并同步更新 `docs/data.md`。
3. **统一守卫调用与页面兜底标题**：将 `middleware/community-moderation.ts` 改为 `useApi(to).api.get(..., { silent: true, redirectOnUnauthorized: false })` 与 `await ensureAuthReady()`；抽出 `utils/page-title.ts` 覆盖顶层路由、`/d/:slug/*` 与 `/admin/*`。
4. **去重样式与语义 Token 迁移**：将 `.slide-*`、`.fade-*` 与 `@keyframes fadeInUp` 收编至 `assets/css/main.css`，删除 4 个认证文件重复 `<style>`；修正 `error.vue` 为 `rounded-lg bg-bg-panel`；将全仓 121 处面板/输入框 `bg-white`（保留开关纯白圆点）迁移为 `bg-bg-panel`，并使 `.contest-protected` 兼容 `.editor-dark`。
5. **拆解个人设置页**：将 `pages/settings.vue` 拆分为 5 个 `components/auth/Auth*Section.vue` 区块组件（与既有 `UserByokSettings.vue` 并列），主页面缩减至 ~90 行，同步更新 `docs/structure.md`。
6. **补充回归测试**：新增 `tests/utils/ssrRoutes_test.ts`、`tests/utils/pageTitle_test.ts` 与 `tests/components/MarkdownRenderer.spec.ts`。

## Alternatives considered

- **在 `nuxt.config.ts` 继续手写重复 `ssr: false`**：容易再次与 `utils/ssr-routes.ts` 漂移，用 `withClientOnlyRouteRules()` 合并后可彻底消除重复。
- **使用 `highlight.js/lib/common` 代替 `core`**：`common` 仍包含 30+ 种与竞赛/AI 无关的语言（如 Perl/PHP/Ruby/Objective-C 等），且不如显式白名单可控。
- **同步拆解 `pages/admin/settings.vue` 与生成跨模块 OpenAPI 契约**：`SystemSettings.spec.ts` 直接断言内部 DOM ID 与草稿状态，且 OpenAPI 契约涉及 `noj-core` 跨模块改动，留作独立专题迭代更稳妥。

## Consequences

- `MarkdownRenderer.vue` 不再打包全量 `highlight.js` 语言集，列表场景避免重复创建 `markdown-it` 实例，题面与社区代码高亮及 KaTeX/XSS 行为保持不变。
- `utils/ssr-routes.ts` 成为 `ssr: false` 路由的唯一事实来源；业务代码零直调 `$fetch`；所有多域与后台页面均具备语义 `<title>` 兜底。
- 消除约 280 行重复全局 `<style>` 与 121 处面板硬编码 `bg-white`，`pages/settings.vue` 体积下降 90%，便于独立维护与后续推进全站暗色主题。
