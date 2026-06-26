<template>
    <div class="w-full max-w-[380px] relative">
        <Transition name="slide">
            <div v-if="error" class="bg-red-50 border border-red-200 text-red-700 rounded-md px-3.5 py-2.5 text-sm flex items-center justify-between gap-3 fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]">
                <span>{{ error }}</span>
                <button class="bg-transparent border-0 text-red-700 cursor-pointer text-base p-0.5 leading-none opacity-70 shrink-0 hover:opacity-100" @click="clearError">&#10005;</button>
            </div>
        </Transition>
        <div class="bg-white border border-border rounded-lg p-8">
            <h1 class="text-[22px] font-bold text-center mb-6 text-text animate-[fadeInUp_0.5s_ease_both]">注册</h1>

            <form @submit.prevent="handleRegister">
                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.05s_both]">
                    <label for="username" class="block text-sm font-semibold text-text mb-1">用户名</label>
                    <div class="relative flex items-center">
                        <User class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="username"
                            v-model="form.username"
                            type="text"
                            placeholder="3-30 位字母、数字或下划线"
                            autocomplete="username"
                            :disabled="loading"
                            class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
                            @focus="fieldErrors.username = ''"
                        />
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.username" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-[13px] text-red-700"><span>{{ fieldErrors.username }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.1s_both]">
                    <label for="email" class="block text-sm font-semibold text-text mb-1">邮箱</label>
                    <div class="relative flex items-center">
                        <Mail class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="email"
                            v-model="form.email"
                            type="email"
                            placeholder="请输入邮箱地址"
                            autocomplete="email"
                            :disabled="loading"
                            class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
                            @focus="fieldErrors.email = ''"
                        />
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.email" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-[13px] text-red-700"><span>{{ fieldErrors.email }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <!-- TODO 验证码 -->

                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.15s_both]">
                    <label for="password" class="block text-sm font-semibold text-text mb-1">密码</label>
                    <div class="relative flex items-center">
                        <Lock class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="password"
                            v-model="form.password"
                            :type="showPassword ? 'text' : 'password'"
                            placeholder="至少 12 位，需包含字母和数字"
                            autocomplete="new-password"
                            :disabled="loading"
                            class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
                            @focus="fieldErrors.password = ''"
                        />
                        <button type="button" class="absolute right-3 bg-transparent border-0 text-text-muted cursor-pointer p-0 flex items-center hover:text-text-secondary" @click="showPassword = !showPassword" tabindex="-1">
                            <span class="flex items-center justify-center w-[18px] h-[18px]">
                                <Transition name="icon" mode="out-in">
                                    <EyeOff v-if="!showPassword" :size="18" key="off" />
                                    <Eye v-else :size="18" key="on" />
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.password" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-[13px] text-red-700"><span>{{ fieldErrors.password }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.2s_both]">
                    <label for="confirmPassword" class="block text-sm font-semibold text-text mb-1">确认密码</label>
                    <div class="relative flex items-center">
                        <Lock class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="confirmPassword"
                            v-model="form.confirmPassword"
                            :type="showConfirmPassword ? 'text' : 'password'"
                            placeholder="再次输入密码"
                            autocomplete="new-password"
                            maxlength="30"
                            :disabled="loading"
                            class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
                            @focus="fieldErrors.confirmPassword = ''"
                        />
                        <button type="button" class="absolute right-3 bg-transparent border-0 text-text-muted cursor-pointer p-0 flex items-center hover:text-text-secondary" @click="showConfirmPassword = !showConfirmPassword" tabindex="-1">
                            <span class="flex items-center justify-center w-[18px] h-[18px]">
                                <Transition name="icon" mode="out-in">
                                    <EyeOff v-if="!showConfirmPassword" :size="18" key="off" />
                                    <Eye v-else :size="18" key="on" />
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.confirmPassword" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-[13px] text-red-700"><span>{{ fieldErrors.confirmPassword }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <button type="submit" class="inline-flex items-center justify-center font-semibold no-underline cursor-pointer rounded-lg transition-all duration-200 bg-primary text-white border border-primary hover:bg-primary-dark hover:border-primary-dark w-full py-2.5 text-sm mt-1 animate-[fadeInUp_0.5s_ease_0.25s_both] disabled:opacity-60 disabled:cursor-not-allowed" :disabled="loading">
                    <Loader2 v-if="loading" class="animate-spin-slow mr-1.5" :size="18" />
                    {{ loading ? '注册中...' : '注册' }}
                </button>
            </form>

            <p class="text-center mt-5 text-sm text-text-secondary animate-[fadeInUp_0.5s_ease_0.3s_both]">
                已有账号？<NuxtLink to="/login" class="text-primary no-underline font-semibold hover:underline">立即登录</NuxtLink>
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { User, Mail, Lock, Eye, EyeOff, Loader2, X } from "@lucide/vue"

definePageMeta({ layout: "auth" })

const router = useRouter()
const auth = useAuth()

const form = reactive({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
})
const loading = ref(false)
const error = ref("")
const showPassword = ref(false)
const showConfirmPassword = ref(false)

let errorTimer: ReturnType<typeof setTimeout> | null = null

function setError(msg: string) {
    error.value = msg
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = setTimeout(clearError, 3000)
}

function clearError() {
    error.value = ""
    if (errorTimer) clearTimeout(errorTimer)
}

const fieldErrors = reactive({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
})

function validate(): boolean {
    let valid = true
    fieldErrors.username = ""
    fieldErrors.email = ""
    fieldErrors.password = ""
    fieldErrors.confirmPassword = ""

    if (!form.username.trim()) {
        fieldErrors.username = "请输入用户名"
        valid = false
    } else if (!/^[a-zA-Z0-9_]{3,30}$/.test(form.username.trim())) {
        fieldErrors.username = "用户名仅允许字母、数字和下划线，长度 3-30"
        valid = false
    }

    if (!form.email.trim()) {
        fieldErrors.email = "请输入邮箱地址"
        valid = false
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
        fieldErrors.email = "邮箱格式不正确"
        valid = false
    }

    if (!form.password) {
        fieldErrors.password = "请输入密码"
        valid = false
    } else if (form.password.length < 12) {
        fieldErrors.password = "密码长度不能少于 12 位"
        valid = false
    } else if (!/[a-z]/.test(form.password)) {
        fieldErrors.password = "密码必须包含至少一个小写字母"
        valid = false
    } else if (!/[A-Z]/.test(form.password)) {
        fieldErrors.password = "密码必须包含至少一个大写字母"
        valid = false
    } else if (!/[0-9]/.test(form.password)) {
        fieldErrors.password = "密码必须包含至少一个数字"
        valid = false
    }

    if (!form.confirmPassword) {
        fieldErrors.confirmPassword = "请确认密码"
        valid = false
    } else if (form.password !== form.confirmPassword) {
        fieldErrors.confirmPassword = "两次输入的密码不一致"
        valid = false
    }

    return valid
}

async function handleRegister() {
    setError("")

    if (!validate()) return

    loading.value = true
    try {
        // 先注册
        await auth.register(form.username.trim(), form.email.trim(), form.password)
    } catch (e: any) {
        setError(typeof e.data?.error === "string" ? e.data.error : `错误代码: ${e.status || 502}`)
        loading.value = false
        return
    }

    // 注册成功后自动登录
    try {
        await auth.login(form.username.trim(), form.password)
        router.replace("/")
    } catch {
        // 注册成功但登录失败 → 引导用户手动登录
        router.replace("/login?registered=1")
    } finally {
        loading.value = false
    }
}
</script>

<style>
/* Vue Transition: slide (用于 error banner) */
.slide-enter-active {
    transition: all 0.3s ease-out;
}
.slide-leave-active {
    transition: all 0.2s ease-in;
}
.slide-enter-from {
    transform: translateX(-50%) translateY(-20px);
    opacity: 0;
}
.slide-leave-to {
    transform: translateX(-50%) translateY(-20px);
    opacity: 0;
}

/* Vue Transition: drop (用于 field errors) */
.drop-enter-active {
    animation: dropIn 0.25s ease both;
}
.drop-leave-active {
    animation: dropOut 0.2s ease both;
}

@keyframes dropIn {
    from {
        opacity: 0;
        transform: translateY(-8px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes dropOut {
    from {
        opacity: 1;
        transform: translateY(0);
    }
    to {
        opacity: 0;
        transform: translateY(8px);
    }
}

/* Vue Transition: fade (保留用于可能的将来 overlay) */
.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
    opacity: 0;
}

/* Vue Transition: icon (用于密码可见切换) */
.icon-enter-active,
.icon-leave-active {
    transition: opacity 0.18s linear, transform 0.18s linear;
}
.icon-enter-from {
    opacity: 0;
    transform: translate(-6px, -6px);
}
.icon-leave-to {
    opacity: 0;
    transform: translate(6px, 6px);
}

/* @keyframes fadeInUp (用于入场动画) */
@keyframes fadeInUp {
    from {
        opacity: 0;
        transform: translateY(12px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
</style>
