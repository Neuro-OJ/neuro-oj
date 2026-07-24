<template>
    <div class="w-full max-w-[380px] relative">
        <Transition name="slide">
            <div v-if="error" class="bg-red-50 border border-red-200 text-red-700 rounded-md px-3.5 py-2.5 text-sm flex items-center justify-between gap-3 fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]">
                <span>{{ error }}</span>
                <button class="bg-transparent border-0 text-red-700 cursor-pointer text-base p-0.5 leading-none opacity-70 shrink-0 hover:opacity-100" @click="clearError">&#10005;</button>
            </div>
        </Transition>
        <div class="bg-white border border-border rounded-lg p-8">
            <h1 class="text-[22px] font-bold text-center mb-6 text-text animate-[fadeInUp_0.5s_ease_both]">修改密码</h1>

            <form @submit.prevent="handleSubmit">
                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.05s_both]">
                    <label for="oldPassword" class="block text-sm font-semibold text-text mb-1">原密码</label>
                    <div class="relative flex items-center">
                        <Lock class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="oldPassword"
                            v-model="form.oldPassword"
                            :type="showOldPassword ? 'text' : 'password'"
                            placeholder="请输入当前密码"
                            autocomplete="current-password"
                            :disabled="loading"
                            class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
                            @focus="fieldErrors.oldPassword = ''"
                        />
                        <button type="button" class="absolute right-3 bg-transparent border-0 text-text-muted cursor-pointer p-0 flex items-center hover:text-text-secondary" @click="showOldPassword = !showOldPassword" tabindex="-1">
                            <span class="flex items-center justify-center w-[18px] h-[18px]">
                                <Transition name="icon" mode="out-in">
                                    <EyeOff v-if="!showOldPassword" :size="18" key="off" />
                                    <Eye v-else :size="18" key="on" />
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.oldPassword" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-[13px] text-red-700"><span>{{ fieldErrors.oldPassword }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.1s_both]">
                    <label for="newPassword" class="block text-sm font-semibold text-text mb-1">新密码</label>
                    <div class="relative flex items-center">
                        <Lock class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="newPassword"
                            v-model="form.newPassword"
                            :type="showNewPassword ? 'text' : 'password'"
                            placeholder="至少 12 位，需包含字母和数字"
                            autocomplete="new-password"
                            :disabled="loading"
                            class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
                            @focus="fieldErrors.newPassword = ''"
                        />
                        <button type="button" class="absolute right-3 bg-transparent border-0 text-text-muted cursor-pointer p-0 flex items-center hover:text-text-secondary" @click="showNewPassword = !showNewPassword" tabindex="-1">
                            <span class="flex items-center justify-center w-[18px] h-[18px]">
                                <Transition name="icon" mode="out-in">
                                    <EyeOff v-if="!showNewPassword" :size="18" key="off" />
                                    <Eye v-else :size="18" key="on" />
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.newPassword" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-[13px] text-red-700"><span>{{ fieldErrors.newPassword }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.15s_both]">
                    <label for="confirmPassword" class="block text-sm font-semibold text-text mb-1">确认密码</label>
                    <div class="relative flex items-center">
                        <Lock class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="confirmPassword"
                            v-model="form.confirmPassword"
                            :type="showConfirmPassword ? 'text' : 'password'"
                            placeholder="再次输入新密码"
                            autocomplete="new-password"
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

                <button type="submit" class="inline-flex items-center justify-center font-semibold no-underline cursor-pointer rounded-lg transition-all duration-200 bg-primary text-white border border-primary hover:bg-primary-dark hover:border-primary-dark w-full py-2.5 text-sm mt-1 animate-[fadeInUp_0.5s_ease_0.2s_both] disabled:opacity-60 disabled:cursor-not-allowed" :disabled="loading">
                    <Loader2 v-if="loading" class="animate-spin-slow mr-1.5" :size="18" />
                    {{ loading ? '提交中...' : '提交' }}
                </button>
            </form>

            <p class="text-center mt-5 text-sm text-text-secondary animate-[fadeInUp_0.5s_ease_0.25s_both]">
                <button type="button" class="bg-transparent border-0 text-primary text-sm cursor-pointer p-0 font-semibold hover:underline" @click="handleLogout">使用其他账号登录</button>
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { Lock, Eye, EyeOff, Loader2, X } from "@lucide/vue"
import { validatePassword, validatePasswordMatch } from "~/utils/validatePassword"

definePageMeta({ layout: "auth" })

const router = useRouter()
const auth = useAuth()
const { showToast } = useToast()

const form = reactive({
    oldPassword: "",
    newPassword: "",
    confirmPassword: "",
})
const loading = ref(false)
const error = ref("")
const showOldPassword = ref(false)
const showNewPassword = ref(false)
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
    oldPassword: "",
    newPassword: "",
    confirmPassword: "",
})

function validate(): boolean {
    let valid = true
    fieldErrors.oldPassword = ""
    fieldErrors.newPassword = ""
    fieldErrors.confirmPassword = ""

    if (!form.oldPassword) {
        fieldErrors.oldPassword = "请输入原密码"
        valid = false
    }

    if (!form.newPassword) {
        fieldErrors.newPassword = "请输入新密码"
        valid = false
    } else {
        const pwResult = validatePassword(form.newPassword)
        if (!pwResult.valid) {
            fieldErrors.newPassword = pwResult.message
            valid = false
        }
    }

    if (form.newPassword && form.newPassword === form.oldPassword) {
        fieldErrors.newPassword = "新密码不能与原密码相同"
        valid = false
    }

    if (!form.confirmPassword) {
        fieldErrors.confirmPassword = "请确认密码"
        valid = false
    } else {
        const matchError = validatePasswordMatch(form.newPassword, form.confirmPassword)
        if (matchError) {
            fieldErrors.confirmPassword = matchError
            valid = false
        }
    }

    return valid
}

async function handleSubmit() {
    setError("")

    if (!validate()) return

    loading.value = true
    try {
        await auth.changePassword(form.oldPassword, form.newPassword)
        // useAuth.changePassword() 内部已更新本地 user 状态（must_change_password=false）
        // 并由 Nitro 代理同步替换 noj:token Cookie（旧 token 已被后端撤销）。
        // 无需再走 /login，直接回首页即可。
        showToast("success", "密码修改成功")
        router.replace("/settings")
    } catch (e: any) {
        setError(typeof e.data?.error === "string" ? e.data.error : `错误代码: ${e.response?.status || e.statusCode || e.status || 502}`)
    } finally {
        loading.value = false
    }
}

async function handleLogout() {
    await auth.logout()
    router.replace("/login")
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