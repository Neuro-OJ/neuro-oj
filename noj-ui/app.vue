<template>
    <UApp>
        <NuxtLayout>
            <NuxtPage />
        </NuxtLayout>
    </UApp>
</template>

<script setup lang="ts">
import { useBanStatus } from "~/composables/useBanStatus"

const { fetch } = useBanStatus()
const { isLoggedIn } = useAuth()
const { locale, t } = useI18n()

// 首次加载时获取封禁状态
if (import.meta.client) {
  fetch()
}

// 登录/登出状态变化时重新获取封禁状态（SPA 导航不会重载页面，需手动刷新）
watch(isLoggedIn, () => {
  if (import.meta.client) {
    fetch()
  }
})

// ─── 页面级标题（WCAG 2.4.2）：按路由路径生成描述性 <title>，替代全站统一标题 ───
const route = useRoute()

const TITLE_RULES: { match: string; key: string }[] = [
  { match: "/login", key: "auth.login" },
  { match: "/register", key: "auth.register" },
  { match: "/problems", key: "problem.title" },
  { match: "/submissions", key: "submission.title" },
  { match: "/contests", key: "contest.title" },
  { match: "/community", key: "nav.community" },
  { match: "/ranking", key: "nav.ranking" },
  { match: "/about", key: "nav.about" },
  { match: "/", key: "nav.home" },
]

function resolvePageTitle(path: string): string {
  // 精确匹配优先，其次前缀匹配（动态路由如 /problems/1001、/submissions/{id}）
  const exact = TITLE_RULES.find((r) => r.match === path)
  if (exact) return `${t(exact.key)} - Neuro OJ`
  const byPrefix = TITLE_RULES.find((r) => r.match !== "/" && path.startsWith(r.match))
  return byPrefix ? `${t(byPrefix.key)} - Neuro OJ` : "Neuro OJ"
}

useHead({
  title: computed(() => resolvePageTitle(route.path)),
  htmlAttrs: { lang: computed(() => locale.value) },
  meta: [
    { property: 'og:title', content: 'Neuro OJ' },
    { property: 'og:description', content: 'Neuro OJ — 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC）的在线评测平台' },
    { property: 'og:type', content: 'website' },
  ],
})
</script>

<style>
:root {
    --c-primary: #1B2B4A; --c-primary-dark: #16233E; --c-primary-light: #2C4B9B;
    --c-primary-bg: #e6fbf3; --c-primary-hover-bg: #c2f5e2; --c-primary-active-bg: #8aebc8; --c-primary-text: #007146;
    --c-bg-dark: #121310; --c-bg-dark-2: #191b17; --c-bg-dark-3: #0d0e0c;
    --c-success-text: #007146; --c-info-text: #1B2B4A; --c-warning-text: #b45309; --c-error-text: #dc2626;
    --c-text: #1c1e1b; --c-text-secondary: #4c4e4a; --c-text-muted: #6b6e68;
    --header-h: 64px;
    --c-border: #d5d6cf; --c-bg-page: #e8e8e2; --c-bg-panel: #f2f2ec; --c-bg-sunken: #dfe0d9; --c-white: #f2f2ec; --c-text-on-color: #ffffff;
    --c-text-on-dark: #f2f3ef;
    --c-signal: #00d68a; --c-signal-deep: #007146; --c-signal-rgb: 0,214,138;
    --c-signal-dark: #00e07a; --c-signal-deep-dark: #00d68a; --c-signal-dark-rgb: 0,224,122;
    --c-on-signal: #1c1e1b;
}

.editor-dark {
  --c-bg-page: #121310;
  --c-bg-panel: #191b17;
  --c-bg-sunken: #0d0e0c;
  --c-white: #191b17;
  --c-border: #333631;
  --c-text: #f2f3ef;
  --c-text-secondary: #90938d;
  --c-text-muted: #6f736d;
  --c-primary: #7C96D6;
  --c-primary-dark: #6C86C8;
  --c-primary-light: #8BA3DB;
  --c-primary-hover-bg: #1a3d30;
  --c-primary-bg: #12352a;
  --c-primary-text: #00d68a;
  --c-signal: #00e07a;
  --c-signal-deep: #00d68a;
  --c-signal-rgb: 0,224,122;
  --c-on-signal: #1c1e1b;
  --c-success-text: #00b377;
  --c-info-text: #7C96D6;
  --c-warning-text: #fbbf24;
  --c-error-text: #ff6b61;
  --c-text-on-dark: #f2f3ef;
}

.editor-dark .prose-neuro {
  --tw-prose-body: #f2f3ef;
  --tw-prose-headings: #f2f3ef;
  --tw-prose-links: #7C96D6;
  --tw-prose-code: #00d68a;
}

/* CSS 变量（设计 Token）统一在 :root 中定义，main.css 的 @theme 通过 var() 引用。
   全局重置由 Tailwind Preflight 提供，字体和背景通过 Tailwind 类在 layouts 中应用。
   通用按钮已全部迁移为 Nuxt UI <UButton>，不再保留全局按钮工具类。 */
</style>
