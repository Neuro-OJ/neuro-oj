<template>
    <NuxtLayout>
        <BanBanner v-if="ipBanned" type="ip" :ip-info="ipBanInfo" />
        <BanBanner v-if="userBanned" type="user" :user-info="userBanInfo" />
        <NuxtPage />
    </NuxtLayout>
    <!-- 全文搜索 palette（issue #100），全局单例 -->
    <SearchPalette />
</template>

<script setup lang="ts">
import BanBanner from "~/components/BanBanner.vue"
import SearchPalette from "~/components/shared/SearchPalette.vue"
import { useBanStatus } from "~/composables/useBanStatus"

const { ipBanned, ipBanInfo, userBanned, userBanInfo, fetch } = useBanStatus()
const { toggle } = useSearchPalette()

// 首次加载时获取封禁状态
if (import.meta.client) {
    fetch()
}

// 全局快捷键：Ctrl/Cmd + K 切换搜索面板
// 跳过 Monaco / textarea / input 内部的按键，避免与代码编辑器冲突
if (import.meta.client) {
    function isEditable(el: EventTarget | null): boolean {
        if (!(el instanceof HTMLElement)) return false
        if (el.isContentEditable) return true
        const tag = el.tagName
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
    }

    function onKeydown(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            if (isEditable(e.target)) return
            e.preventDefault()
            toggle()
        }
    }

    onMounted(() => {
        window.addEventListener("keydown", onKeydown)
    })
    onUnmounted(() => {
        window.removeEventListener("keydown", onKeydown)
    })
}
</script>

<style>
:root {
    --c-primary: #2563eb; --c-primary-dark: #1d4ed8; --c-primary-light: #3b82f6;
    --c-primary-bg: #eff6ff; --c-primary-hover-bg: #dbeafe; --c-primary-active-bg: #bfdbfe; --c-primary-text: #1e40af;
    --c-bg-dark: #0f172a; --c-bg-dark-2: #1e293b; --c-bg-dark-3: #334155;
    --c-success-text: #137333; --c-info-text: #1967d2; --c-warning-text: #92400e; --c-error-text: #b91c1c;
    --c-text: #1e293b; --c-text-secondary: #64748b; --c-text-muted: #94a3b8;
    --c-border: #e2e8f0; --c-bg-page: #f8fafc; --c-white: #ffffff;
}
/* CSS 变量（设计 Token）统一在 :root 中定义，tailwind.config.ts 通过 var() 引用。
   全局重置由 Tailwind Preflight 提供，字体和背景通过 Tailwind 类在 layouts 中应用。 */
</style>