<template>
    <header class="fixed top-0 left-0 right-0 z-100 bg-white border-b border-border">
        <div v-if="user?.must_change_password === true" class="bg-red-50 border-b border-red-200 text-red-700 px-6 py-2 text-sm flex items-center justify-between gap-3">
            <span>检测到当前密码为临时密码，首次登录后必须修改密码才能使用完整功能。</span>
            <NuxtLink to="/change-password" class="font-semibold no-underline text-red-700 hover:underline shrink-0">立即修改 →</NuxtLink>
        </div>
        <div class="w-full max-w-none mx-0 px-6 h-16 flex items-center">
            <NuxtLink to="/" class="flex items-center gap-2 no-underline text-xl font-bold text-primary shrink-0">
                <img :src="logoSrc" alt="Neuro OJ" class="size-7 rounded-md" />
                <span>Neuro OJ</span>
            </NuxtLink>
            <nav class="flex items-center gap-1 ml-6">
                <NuxtLink to="/" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">首页</NuxtLink>
                <NuxtLink to="/problems" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">题库</NuxtLink>
                <NuxtLink to="/submissions" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">提交记录</NuxtLink>
                <NuxtLink to="/ranking" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">榜单</NuxtLink>
                <NuxtLink to="/queue" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">队列</NuxtLink>
                <NuxtLink to="/about" class="px-3 py-1.5 text-sm text-text-secondary no-underline rounded-md transition-colors hover:bg-gray-100 hover:text-text" active-class="text-primary font-semibold">关于</NuxtLink>
            </nav>
            <div class="flex items-center gap-3 ml-auto">
                <template v-if="showAuthButtons">
                    <NuxtLink to="/login" class="btn-outline">登录</NuxtLink>
                    <NuxtLink to="/register" class="btn-primary">注册</NuxtLink>
                </template>
                <div v-else-if="isLoggedIn" class="relative flex items-center gap-3" @mouseenter="onMenuEnter" @mouseleave="onMenuLeave">
                    <NuxtLink :to="`/users/${user?.id}`" class="text-base text-text-secondary font-medium no-underline transition-colors hover:text-primary">{{ user?.username }}</NuxtLink>
                    <!-- 私信图标 + 未读徽标 -->
                    <NuxtLink
                      to="/messages"
                      class="relative flex items-center justify-center size-9 rounded-full text-text-secondary bg-none border-none cursor-pointer transition-colors hover:bg-primary-hover-bg hover:text-primary no-underline"
                    >
                      <Mail :size="20" />
                      <span
                        v-if="unreadCount > 0"
                        class="absolute -top-1 -right-1 z-50 flex items-center justify-center min-w-[20px] h-[20px] px-1 text-[11px] font-bold text-white bg-red-600 rounded-full leading-none shadow-sm"
                      >
                        {{ unreadCount > 99 ? "99+" : unreadCount }}
                      </span>
                    </NuxtLink>
                    <button class="flex items-center justify-center size-9 rounded-full text-text-secondary bg-none border-none cursor-pointer transition-colors hover:bg-primary-hover-bg hover:text-primary">
                        <User :size="22" />
                    </button>
                    <div v-show="showDropdown" class="absolute right-0 top-[calc(100%+8px)] bg-white border border-border rounded-lg min-w-[210px] p-1 shadow-dropdown z-200">
                        <NuxtLink to="/my/problems" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><BookOpen :size="16" />我的题目</NuxtLink>
                        <NuxtLink :to="`/users/${user?.id}`" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><Database :size="16" />数据</NuxtLink>
                        <NuxtLink to="/settings" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><Settings :size="16" />设置</NuxtLink>
                        <NuxtLink v-if="user?.role === 'admin'" to="/admin" class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-text no-underline rounded hover:bg-gray-100"><ShieldCheck :size="16" />管理后台</NuxtLink>
                        <div class="h-px bg-border my-1"></div>
                        <button class="flex items-center gap-2 w-full px-3.5 py-2 text-sm text-red-600 bg-none border-none rounded cursor-pointer text-left transition-colors hover:bg-red-50" @click="showLogoutConfirm = true"><LogOut :size="16" />登出</button>
                    </div>
                </div>
            </div>
        </div>

        <Transition name="fade">
            <div v-if="showLogoutConfirm" class="fixed inset-0 bg-black/40 flex items-center justify-center z-300" @click.self="showLogoutConfirm = false">
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
    </header>
</template>

<script setup lang="ts">
import { User, Database, Settings, LogOut, ShieldCheck, BookOpen, Mail } from "@lucide/vue"
import logoSrc from "~/assets/img/logo.jpg"

const route = useRoute()
const router = useRouter()
const { user, isLoggedIn, logout } = useAuth()

const unreadCount = ref(0)
let unreadPollTimer: ReturnType<typeof setInterval> | null = null

// 每 30 秒轮询未读数
async function fetchUnreadCount() {
  if (!isLoggedIn.value) return
  try {
    const res = await fetch("/api/v1/conversations/unread-count", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    const json = await res.json()
    console.log("[Navbar] unread_count:", json.unread_count)
    unreadCount.value = json.unread_count ?? 0
  } catch (e) {
    console.warn("[Navbar] fetch 失败:", e)
  }
}

watch(isLoggedIn, (val) => {
  if (!import.meta.client) return
  if (val) {
    fetchUnreadCount()
    if (!unreadPollTimer) {
      unreadPollTimer = setInterval(fetchUnreadCount, 30_000)
    }
  } else {
    if (unreadPollTimer) clearInterval(unreadPollTimer)
    unreadPollTimer = null
    unreadCount.value = 0
  }
}, { immediate: true })

const showAuthButtons = computed(() => !isLoggedIn.value && !route.path.startsWith("/login") && !route.path.startsWith("/register"))

const showDropdown = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | null = null

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

onMounted(() => {
  document.addEventListener("keydown", onKeydown)
})
onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown)
  if (unreadPollTimer) clearInterval(unreadPollTimer)
})

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
