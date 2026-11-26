<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script setup lang="ts">
import { useBanStatus } from '~/composables/useBanStatus';

const { fetch } = useBanStatus();
const { isLoggedIn } = useAuth();
const { t } = useI18n();

// 首次加载时获取封禁状态
if (import.meta.client) {
  fetch(false);
}

// 登录/登出状态变化时重新获取封禁状态（SPA 导航不会重载页面，需手动刷新）
watch(isLoggedIn, () => {
  if (import.meta.client) {
    fetch();
  }
});

// ─── 页面级标题（WCAG 2.4.2）：按路由路径生成描述性 <title>，替代全站统一标题 ───
const route = useRoute();

const TITLE_RULES: { match: string; key: string }[] = [
  { match: '/login', key: 'auth.login' },
  { match: '/register', key: 'auth.register' },
  { match: '/problems', key: 'problem.title' },
  { match: '/submissions', key: 'submission.title' },
  { match: '/contests', key: 'contest.title' },
  { match: '/community', key: 'nav.community' },
  { match: '/leaderboard', key: 'nav.ranking' },
  { match: '/about', key: 'nav.about' },
  { match: '/', key: 'nav.home' },
];

function resolvePageTitle(path: string): string {
  // 精确匹配优先，其次前缀匹配（动态路由如 /problems/1001、/submissions/{id}）
  const exact = TITLE_RULES.find((r) => r.match === path);
  if (exact) return `${t(exact.key)} - Neuro OJ`;
  const byPrefix = TITLE_RULES.find((r) => r.match !== '/' && path.startsWith(r.match));
  return byPrefix ? `${t(byPrefix.key)} - Neuro OJ` : 'Neuro OJ';
}

useHead({
  title: computed(() => resolvePageTitle(route.path)),
  htmlAttrs: { lang: 'zh-CN' },
  meta: [
    { property: 'og:title', content: 'Neuro OJ' },
    { property: 'og:description', content: 'Neuro OJ — 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC）的在线评测平台' },
    { property: 'og:type', content: 'website' },
  ],
});
</script>

<style>
:root {
  /* 浅色基线 token：实际生效的深色终端主题在 assets/css/main.css 的 html:root
     中整体覆盖；这里保留覆盖未涉及的 token 与编辑器局部变量。 */

  /* 1. 品牌与交互（钴蓝） */
  --c-primary: #5e6ad2;
  --c-primary-dark: #4c57c0;
  --c-primary-light: #7c85de;
  --c-primary-bg: #f4f5fd;
  --c-primary-hover-bg: #eaecfa;
  --c-primary-active-bg: #d5d9f5;
  --c-primary-text: #5059c7;

  /* 2. 深色基底 */
  --c-bg-dark: #0a0a0a;
  --c-bg-dark-2: #1a1a18;
  --c-bg-dark-3: #0d0d0c;

  /* 3. 状态文本与评测信号 */
  --c-success-text: #17803d;
  --c-info-text: #5059c7;
  --c-warning-text: #b45309;
  --c-error-text: #dc3545;
  --c-signal: #17803d;
  --c-signal-deep: #126b33;
  --c-signal-rgb: 23, 128, 61;
  --c-signal-dark: #4fd27a;
  --c-signal-deep-dark: #3fbf69;
  --c-signal-dark-rgb: 79, 210, 122;
  --c-on-signal: #ffffff;

  /* 4. 表面与边框（暖中性灰） */
  --c-text: #171717;
  --c-text-secondary: #525252;
  --c-text-muted: #8f8f8f;
  --c-text-on-color: #ffffff;
  --c-text-on-dark: #ededed;
  --c-border: #ebebeb;
  --c-border-subtle: #f2f2f2;
  --c-border-strong: #d6d6d6;
  --c-bg-page: #fafafa;
  --c-bg-panel: #ffffff;
  --c-bg-card: #ffffff;
  --c-bg-elevated: #ffffff;
  --c-bg-sunken: #f5f5f5;
  --c-white: #ffffff;

  /* 5. 评测结果与难度 */
  --c-verdict-accepted: #17803d;
  --c-verdict-accepted-bg: #ecf8f0;
  --c-verdict-partial: #a16207;
  --c-verdict-partial-bg: #fdf7e3;
  --c-verdict-wrong: #dc3545;
  --c-verdict-wrong-bg: #fdf0f1;
  --c-verdict-limit: #c2410c;
  --c-verdict-limit-bg: #fff3ea;
  --c-verdict-judging: #5e6ad2;
  --c-verdict-judging-bg: #f4f5fd;
  --c-verdict-pending: #8f8f8f;
  --c-verdict-pending-bg: #f5f5f5;
  --c-diff-easy: #17803d;
  --c-diff-medium: #b45309;
  --c-diff-hard: #dc3545;

  --header-h: 48px;
}

/* 编辑器暗色主题：唯一真正切换 --c-* 的暗色区域。color-scheme 随之置为 dark，
   让区域内原生表单控件、滚动条与实际渲染的明暗保持一致（全站其余部分为亮色）。 */
.editor-dark {
  color-scheme: dark;
  --c-bg-page: #0a0a0a;
  --c-bg-panel: #111111;
  --c-bg-card: #111111;
  --c-bg-elevated: #1a1a1a;
  --c-bg-sunken: #000000;
  --c-white: #111111;
  --c-border: #262626;
  --c-border-subtle: #1f1f1f;
  --c-border-strong: #383838;
  --c-text: #ededed;
  --c-text-secondary: #a1a1a1;
  --c-text-muted: #707070;
  --c-primary: #8d95f2;
  --c-primary-dark: #737ce8;
  --c-primary-light: #b2b8f7;
  --c-primary-hover-bg: rgba(141, 149, 242, 0.18);
  --c-primary-bg: rgba(141, 149, 242, 0.1);
  --c-primary-active-bg: rgba(141, 149, 242, 0.26);
  --c-primary-text: #8d95f2;
  --c-signal: #4fd27a;
  --c-signal-deep: #3fbf69;
  --c-signal-rgb: 79, 210, 122;
  --c-on-signal: #0a0a0a;
  --c-success-text: #4fd27a;
  --c-info-text: #8d95f2;
  --c-warning-text: #e8b04a;
  --c-error-text: #f07487;
  --c-text-on-dark: #ededed;
  --c-verdict-accepted: #4fd27a;
  --c-verdict-accepted-bg: rgba(79, 210, 122, 0.12);
  --c-verdict-partial: #e8b04a;
  --c-verdict-partial-bg: rgba(232, 176, 74, 0.12);
  --c-verdict-wrong: #f07487;
  --c-verdict-wrong-bg: rgba(240, 116, 135, 0.12);
  --c-verdict-limit: #f0964a;
  --c-verdict-limit-bg: rgba(240, 150, 74, 0.12);
  --c-verdict-judging: #8d95f2;
  --c-verdict-judging-bg: rgba(141, 149, 242, 0.12);
  --c-verdict-pending: #a1a1a1;
  --c-verdict-pending-bg: rgba(161, 161, 161, 0.12);
  --c-diff-easy: #4fd27a;
  --c-diff-medium: #e8b04a;
  --c-diff-hard: #f07487;
}

/* CSS 变量（设计 Token）统一在 :root 中定义，main.css 的 @theme 通过 var() 引用。
   全局重置由 Tailwind Preflight 提供，字体和背景通过 Tailwind 类在 layouts 中应用。
   通用按钮已全部迁移为 Nuxt UI <UButton>，不再保留全局按钮工具类。 */
</style>
