<template>
    <div class="auth-page">
        <Transition name="slide">
            <div v-if="error" class="error-banner">
                <span>{{ error }}</span>
                <button class="close-btn" @click="clearError">✕</button>
            </div>
        </Transition>
        <div class="auth-card">
            <h1 class="auth-title">注册</h1>

            <form @submit.prevent="handleRegister">
                <div class="form-group">
                    <label for="username">用户名</label>
                    <div class="input-wrapper">
                        <User class="input-icon" :size="18" />
                        <input
                            id="username"
                            v-model="form.username"
                            type="text"
                            placeholder="3-30 位字母、数字或下划线"
                            autocomplete="username"
                            :disabled="loading"
                            @focus="fieldErrors.username = ''"
                        />
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.username" class="field-error"><span>{{ fieldErrors.username }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <div class="form-group">
                    <label for="email">邮箱</label>
                    <div class="input-wrapper">
                        <Mail class="input-icon" :size="18" />
                        <input
                            id="email"
                            v-model="form.email"
                            type="email"
                            placeholder="请输入邮箱地址"
                            autocomplete="email"
                            :disabled="loading"
                            @focus="fieldErrors.email = ''"
                        />
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.email" class="field-error"><span>{{ fieldErrors.email }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <!-- TODO 验证码 -->

                <div class="form-group">
                    <label for="password">密码</label>
                    <div class="input-wrapper">
                        <Lock class="input-icon" :size="18" />
                        <input
                            id="password"
                            v-model="form.password"
                            :type="showPassword ? 'text' : 'password'"
                            placeholder="至少 12 位，需包含字母和数字"
                            autocomplete="new-password"
                            :disabled="loading"
                            @focus="fieldErrors.password = ''"
                        />
                        <button type="button" class="pwd-toggle" @click="showPassword = !showPassword" tabindex="-1">
                            <span class="icon-wrap">
                                <Transition name="icon" mode="out-in">
                                    <EyeOff v-if="!showPassword" :size="18" key="off" />
                                    <Eye v-else :size="18" key="on" />
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.password" class="field-error"><span>{{ fieldErrors.password }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <div class="form-group">
                    <label for="confirmPassword">确认密码</label>
                    <div class="input-wrapper">
                        <Lock class="input-icon" :size="18" />
                        <input
                            id="confirmPassword"
                            v-model="form.confirmPassword"
                            :type="showConfirmPassword ? 'text' : 'password'"
                            placeholder="再次输入密码"
                            autocomplete="new-password"
                            maxlength="30"
                            :disabled="loading"
                            @focus="fieldErrors.confirmPassword = ''"
                        />
                        <button type="button" class="pwd-toggle" @click="showConfirmPassword = !showConfirmPassword" tabindex="-1">
                            <span class="icon-wrap">
                                <Transition name="icon" mode="out-in">
                                    <EyeOff v-if="!showConfirmPassword" :size="18" key="off" />
                                    <Eye v-else :size="18" key="on" />
                                </Transition>
                            </span>
                        </button>
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.confirmPassword" class="field-error"><span>{{ fieldErrors.confirmPassword }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <button type="submit" class="btn btn-primary btn-submit" :disabled="loading">
                    <Loader2 v-if="loading" class="btn-spinner" :size="18" />
                    {{ loading ? '注册中...' : '注册' }}
                </button>
            </form>

            <p class="auth-footer">
                已有账号？<NuxtLink to="/login">立即登录</NuxtLink>
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

<style scoped>
.auth-page {
    width: 100%;
    max-width: 380px;
    position: relative;
}

.error-banner {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    position: fixed;
    top: calc(64px + 10px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 99;
    max-width: 380px;
    width: calc(100% - 48px);
}

.close-btn {
    background: none;
    border: none;
    color: #b91c1c;
    cursor: pointer;
    font-size: 16px;
    padding: 2px;
    line-height: 1;
    opacity: 0.7;
    flex-shrink: 0;
}

.close-btn:hover {
    opacity: 1;
}

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

.auth-card {
    background: var(--c-white);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    padding: 32px;
}

.auth-title {
    font-size: 22px;
    font-weight: 700;
    text-align: center;
    margin-bottom: 24px;
    color: var(--c-text);
    animation: fadeInUp 0.5s ease both;
}

.field-error {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    font-size: 13px;
    color: #b91c1c;
}

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

.form-group {
    position: relative;
    margin-bottom: 28px;
    animation: fadeInUp 0.5s ease both;
}

.form-group:nth-child(1) { animation-delay: 0.05s; }
.form-group:nth-child(2) { animation-delay: 0.1s; }
.form-group:nth-child(3) { animation-delay: 0.15s; }
.form-group:nth-child(4) { animation-delay: 0.2s; }

.btn-submit {
    animation: fadeInUp 0.5s ease 0.25s both;
}

.form-group label {
    display: block;
    font-size: 14px;
    font-weight: 600;
    color: var(--c-text);
    margin-bottom: 4px;
}

.input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
}

.input-icon {
    position: absolute;
    left: 10px;
    color: var(--c-text-muted);
    pointer-events: none;
}

.pwd-toggle {
    position: absolute;
    right: 12px;
    background: none;
    border: none;
    color: var(--c-text-muted);
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
}

.pwd-toggle:hover {
    color: var(--c-text-secondary);
}

.icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
}

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

.input-wrapper input {
    width: 100%;
    padding: 8px 12px 8px 36px;
    border: 1.5px solid var(--c-border);
    border-radius: 8px;
    font-size: 14px;
    color: var(--c-text);
    background: var(--c-white);
    outline: none;
    transition: border-color 0.2s;
}

.input-wrapper input:focus {
    border-color: var(--c-primary);
}

.input-wrapper input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.btn-submit {
    width: 100%;
    padding: 10px;
    font-size: 14px;
    margin-top: 4px;
}

.btn-submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.btn-spinner {
    animation: spin 0.8s linear infinite;
    margin-right: 6px;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.auth-footer {
    text-align: center;
    margin-top: 20px;
    font-size: 14px;
    color: var(--c-text-secondary);
    animation: fadeInUp 0.5s ease 0.3s both;
}

.auth-footer a {
    color: var(--c-primary);
    text-decoration: none;
    font-weight: 600;
}

.auth-footer a:hover {
    text-decoration: underline;
}
</style>
