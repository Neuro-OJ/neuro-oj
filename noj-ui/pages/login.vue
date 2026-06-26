<template>
    <div class="auth-page">
        <Transition name="slide">
            <div v-if="registeredMsg" class="success-banner">
                <span>{{ registeredMsg }}</span>
            </div>
        </Transition>
        <Transition name="slide">
            <div v-if="error" class="error-banner">
                <span>{{ error }}</span>
                <button class="close-btn" @click="clearError">✕</button>
            </div>
        </Transition>
        <div class="auth-card">
            <h1 class="auth-title">登录</h1>

            <form @submit.prevent="handleLogin">
                <div class="form-group">
                    <label for="login">用户名 / 邮箱</label>
                    <div class="input-wrapper">
                        <User class="input-icon" :size="18" />
                        <input
                            id="login"
                            v-model="form.login"
                            type="text"
                            placeholder="请输入用户名或邮箱"
                            autocomplete="username"
                            :disabled="loading"
                            @focus="fieldErrors.login = ''"
                        />
                    </div>
                    <Transition name="drop">
                        <div v-if="fieldErrors.login" class="field-error"><span>{{ fieldErrors.login }}</span><X :size="14" /></div>
                    </Transition>
                </div>

                <div class="form-group">
                    <label for="password">密码</label>
                    <div class="input-wrapper">
                        <Lock class="input-icon" :size="18" />
                        <input
                            id="password"
                            v-model="form.password"
                            :type="showPassword ? 'text' : 'password'"
                            placeholder="请输入密码（仅字母和数字）"
                            autocomplete="current-password"
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

                <button type="submit" class="btn btn-primary btn-submit" :disabled="loading">
                    <Loader2 v-if="loading" class="btn-spinner" :size="18" />
                    {{ loading ? '登录中...' : '登录' }}
                </button>
            </form>

            <p class="auth-footer">
                还没有账号？<NuxtLink to="/register">立即注册</NuxtLink>
            </p>
            <p class="auth-footer">
                <button type="button" class="forgot-link" @click="showForgot = true">忘记密码？</button>
            </p>
        </div>

        <Transition name="fade">
            <div v-if="showForgot" class="forgot-overlay" @click.self="showForgot = false">
                <div class="forgot-dialog">
                    <h2>找回密码</h2>
                    <p>功能开发中，敬请期待</p>
                    <button type="button" class="btn btn-primary" @click="showForgot = false">知道了</button>
                </div>
            </div>
        </Transition>
    </div>
</template>

<script setup lang="ts">
import { User, Lock, Eye, EyeOff, Loader2, X } from "@lucide/vue"

definePageMeta({ layout: "auth" })

const router = useRouter()
const auth = useAuth()

const form = reactive({ login: "", password: "" })
const loading = ref(false)
const error = ref("")
const showPassword = ref(false)
const showForgot = ref(false)

// 注册成功后的提示
const registeredMsg = ref("")
const route = useRoute()
if (route.query.registered === "1") {
  registeredMsg.value = "注册成功，请登录"
}

const fieldErrors = reactive({
    login: "",
    password: "",
})

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
    let valid = true
    fieldErrors.login = ""
    fieldErrors.password = ""

    if (!form.login.trim()) {
        fieldErrors.login = "请输入用户名或邮箱"
        valid = false
    }

    if (!form.password) {
        fieldErrors.password = "请输入密码"
        valid = false
    }

    return valid
}

async function handleLogin() {
    if (!validate()) return

    loading.value = true
    try {
        await auth.login(form.login.trim(), form.password)
        router.replace("/")
    } catch (e: any) {
        setError(typeof e.data?.error === "string" ? e.data.error : `服务器错误 (${e.status || 502})`)
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

.success-banner {
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    color: #166534;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    position: fixed;
    top: calc(64px + 10px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 99;
    max-width: 380px;
    width: calc(100% - 48px);
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

.form-group {
    position: relative;
    margin-bottom: 28px;
    animation: fadeInUp 0.5s ease both;
}

.form-group:nth-child(1) { animation-delay: 0.05s; }
.form-group:nth-child(2) { animation-delay: 0.1s; }

.btn-submit {
    animation: fadeInUp 0.5s ease 0.15s both;
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

.forgot-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
}

.forgot-dialog {
    background: var(--c-white);
    border-radius: 12px;
    padding: 32px;
    text-align: center;
    max-width: 340px;
    width: calc(100% - 48px);
}

.forgot-dialog h2 {
    font-size: 18px;
    margin-bottom: 12px;
}

.forgot-dialog p {
    font-size: 14px;
    color: var(--c-text-secondary);
    margin-bottom: 20px;
}

.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
    opacity: 0;
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
    animation: fadeInUp 0.5s ease 0.2s both;
}

.auth-footer + .auth-footer {
    margin-top: 8px;
}

.auth-footer a {
    color: var(--c-primary);
    text-decoration: none;
    font-weight: 600;
}

.auth-footer a:hover {
    text-decoration: underline;
}

.forgot-link {
    background: none;
    border: none;
    color: var(--c-primary);
    font-size: 14px;
    cursor: pointer;
    padding: 0;
    font-weight: 600;
}

.forgot-link:hover {
    text-decoration: underline;
}
</style>
