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
    --c-primary: #0284c7; --c-primary-dark: #0369a1; --c-primary-light: #38bdf8;
    --c-primary-bg: #f0f9ff; --c-primary-hover-bg: #e0f2fe; --c-primary-active-bg: #bae6fd; --c-primary-text: #0284c7;
    --c-bg-dark: #0b0f19; --c-bg-dark-2: #131b2e; --c-bg-dark-3: #070a12;
    --c-success-text: #059669; --c-info-text: #0284c7; --c-warning-text: #d97706; --c-error-text: #e11d48;
    --c-text: #0f172a; --c-text-secondary: #475569; --c-text-muted: #64748b;
    --header-h: 64px;
    --c-border: #e1e8f2; --c-bg-page: #f5f8fc; --c-bg-panel: #ffffff; --c-bg-sunken: #edf2f9; --c-white: #ffffff; --c-text-on-color: #ffffff;
    --c-text-on-dark: #f8fafc;
    --c-signal: #059669; --c-signal-deep: #047857; --c-signal-rgb: 5,150,105;
    --c-signal-dark: #00e07a; --c-signal-deep-dark: #00d68a; --c-signal-dark-rgb: 0,224,122;
    --c-on-signal: #ffffff;
}

.editor-dark {
  --c-bg-page: #0b0f19;
  --c-bg-panel: #131b2e;
  --c-bg-sunken: #070a12;
  --c-white: #131b2e;
  --c-border: #1e293b;
  --c-text: #f8fafc;
  --c-text-secondary: #94a3b8;
  --c-text-muted: #64748b;
  --c-primary: #38bdf8;
  --c-primary-dark: #0ea5e9;
  --c-primary-light: #7dd3fc;
  --c-primary-hover-bg: rgba(56, 189, 248, 0.2);
  --c-primary-bg: rgba(56, 189, 248, 0.12);
  --c-primary-text: #38bdf8;
  --c-signal: #00e07a;
  --c-signal-deep: #00d68a;
  --c-signal-rgb: 0,224,122;
  --c-on-signal: #0b0f19;
  --c-success-text: #00e07a;
  --c-info-text: #38bdf8;
  --c-warning-text: #fbbf24;
  --c-error-text: #fb7185;
  --c-text-on-dark: #f8fafc;
}

.editor-dark .prose-neuro {
  --tw-prose-body: #f8fafc;
  --tw-prose-headings: #f8fafc;
  --tw-prose-links: #38bdf8;
  --tw-prose-code: #00e07a;
}

/* CSS 变量（设计 Token）统一在 :root 中定义，main.css 的 @theme 通过 var() 引用。
   全局重置由 Tailwind Preflight 提供，字体和背景通过 Tailwind 类在 layouts 中应用。
   通用按钮已全部迁移为 Nuxt UI <UButton>，不再保留全局按钮工具类。 */
</style>
