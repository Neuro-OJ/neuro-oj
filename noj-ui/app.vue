<template>
    <UApp>
        <NuxtLayout>
            <BanBanner v-if="ipBanned" type="ip" :ip-info="ipBanInfo" />
            <BanBanner v-if="userBanned" type="user" :user-info="userBanInfo" />
            <NuxtPage />
        </NuxtLayout>
    </UApp>
</template>

<script setup lang="ts">
import BanBanner from "~/components/BanBanner.vue"
import { useBanStatus } from "~/composables/useBanStatus"

const { ipBanned, ipBanInfo, userBanned, userBanInfo, fetch } = useBanStatus()

// 首次加载时获取封禁状态
if (import.meta.client) {
  fetch()
}

// ─── 页面级标题（WCAG 2.4.2）：按路由路径生成描述性 <title>，替代全站统一标题 ───
const route = useRoute()

const TITLE_RULES: { match: string; title: string }[] = [
  { match: "/login", title: "登录 - Neuro OJ" },
  { match: "/register", title: "注册 - Neuro OJ" },
  { match: "/forgot-password", title: "忘记密码 - Neuro OJ" },
  { match: "/reset-password", title: "重置密码 - Neuro OJ" },
  { match: "/change-password", title: "修改密码 - Neuro OJ" },
  { match: "/admin", title: "管理后台 - Neuro OJ" },
  { match: "/editor", title: "做题 - Neuro OJ" },
  { match: "/problems", title: "题库 - Neuro OJ" },
  { match: "/my", title: "我的 - Neuro OJ" },
  { match: "/submissions", title: "提交历史 - Neuro OJ" },
  { match: "/ranking", title: "榜单 - Neuro OJ" },
  { match: "/queue", title: "评测队列 - Neuro OJ" },
  { match: "/contests", title: "竞赛 - Neuro OJ" },
  { match: "/community", title: "社区 - Neuro OJ" },
  { match: "/messages", title: "私信 - Neuro OJ" },
  { match: "/search", title: "搜索 - Neuro OJ" },
  { match: "/settings", title: "设置 - Neuro OJ" },
  { match: "/users", title: "用户 - Neuro OJ" },
  { match: "/about", title: "关于 - Neuro OJ" },
  { match: "/", title: "Neuro OJ" },
]

function resolvePageTitle(path: string): string {
  // 精确匹配优先，其次前缀匹配（动态路由如 /problems/1001、/submissions/{id}）
  const exact = TITLE_RULES.find((r) => r.match === path)
  if (exact) return exact.title
  const byPrefix = TITLE_RULES.find((r) => path.startsWith(r.match))
  return byPrefix?.title ?? "Neuro OJ"
}

useHead({ title: computed(() => resolvePageTitle(route.path)) })
</script>

<style>
:root {
    --c-primary: #2563eb; --c-primary-dark: #1d4ed8; --c-primary-light: #3b82f6;
    --c-primary-bg: #eff6ff; --c-primary-hover-bg: #dbeafe; --c-primary-active-bg: #bfdbfe; --c-primary-text: #1e40af;
    --c-bg-dark: #0f172a; --c-bg-dark-2: #1e293b; --c-bg-dark-3: #334155;
    --c-success-text: #137333; --c-info-text: #1967d2; --c-warning-text: #92400e; --c-error-text: #b91c1c;
    --c-text: #1e293b; --c-text-secondary: #64748b; --c-text-muted: #64748b;
    --header-h: 64px;
    --c-border: #e2e8f0; --c-bg-page: #f8fafc; --c-white: #ffffff; --c-text-on-color: #ffffff;
    /* 深色背景上的正文色（footer 等）：#64748b on #0f172a 仅 3.75:1，不达 WCAG AA 4.5:1 */
    --c-text-on-dark: #94a3b8;
}

.editor-dark {
  --c-bg-page: #0f172a;
  --c-white: #1e293b;
  --c-border: #334155;
  --c-text: #e2e8f0;
  --c-text-secondary: #94a3b8;
  /* #94a3b8 on #1e293b = 6.96:1，替代原 #64748b（3.07:1 不达 AA） */
  --c-text-muted: #94a3b8;
  /* #60a5fa on #1e293b = 5.2:1，替代原 #3b82f6（3.98:1 仅大字达标） */
  --c-primary: #60a5fa;
  --c-primary-hover-bg: #1e3a8a;
  --c-primary-bg: #1e293b;
}

.editor-dark .prose-neuro {
  --tw-prose-body: #e2e8f0;
  --tw-prose-headings: #e2e8f0;
  --tw-prose-links: #60a5fa;
  --tw-prose-code: #f472b6;
}

/* CSS 变量（设计 Token）统一在 :root 中定义，main.css 的 @theme 通过 var() 引用。
   全局重置由 Tailwind Preflight 提供，字体和背景通过 Tailwind 类在 layouts 中应用。
   通用按钮已全部迁移为 Nuxt UI <UButton>，不再保留全局按钮工具类。 */
</style>
