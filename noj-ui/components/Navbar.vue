<template>
    <header class="navbar">
        <div class="container">
            <NuxtLink to="/" class="logo">
                <img :src="logoSrc" alt="Neuro OJ" class="logo-img" />
                <span class="logo-text">Neuro OJ</span>
            </NuxtLink>
            <nav class="nav-links">
                <NuxtLink to="/" class="nav-link">首页</NuxtLink>
                <NuxtLink to="/problems" class="nav-link">题库</NuxtLink>
                <NuxtLink to="/queue" class="nav-link">队列</NuxtLink>
                <NuxtLink to="/about" class="nav-link">关于</NuxtLink>
            </nav>
            <div class="nav-actions">
                <template v-if="showAuthButtons">
                    <NuxtLink to="/login" class="btn btn-outline">登录</NuxtLink>
                    <NuxtLink to="/register" class="btn btn-primary">注册</NuxtLink>
                </template>
                <div v-else-if="isLoggedIn" class="user-menu" @mouseenter="onMenuEnter" @mouseleave="onMenuLeave">
                    <NuxtLink :to="`/users/${user?.id}`" class="user-name-link">{{ user?.username }}</NuxtLink>
                    <button class="user-btn">
                        <User class="user-icon" :size="22" />
                    </button>
                    <div v-show="showDropdown" class="dropdown">
                        <NuxtLink :to="`/users/${user?.id}`" class="dropdown-item-link"><Database :size="16" />数据</NuxtLink>
                        <NuxtLink to="/settings" class="dropdown-item-link"><Settings :size="16" />设置</NuxtLink>
                        <NuxtLink v-if="user?.role === 'admin'" to="/admin" class="dropdown-item-link"><ShieldCheck :size="16" />管理后台</NuxtLink>
                        <div class="dropdown-divider"></div>
                        <button class="dropdown-item dropdown-danger" @click="showLogoutConfirm = true"><LogOut :size="16" />登出</button>
                    </div>
                </div>
            </div>
        </div>

        <Transition name="fade">
            <div v-if="showLogoutConfirm" class="confirm-overlay" @click.self="showLogoutConfirm = false">
                <div class="confirm-dialog">
                    <h2>确认登出</h2>
                    <p>确定要登出当前账号吗？</p>
                    <div class="confirm-actions">
                        <button ref="cancelBtnRef" class="btn btn-cancel" @click="showLogoutConfirm = false">取消</button>
                        <button class="btn btn-danger" @click="handleLogout">确认登出</button>
                    </div>
                </div>
            </div>
        </Transition>
    </header>
</template>

<script setup lang="ts">
import { User, Database, Settings, LogOut, ShieldCheck } from "@lucide/vue"
import logoSrc from "~/assets/img/logo.jpg"

const route = useRoute()
const router = useRouter()
const { user, isLoggedIn, logout } = useAuth()

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

onMounted(() => document.addEventListener("keydown", onKeydown))
onUnmounted(() => document.removeEventListener("keydown", onKeydown))

function handleLogout() {
    logout()
    showLogoutConfirm.value = false
    router.replace("/")
}
</script>

<style scoped>
.navbar {
    background: var(--c-white);
    border-bottom: 1px solid var(--c-border);
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
}

.container {
    width: 100%;
    max-width: none;
    margin: 0;
    padding: 0 24px;
    height: 64px;
    display: flex;
    align-items: center;
}

.logo {
    display: flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    font-size: 20px;
    font-weight: 700;
    color: var(--c-primary);
    flex-shrink: 0;
}

.logo-img {
    width: 28px;
    height: 28px;
    border-radius: 6px;
}

.nav-links {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 24px;
}

.nav-link {
    padding: 6px 12px;
    font-size: 14px;
    color: var(--c-text-secondary);
    text-decoration: none;
    border-radius: 6px;
    transition: background 0.15s, color 0.15s;
}

.nav-link:hover {
    background: var(--c-bg-hover, #f5f5f5);
    color: var(--c-text);
}

.nav-link.router-link-active {
    color: var(--c-primary);
    font-weight: 600;
}

.nav-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
}

.btn {
    padding: 10px 24px;
    font-size: 15px;
    line-height: 1;
}

.btn-outline {
    color: var(--c-primary);
    border: 1.5px solid var(--c-primary);
    background: transparent;
}

.btn-outline:hover {
    background: var(--c-primary);
    color: var(--c-white);
}

.user-menu {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
}

.user-name {
    font-size: 16px;
    color: var(--c-text-secondary);
    font-weight: 500;
}

.user-name-link {
    font-size: 16px;
    color: var(--c-text-secondary);
    font-weight: 500;
    text-decoration: none;
    transition: color 0.2s;
}

.user-name-link:hover {
    color: var(--c-primary);
}

.user-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: var(--c-text-secondary);
    background: none;
    border: none;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
}

.user-btn:hover {
    background: var(--c-primary-hover-bg);
    color: var(--c-primary);
}

.dropdown {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    background: var(--c-white);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    min-width: 210px;
    padding: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    z-index: 200;
}

.dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 14px;
    font-size: 14px;
    color: var(--c-text);
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s;
}

.dropdown-item-link {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 14px;
    font-size: 14px;
    color: var(--c-text);
    text-decoration: none;
    border-radius: 4px;
    transition: background 0.15s;
}

.dropdown-item-link:hover {
    background: var(--c-bg-hover, #f5f5f5);
}

.dropdown-item:hover {
    background: var(--c-bg-hover, #f5f5f5);
}

.dropdown-divider {
    height: 1px;
    background: var(--c-border);
    margin: 4px 0;
}

.dropdown-danger {
    color: #dc2626;
}

.dropdown-danger:hover {
    background: #fef2f2;
}

.confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
}

.confirm-dialog {
    background: var(--c-white);
    border-radius: 12px;
    padding: 60px;
    text-align: center;
    max-width: 380px;
    width: calc(100% - 48px);
}

.confirm-dialog h2 {
    font-size: 24px;
    margin-bottom: 12px;
}

.confirm-dialog p {
    font-size: 17px;
    color: var(--c-text-secondary);
    margin-bottom: 24px;
}

.confirm-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
}

.btn {
    padding: 10px 24px;
    font-size: 15px;
    line-height: 1;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s, color 0.2s, border-color 0.2s;
}

.confirm-dialog .btn {
    padding: 12px 28px;
    font-size: 16px;
    border-radius: 8px;
}

.btn-cancel {
    color: var(--c-text-secondary);
    border: 1.5px solid var(--c-border);
    background: transparent;
}

.btn-cancel:hover {
    border-color: var(--c-text-secondary);
}

.btn-danger {
    color: #fff;
    background: #dc2626;
    border: 1.5px solid #dc2626;
}

.btn-danger:hover {
    background: #b91c1c;
    border-color: #b91c1c;
}

.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
    opacity: 0;
}

</style>
