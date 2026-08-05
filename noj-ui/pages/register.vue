<template>
    <div class="w-full max-w-[380px] relative">
        <ToastBanner :visible="!!error" color="error" icon="i-lucide-alert-circle" :message="error" @close="clearError" />
        <div class="bg-white border border-border rounded-lg p-8">
            <h1 class="text-22px font-bold text-center mb-6 text-text animate-[fadeInUp_0.5s_ease_both]">注册</h1>

            <form @submit.prevent="handleRegister">
                <div class="mb-7 animate-[fadeInUp_0.5s_ease_0.05s_both]">
                    <TextInput
                        id="username"
                        v-model="form.username"
                        label="用户名"
                        placeholder="3-30 位字母、数字或下划线"
                        autocomplete="username"
                        :disabled="loading"
                        :error="fieldErrors.username"
                        @focus="fieldErrors.username = ''"
                    >
                        <template #icon><UIcon name="i-lucide-user" class="size-4.5" /></template>
                    </TextInput>
                </div>

                <div class="mb-7 animate-[fadeInUp_0.5s_ease_0.1s_both]">
                    <TextInput
                        id="email"
                        v-model="form.email"
                        type="email"
                        label="邮箱"
                        placeholder="请输入邮箱地址"
                        autocomplete="email"
                        :disabled="loading"
                        :error="fieldErrors.email"
                        @focus="fieldErrors.email = ''"
                    >
                        <template #icon><UIcon name="i-lucide-mail" class="size-4.5" /></template>
                    </TextInput>
                </div>

                <!-- TODO 验证码 -->

                <div class="mb-7 animate-[fadeInUp_0.5s_ease_0.15s_both]">
                    <PasswordField
                        id="password"
                        v-model="form.password"
                        label="密码"
                        placeholder="至少 12 位，需包含字母和数字"
                        autocomplete="new-password"
                        :disabled="loading"
                        :error="fieldErrors.password"
                        @focus="fieldErrors.password = ''"
                    />
                </div>

                <div class="mb-7 animate-[fadeInUp_0.5s_ease_0.2s_both]">
                    <PasswordField
                        id="confirmPassword"
                        v-model="form.confirmPassword"
                        label="确认密码"
                        placeholder="再次输入密码"
                        autocomplete="new-password"
                        :disabled="loading"
                        :error="fieldErrors.confirmPassword"
                        @focus="fieldErrors.confirmPassword = ''"
                    />
                </div>

                <UButton color="primary" size="md" block class="animate-[fadeInUp_0.5s_ease_0.25s_both]" type="submit"  :disabled="loading">
                    <UIcon name="i-lucide-loader-2" class="animate-spin-slow mr-1.5 size-4.5" v-if="loading"/>
                    {{ loading ? '注册中...' : '注册' }}
                </UButton>
            </form>

            <p class="text-center mt-5 text-sm text-text-secondary animate-[fadeInUp_0.5s_ease_0.3s_both]">
                已有账号？<NuxtLink to="/login" class="text-primary no-underline font-semibold hover:underline">立即登录</NuxtLink>
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">
import { validatePassword, validatePasswordMatch, validateEmail } from "~/utils/validatePassword"
import { extractApiError } from "~/utils/apiError"

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

const { error, setError, clearError } = useFormError(3000)

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

    const emailError = validateEmail(form.email)
    if (emailError) {
        fieldErrors.email = emailError
        valid = false
    }

    if (!form.password) {
        fieldErrors.password = "请输入密码"
        valid = false
    } else {
        const pwResult = validatePassword(form.password)
        if (!pwResult.valid) {
            fieldErrors.password = pwResult.message
            valid = false
        }
    }

    if (!form.confirmPassword) {
        fieldErrors.confirmPassword = "请确认密码"
        valid = false
    } else {
        const matchError = validatePasswordMatch(form.password, form.confirmPassword)
        if (matchError) {
            fieldErrors.confirmPassword = matchError
            valid = false
        }
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
    } catch (e: unknown) {
        setError(extractApiError(e).message)
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
