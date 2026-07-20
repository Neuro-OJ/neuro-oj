<template>
  <AuthFormCard
    title="注册"
    :error="error"
    :loading="loading"
    submit-label="注册"
    loading-label="注册"
    @submit="handleRegister"
    @clear-error="clearError"
  >
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
      <template #icon>
        <User :size="18" />
      </template>
    </TextInput>

    <TextInput
      id="email"
      v-model="form.email"
      label="邮箱"
      placeholder="请输入邮箱地址"
      autocomplete="email"
      type="email"
      :disabled="loading"
      :error="fieldErrors.email"
      @focus="fieldErrors.email = ''"
    >
      <template #icon>
        <Mail :size="18" />
      </template>
    </TextInput>

    <!-- TODO 验证码 -->

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

    <template #footer>
      <p>已有账号？<NuxtLink to="/login" class="text-primary no-underline font-semibold hover:underline">立即登录</NuxtLink></p>
    </template>
  </AuthFormCard>
</template>

<script setup lang="ts">
import { User, Mail } from "@lucide/vue"

definePageMeta({ layout: "auth" })

const router = useRouter()
const auth = useAuth()
const { error, setError, clearError } = useFormError()

const form = reactive({
  username: "",
  email: "",
  password: "",
  confirmPassword: "",
})
const loading = ref(false)

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
