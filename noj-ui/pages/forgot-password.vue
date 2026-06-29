<template>
    <div class="w-full max-w-[380px] relative">
        <Transition name="slide">
            <div v-if="error" class="bg-red-50 border border-red-200 text-red-700 rounded-md px-3.5 py-2.5 text-sm flex items-center justify-between gap-3 fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]">
                <span>{{ error }}</span>
                <button class="bg-transparent border-0 text-red-700 cursor-pointer text-base p-0.5 leading-none opacity-70 shrink-0 hover:opacity-100" @click="clearError">&#10005;</button>
            </div>
        </Transition>

        <Transition name="slide">
            <div v-if="submitted" class="bg-green-50 border border-green-200 text-green-700 rounded-md px-3.5 py-2.5 text-sm flex items-center justify-center gap-3 fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]">
                <span>密码重置链接已发送到 {{ submittedEmail }}，请检查邮箱（链接 15 分钟内有效）</span>
            </div>
        </Transition>

        <div class="bg-white border border-border rounded-lg p-8">
            <h1 class="text-[22px] font-bold text-center mb-3 text-text animate-[fadeInUp_0.5s_ease_both]">忘记密码</h1>
            <p class="text-center text-sm text-text-secondary mb-6 animate-[fadeInUp_0.5s_ease_0.05s_both]">输入注册邮箱，我们会发送一封重置密码的邮件</p>

            <form @submit.prevent="handleSubmit">
                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.1s_both]">
                    <label for="email" class="block text-sm font-semibold text-text mb-1">邮箱</label>
                    <div class="relative flex items-center">
                        <Mail class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
                        <input
                            id="email"
                            v-model="email"
                            type="email"
                            placeholder="请输入注册时使用的邮箱"
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

                <button type="submit" class="inline-flex items-center justify-center font-semibold no-underline cursor-pointer rounded-lg transition-all duration-200 bg-primary text-white border border-primary hover:bg-primary-dark hover:border-primary-dark w-full py-2.5 text-sm mt-1 animate-[fadeInUp_0.5s_ease_0.15s_both] disabled:opacity-60 disabled:cursor-not-allowed" :disabled="loading">
                    <Loader2 v-if="loading" class="animate-spin-slow mr-1.5" :size="18" />
                    {{ loading ? '发送中...' : '发送重置链接' }}
                </button>
            </form>

            <p class="text-center mt-5 text-sm text-text-secondary animate-[fadeInUp_0.5s_ease_0.2s_both]">
                想起密码了？<NuxtLink to="/login" class="text-primary no-underline font-semibold hover:underline">返回登录</NuxtLink>
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { Mail, Loader2, X } from "@lucide/vue"

definePageMeta({ layout: "auth" })

const auth = useAuth()

const email = ref("")
const loading = ref(false)
const submitted = ref(false)
const submittedEmail = ref("")
const error = ref("")
const fieldErrors = ref<Record<string, string>>({})

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

function validate(): boolean {
    const errors: Record<string, string> = {}
    if (!email.value.trim()) {
        errors.email = "请输入邮箱地址"
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
        errors.email = "邮箱格式不正确"
    }
    fieldErrors.value = errors
    return Object.keys(errors).length === 0
}

async function handleSubmit() {
    if (!validate()) return
    loading.value = true
    try {
        await auth.forgotPassword(email.value.trim())
        // 成功：显示绿色 banner，保留邮箱供用户核对
        submitted.value = true
        submittedEmail.value = email.value.trim()
        email.value = ""
    } catch (e: any) {
        setError(typeof e.data?.error === "string" ? e.data.error : `服务器错误 (${e.status || 502})`)
    } finally {
        loading.value = false
    }
}
</script>

<style>
/* Vue Transition: slide (用于 error/success banner) */
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
