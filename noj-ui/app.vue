<template>
    <NuxtLayout>
        <BanBanner v-if="ipBanned" type="ip" :ip-info="ipBanInfo" />
        <BanBanner v-if="userBanned" type="user" :user-info="userBanInfo" />
        <NuxtPage />
    </NuxtLayout>
</template>

<script setup lang="ts">
import BanBanner from "~/components/BanBanner.vue"
import { useBanStatus } from "~/composables/useBanStatus"

const { ipBanned, ipBanInfo, userBanned, userBanInfo, fetch } = useBanStatus()

// 首次加载时获取封禁状态
if (import.meta.client) {
  fetch()
}
</script>

<style>
/* JetBrains Mono 字体（编辑器专用） */
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');

:root {
    --c-primary: #2563eb; --c-primary-dark: #1d4ed8; --c-primary-light: #3b82f6;
    --c-primary-bg: #eff6ff; --c-primary-hover-bg: #dbeafe; --c-primary-active-bg: #bfdbfe; --c-primary-text: #1e40af;
    --c-bg-dark: #0f172a; --c-bg-dark-2: #1e293b; --c-bg-dark-3: #334155;
    --c-success-text: #137333; --c-info-text: #1967d2; --c-warning-text: #92400e; --c-error-text: #b91c1c;
    --c-text: #1e293b; --c-text-secondary: #64748b; --c-text-muted: #94a3b8;
    --c-border: #e2e8f0; --c-bg-page: #f8fafc; --c-white: #ffffff;
}

.editor-dark {
  --c-bg-page: #0f172a;
  --c-white: #1e293b;
  --c-border: #334155;
  --c-text: #e2e8f0;
  --c-text-secondary: #94a3b8;
  --c-text-muted: #64748b;
  --c-primary: #3b82f6;
  --c-primary-hover-bg: #1e3a8a;
  --c-primary-bg: #1e293b;
}

.editor-dark .prose-neuro {
  --tw-prose-body: #e2e8f0;
  --tw-prose-headings: #e2e8f0;
  --tw-prose-links: #60a5fa;
  --tw-prose-code: #f472b6;
}

/* CSS 变量（设计 Token）统一在 :root 中定义，tailwind.config.ts 通过 var() 引用。
   全局重置由 Tailwind Preflight 提供，字体和背景通过 Tailwind 类在 layouts 中应用。 */
</style>