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
const { t } = useI18n()

// 首次加载时获取封禁状态
if (import.meta.client) {
  fetch(false)
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
  { match: "/leaderboard", key: "nav.ranking" },
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
  htmlAttrs: { lang: 'zh-CN' },
  meta: [
    { property: 'og:title', content: 'Neuro OJ' },
    { property: 'og:description', content: 'Neuro OJ — 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC）的在线评测平台' },
    { property: 'og:type', content: 'website' },
  ],
})
</script>

<style>
:root {
  /* 1. 品牌与交互 */
  --c-primary: #0369a1;
  --c-primary-dark: #075985;
  --c-primary-light: #0284c7;
  --c-primary-bg: #f0f9ff;
  --c-primary-hover-bg: #e0f2fe;
  --c-primary-active-bg: #bae6fd;
  --c-primary-text: #0369a1;

  /* 2. 深色基底保留变量（供暗色块或兼容类引用） */
  --c-bg-dark: #0b1120;
  --c-bg-dark-2: #111827;
  --c-bg-dark-3: #070b14;

  /* 3. 状态文本与评测信号 */
  --c-success-text: #047857;
  --c-info-text: #0369a1;
  --c-warning-text: #b45309;
  --c-error-text: #be123c;
  --c-signal: #047857;
  --c-signal-deep: #065f46;
  --c-signal-rgb: 4, 120, 87;
  --c-signal-dark: #00e07a;
  --c-signal-deep-dark: #00d68a;
  --c-signal-dark-rgb: 0, 224, 122;
  --c-on-signal: #ffffff;

  /* 4. 表面与边框（Precision Instrument） */
  --c-text: #0f172a;
  --c-text-secondary: #475569;
  --c-text-muted: #64748b;
  --c-text-on-color: #ffffff;
  --c-text-on-dark: #f8fafc;
  --c-border: #e2e8f0;
  --c-border-subtle: #e2e8f0;
  --c-border-strong: #cbd5e1;
  --c-bg-page: #f7f8fa;
  --c-bg-panel: #ffffff;
  --c-bg-card: #ffffff;
  --c-bg-elevated: #ffffff;
  --c-bg-sunken: #f1f5f9;
  --c-white: #ffffff;

  /* 5. 评测结果与难度语义色板 */
  --c-verdict-accepted: #047857;
  --c-verdict-accepted-bg: #ecfdf5;
  --c-verdict-partial: #b45309;
  --c-verdict-partial-bg: #fffbeb;
  --c-verdict-wrong: #be123c;
  --c-verdict-wrong-bg: #fff1f2;
  --c-verdict-limit: #c2410c;
  --c-verdict-limit-bg: #fff7ed;
  --c-verdict-judging: #0369a1;
  --c-verdict-judging-bg: #f0f9ff;
  --c-verdict-pending: #64748b;
  --c-verdict-pending-bg: #f1f5f9;
  --c-diff-easy: #047857;
  --c-diff-medium: #b45309;
  --c-diff-hard: #be123c;

  --header-h: 64px;
}

/* 编辑器暗色主题：唯一真正切换 --c-* 的暗色区域。color-scheme 随之置为 dark，
   让区域内原生表单控件、滚动条与实际渲染的明暗保持一致（全站其余部分为亮色）。 */
.editor-dark {
  color-scheme: dark;
  --c-bg-page: #0b1120;
  --c-bg-panel: #111827;
  --c-bg-card: #111827;
  --c-bg-elevated: #182235;
  --c-bg-sunken: #070b14;
  --c-white: #111827;
  --c-border: #1e293b;
  --c-border-subtle: #1e293b;
  --c-border-strong: #334155;
  --c-text: #f8fafc;
  --c-text-secondary: #94a3b8;
  --c-text-muted: #64748b;
  --c-primary: #38bdf8;
  --c-primary-dark: #0ea5e9;
  --c-primary-light: #7dd3fc;
  --c-primary-hover-bg: rgba(56, 189, 248, 0.2);
  --c-primary-bg: rgba(56, 189, 248, 0.12);
  --c-primary-active-bg: rgba(56, 189, 248, 0.28);
  --c-primary-text: #38bdf8;
  --c-signal: #00e07a;
  --c-signal-deep: #00d68a;
  --c-signal-rgb: 0, 224, 122;
  --c-on-signal: #0b1120;
  --c-success-text: #00e07a;
  --c-info-text: #38bdf8;
  --c-warning-text: #fbbf24;
  --c-error-text: #fb7185;
  --c-text-on-dark: #f8fafc;
  --c-verdict-accepted: #00e07a;
  --c-verdict-accepted-bg: rgba(0, 224, 122, 0.12);
  --c-verdict-partial: #fbbf24;
  --c-verdict-partial-bg: rgba(251, 191, 36, 0.12);
  --c-verdict-wrong: #fb7185;
  --c-verdict-wrong-bg: rgba(251, 113, 133, 0.12);
  --c-verdict-limit: #fb923c;
  --c-verdict-limit-bg: rgba(251, 146, 60, 0.12);
  --c-verdict-judging: #38bdf8;
  --c-verdict-judging-bg: rgba(56, 189, 248, 0.12);
  --c-verdict-pending: #94a3b8;
  --c-verdict-pending-bg: rgba(148, 163, 184, 0.12);
  --c-diff-easy: #34d399;
  --c-diff-medium: #fbbf24;
  --c-diff-hard: #fb7185;
}

/* CSS 变量（设计 Token）统一在 :root 中定义，main.css 的 @theme 通过 var() 引用。
   全局重置由 Tailwind Preflight 提供，字体和背景通过 Tailwind 类在 layouts 中应用。
   通用按钮已全部迁移为 Nuxt UI <UButton>，不再保留全局按钮工具类。 */
</style>
