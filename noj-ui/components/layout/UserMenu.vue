<template>
    <template v-if="!isLoggedIn">
        <NuxtLink to="/login" class="btn-outline px-3.5 py-1.5 text-sm !rounded-full">登录</NuxtLink>
        <NuxtLink to="/register" class="btn-primary px-3.5 py-1.5 text-sm !rounded-full">注册</NuxtLink>
    </template>
    <div v-else class="relative flex items-center gap-3" @mouseenter="onMenuEnter" @mouseleave="onMenuLeave">
        <NuxtLink :to="`/users/${user?.id}`" class="text-base text-text-secondary font-medium no-underline transition-colors hover:text-primary">{{ user?.username }}</NuxtLink>
        <button class="flex items-center justify-center size-9 rounded-full text-text-secondary bg-none border-none cursor-pointer transition-colors hover:bg-primary-hover-bg hover:text-primary">
            <User :size="22" />
        </button>
        <div v-show="showDropdown" class="absolute right-0 top-[calc(100%+8px)] bg-white border border-border rounded-lg min-w-[210px] p-1 shadow-dropdown z-[200]">
            <NuxtLink to="/my/problems" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><BookOpen :size="16" />我的题目</NuxtLink>
            <NuxtLink to="/messages" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100 relative"><Mail :size="16" />消息<span v-if="unreadCount > 0" class="ml-auto bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">{{ unreadCount > 99 ? "99+" : unreadCount }}</span></NuxtLink>
            <NuxtLink :to="`/users/${user?.id}`" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><Database :size="16" />数据</NuxtLink>
            <NuxtLink to="/settings" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><Settings :size="16" />设置</NuxtLink>
            <NuxtLink v-if="user?.role === 'admin'" to="/admin" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><ShieldCheck :size="16" />管理后台</NuxtLink>
            <div class="h-px bg-border my-1"></div>
            <button class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-red-600 bg-none border-none rounded cursor-pointer text-left transition-colors hover:bg-red-50" @click="showLogoutConfirm = true"><LogOut :size="16" />登出</button>
        </div>

        <Transition name="fade">
            <div v-if="showLogoutConfirm" class="fixed inset-0 bg-black/40 flex items-center justify-center z-[300]" @click.self="showLogoutConfirm = false">
                <div class="bg-white rounded-xl px-15 py-16 text-center max-w-[380px] w-[calc(100%-48px)]">
                    <h2 class="text-2xl font-bold mb-3">确认登出</h2>
                    <p class="text-[17px] text-text-secondary mb-6">确定要登出当前账号吗？</p>
                    <div class="flex gap-2.5 justify-center">
                        <button ref="cancelBtnRef" class="px-7 py-3 text-base rounded-lg text-text-secondary border border-border bg-transparent cursor-pointer transition-colors hover:border-text-secondary" @click="showLogoutConfirm = false">取消</button>
                        <button class="px-7 py-3 text-base rounded-lg text-white bg-red-600 border border-red-600 cursor-pointer transition-colors hover:bg-red-700" @click="handleLogout">确认登出</button>
                    </div>
                </div>
            </div>
        </Transition>
    </div>
</template>

<script setup lang="ts">
import { User, Database, Settings, LogOut, ShieldCheck, BookOpen, Mail } from "@lucide/vue"

const route = useRoute()
const router = useRouter()
const { user, isLoggedIn, logout } = useAuth()

const showDropdown = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | null = null

// 未读消息计数（30s 轮询）
const unreadCount = ref(0)
let unreadPollTimer: ReturnType<typeof setInterval> | null = null

async function fetchUnreadCount() {
  try {
    const res = await $fetch<{ data: { unread_count: number } }>("/api/v1/conversations/unread-count")
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

function onMenuEnter() {
    if (hideTimer) clearTimeout(hideTimer)
    showDropdown.value = true
}

function onMenuLeave() {
    hideTimer = setTimeout(() => {
        showDropdown.value = false
    }, 100)
}

const showLogoutConfirm = ref(false)
const cancelBtnRef = ref<HTMLButtonElement>()

watch(showLogoutConfirm, (val) => {
    if (val) {
        nextTick(() => cancelBtnRef.value?.focus())
    }
})

function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && showLogoutConfirm.value) {
        showLogoutConfirm.value = false
    }
}

onMounted(() => document.addEventListener("keydown", onKeydown))
onUnmounted(() => document.removeEventListener("keydown", onKeydown))

async function handleLogout() {
    await logout()
    showLogoutConfirm.value = false
    router.replace("/")
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
    opacity: 0;
}
</style>