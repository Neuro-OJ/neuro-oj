<template>
    <template v-if="!isLoggedIn">
        <UButton color="primary" variant="outline" class="px-3.5 py-1.5 text-sm !rounded-full" to="/login">登录</UButton>
        <UButton color="primary" class="px-3.5 py-1.5 text-sm !rounded-full" to="/register">注册</UButton>
    </template>
    <div v-else class="relative">
        <div class="flex items-center gap-3">
            <NuxtLink :to="`/users/${user?.id}`" class="hidden sm:inline text-base text-text-secondary font-medium no-underline transition-colors hover:text-primary">{{ user?.username }}</NuxtLink>
            <button
                type="button"
                ref="menuButtonRef"
                class="flex items-center justify-center size-9 rounded-full text-text-secondary bg-none border-none cursor-pointer transition-colors hover:bg-primary-hover-bg hover:text-primary"
                aria-label="用户菜单"
                aria-haspopup="menu"
                :aria-expanded="showDropdown"
                @click="toggleMenu"
            >
                <UIcon name="i-lucide-user" class="size-[22px]" />
            </button>
        </div>
        <div
            v-show="showDropdown"
            role="menu"
            aria-label="用户菜单"
            class="absolute right-0 top-[calc(100%+8px)] bg-white border border-border rounded-lg min-w-[210px] p-1 shadow-dropdown z-[200]"
            @keydown.escape="closeMenu"
        >
            <div class="px-3.5 py-2 border-b border-border mb-1">
                <p class="text-sm font-semibold text-text truncate">{{ user?.username }}</p>
            </div>
            <NuxtLink ref="firstItemRef" to="/my/problems" role="menuitem" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100" @click="closeMenu"><UIcon name="i-lucide-book-open" class="size-4" />我的题目</NuxtLink>
            <NuxtLink to="/messages" role="menuitem" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100 relative" @click="closeMenu"><UIcon name="i-lucide-mail" class="size-4" />消息<span v-if="unreadCount > 0" class="ml-auto bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">{{ unreadCount > 99 ? "99+" : unreadCount }}</span></NuxtLink>
            <NuxtLink :to="`/users/${user?.id}`" role="menuitem" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100" @click="closeMenu"><UIcon name="i-lucide-database" class="size-4" />数据</NuxtLink>
            <NuxtLink to="/settings" role="menuitem" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100" @click="closeMenu"><UIcon name="i-lucide-settings" class="size-4" />设置</NuxtLink>
            <NuxtLink v-if="user?.role === 'admin'" to="/admin" role="menuitem" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100" @click="closeMenu"><UIcon name="i-lucide-shield-check" class="size-4" />管理后台</NuxtLink>
            <div class="h-px bg-border my-1"></div>
            <button
                type="button"
                role="menuitem"
                class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-red-600 bg-none border-none rounded cursor-pointer text-left transition-colors hover:bg-red-50"
                @click="handleLogout"
            >
                <UIcon name="i-lucide-log-out" class="size-4" />
                登出
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
const router = useRouter()
const { user, isLoggedIn, logout } = useAuth()
const { dialog } = useDialog()
const { api } = useApi()

// ── 下拉菜单：点击切换 + 键盘可达（WCAG 2.1.1） ──
const menuButtonRef = ref<HTMLButtonElement | null>(null)
const firstItemRef = ref<HTMLElement | null>(null)
const showDropdown = ref(false)

function openMenu() {
    showDropdown.value = true
    nextTick(() => firstItemRef.value?.focus())
}

function closeMenu() {
    showDropdown.value = false
    menuButtonRef.value?.focus()
}

function toggleMenu() {
    showDropdown.value ? closeMenu() : openMenu()
}

// 点击菜单外部关闭
function onDocumentClick(e: MouseEvent) {
    const el = menuButtonRef.value?.closest(".relative")
    if (el && !el.contains(e.target as Node)) closeMenu()
}

onMounted(() => document.addEventListener("click", onDocumentClick))
onUnmounted(() => document.removeEventListener("click", onDocumentClick))

// ── 未读消息计数（30s 轮询） ──
const unreadCount = ref(0)
let unreadPollTimer: ReturnType<typeof setInterval> | null = null

async function fetchUnreadCount() {
    try {
        const res = await api.get<{ data: { unread_count: number } }>(
            "/api/v1/conversations/unread-count",
            { silent: true },
        )
        unreadCount.value = res.data?.unread_count ?? 0
    } catch {
        // 静默失败
    }
}

watch(isLoggedIn, (val) => {
    if (val) {
        fetchUnreadCount()
        unreadPollTimer = setInterval(fetchUnreadCount, 30_000)
    } else {
        if (unreadPollTimer) clearInterval(unreadPollTimer)
        unreadCount.value = 0
    }
})

onMounted(() => {
    if (isLoggedIn.value) {
        fetchUnreadCount()
        unreadPollTimer = setInterval(fetchUnreadCount, 30_000)
    }
})

onUnmounted(() => {
    if (unreadPollTimer) clearInterval(unreadPollTimer)
})

// ── 登出：走统一的 useDialog 确认弹窗 ──
async function handleLogout() {
    closeMenu()
    const ok = await dialog.confirm("确定要登出当前账号吗？", {
        title: "确认登出",
        danger: true,
        confirmText: "确认登出",
    })
    if (!ok) return
    await logout()
    router.replace("/")
}
</script>
