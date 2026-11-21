<template>
    <div class="w-full max-w-[380px] relative">
        <ToastBanner :visible="!!error" color="error" icon="i-lucide-alert-circle" :message="error" @close="clearError" />
        <div class="bg-white border border-border noj-panel p-8">
            <h1 class="text-22px font-bold text-center mb-6 text-text">修改密码</h1>

            <form @submit.prevent="handleSubmit">
                <div class="relative mb-7">
                    <label for="oldPassword" class="block text-sm font-semibold text-text mb-1">原密码</label>
                    <UInput
                        id="oldPassword"
                        v-model="form.oldPassword"
                        :type="showOldPassword ? 'text' : 'password'"
                        icon="i-lucide-lock"
                        placeholder="请输入当前密码"
                        autocomplete="current-password"
                        :disabled="loading"
                        class="w-full"
                        @focus="fieldErrors.oldPassword = ''"
                    >
                        <template #trailing>
                            <UButton type="button" square size="xs" variant="ghost" color="neutral" tabindex="-1"
                                class="text-text-muted hover:text-text-secondary"
                                :icon="showOldPassword ? 'i-lucide-eye' : 'i-lucide-eye-off'"
                                :aria-label="showOldPassword ? '隐藏密码' : '显示密码'"
                                @click="showOldPassword = !showOldPassword" />
                        </template>
                    </UInput>
                    <Transition name="drop">
                        <div v-if="fieldErrors.oldPassword" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-13px text-error-text"><span>{{ fieldErrors.oldPassword }}</span><UIcon name="i-lucide-x" class="size-3.5" /></div>
                    </Transition>
                </div>

                <div class="relative mb-7">
                    <label for="newPassword" class="block text-sm font-semibold text-text mb-1">新密码</label>
                    <UInput
                        id="newPassword"
                        v-model="form.newPassword"
                        :type="showNewPassword ? 'text' : 'password'"
                        icon="i-lucide-lock"
                        placeholder="至少 8 位，需包含大小写字母和数字"
                        autocomplete="new-password"
                        :disabled="loading"
                        class="w-full"
                        @focus="fieldErrors.newPassword = ''"
                        @blur="validateNewPasswordField"
                    >
                        <template #trailing>
                            <UButton type="button" square size="xs" variant="ghost" color="neutral" tabindex="-1"
                                class="text-text-muted hover:text-text-secondary"
                                :icon="showNewPassword ? 'i-lucide-eye' : 'i-lucide-eye-off'"
                                :aria-label="showNewPassword ? '隐藏密码' : '显示密码'"
                                @click="showNewPassword = !showNewPassword" />
                        </template>
                    </UInput>
                    <Transition name="drop">
                        <div v-if="fieldErrors.newPassword" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-13px text-error-text"><span>{{ fieldErrors.newPassword }}</span><UIcon name="i-lucide-x" class="size-3.5" /></div>
                    </Transition>
                </div>

                <div class="relative mb-7">
                    <label for="confirmPassword" class="block text-sm font-semibold text-text mb-1">确认密码</label>
                    <UInput
                        id="confirmPassword"
                        v-model="form.confirmPassword"
                        :type="showConfirmPassword ? 'text' : 'password'"
                        icon="i-lucide-lock"
                        placeholder="再次输入新密码"
                        autocomplete="new-password"
                        :disabled="loading"
                        class="w-full"
                        @focus="fieldErrors.confirmPassword = ''"
                    >
                        <template #trailing>
                            <UButton type="button" square size="xs" variant="ghost" color="neutral" tabindex="-1"
                                class="text-text-muted hover:text-text-secondary"
                                :icon="showConfirmPassword ? 'i-lucide-eye' : 'i-lucide-eye-off'"
                                :aria-label="showConfirmPassword ? '隐藏密码' : '显示密码'"
                                @click="showConfirmPassword = !showConfirmPassword" />
                        </template>
                    </UInput>
                    <Transition name="drop">
                        <div v-if="fieldErrors.confirmPassword" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-13px text-error-text"><span>{{ fieldErrors.confirmPassword }}</span><UIcon name="i-lucide-x" class="size-3.5" /></div>
                    </Transition>
                </div>

                <UButton color="primary" size="md" block type="submit"  :disabled="loading">
                    <UIcon name="i-lucide-loader-2" class="animate-spin-slow mr-1.5 size-4.5" v-if="loading"/>
                    {{ loading ? '提交中...' : '提交' }}
                </UButton>
            </form>

            <p class="text-center mt-5 text-sm text-text-secondary">
                <UButton type="button" variant="link" color="primary" size="xs" class="p-0 font-semibold" @click="handleLogout">使用其他账号登录</UButton>
            </p>
        </div>
    </div>
</template>

<script setup lang="ts">

// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from '~/composables/useToast'

import { validatePassword, validatePasswordMatch } from "~/utils/auth/validatePassword"
import { extractApiError } from "~/utils/server/apiError"

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
const showOldPassword = ref(false)
const showNewPassword = ref(false)
const showConfirmPassword = ref(false)

const { error, setError, clearError } = useFormError(3000)

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

    if (!validateNewPasswordField()) {
        valid = false
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

function validateNewPasswordField(): boolean {
    const pwResult = validatePassword(form.newPassword, {
        username: auth.user.value?.username,
        email: auth.user.value?.email,
    })
    fieldErrors.newPassword = pwResult.valid ? "" : pwResult.message
    return pwResult.valid
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
    } catch (e: unknown) {
        setError(extractApiError(e).message)
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
</style>
