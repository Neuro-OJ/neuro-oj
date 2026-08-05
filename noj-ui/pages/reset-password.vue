<template>
    <div class="w-full max-w-[380px] relative">
        <ToastBanner :visible="!!error" color="error" icon="i-lucide-alert-circle" :message="error" @close="clearError" />

        <div class="bg-white border border-border rounded-lg p-8">
            <h1 class="text-22px font-bold text-center mb-6 text-text animate-[fadeInUp_0.5s_ease_both]">重置密码</h1>

            <form @submit.prevent="handleSubmit">
                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.05s_both]">
                    <label for="password" class="block text-sm font-semibold text-text mb-1">新密码 <span class="text-red-600">*</span></label>
                    <div class="relative flex items-center">
                        <UIcon name="i-lucide-lock" class="absolute left-[10px] text-text-muted pointer-events-none size-4.5" />
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
                                    <UIcon name="i-lucide-eye-off" class="size-4.5" v-if="!showPassword"  key="off"/>
                                    <UIcon name="i-lucide-eye" class="size-4.5" v-else  key="on"/>
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.password" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-13px text-red-700"><span>{{ fieldErrors.password }}</span><UIcon name="i-lucide-x" class="size-3.5" /></div>
                    </Transition>
                </div>

                <div class="relative mb-7 animate-[fadeInUp_0.5s_ease_0.1s_both]">
                    <label for="confirmPassword" class="block text-sm font-semibold text-text mb-1">确认密码 <span class="text-red-600">*</span></label>
                    <div class="relative flex items-center">
                        <UIcon name="i-lucide-lock" class="absolute left-[10px] text-text-muted pointer-events-none size-4.5" />
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
                                    <UIcon name="i-lucide-eye-off" class="size-4.5" v-if="!showConfirmPassword"  key="off"/>
                                    <UIcon name="i-lucide-eye" class="size-4.5" v-else  key="on"/>
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.confirmPassword" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-13px text-red-700"><span>{{ fieldErrors.confirmPassword }}</span><UIcon name="i-lucide-x" class="size-3.5" /></div>
                    </Transition>
                </div>

                <UButton color="primary" size="md" block class="animate-[fadeInUp_0.5s_ease_0.15s_both]" type="submit"  :disabled="loading">
                    <UIcon name="i-lucide-loader-2" class="animate-spin-slow mr-1.5 size-4.5" v-if="loading"/>
                    {{ loading ? '重置中...' : '重置密码' }}
                </UButton>
            </form>

            <p class="text-center mt-5 text-sm text-text-secondary animate-[fadeInUp_0.5s_ease_0.2s_both]">
                <NuxtLink to="/login" class="text-primary no-underline font-semibold hover:underline">返回登录</NuxtLink>
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { validatePassword, validatePasswordMatch } from "~/utils/validatePassword"
import { extractApiError } from "~/utils/apiError"

definePageMeta({ layout: "auth" })

const route = useRoute()
const router = useRouter()
const auth = useAuth()

const token = computed(() => (route.query.token as string) || "")

const form = reactive({ password: "", confirmPassword: "" })
const showPassword = ref(false)
const showConfirmPassword = ref(false)
const loading = ref(false)
const fieldErrors = ref<Record<string, string>>({})

const { error, setError, clearError } = useFormError(5000)

function validate(): boolean {
    const errors: Record<string, string> = {}
    const pwResult = validatePassword(form.password)
    if (!pwResult.valid) {
        errors.password = pwResult.message
    }
    const matchError = validatePasswordMatch(form.password, form.confirmPassword)
    if (matchError) {
        errors.confirmPassword = matchError
    }
    fieldErrors.value = errors
    return Object.keys(errors).length === 0
}

async function handleSubmit() {
    if (!token.value) {
        setError("缺少重置令牌，请重新发起密码重置")
        return
    }
    if (!validate()) return

    loading.value = true
    try {
        await auth.resetPassword(token.value, form.password)
        // 成功 → 跳登录页带成功 banner
        router.replace("/login?reset=1")
    } catch (e: unknown) {
        setError(extractApiError(e).message)
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
