<template>
  <AuthFormCard
    title="重置密码"
    :error="error"
    :loading="loading"
    submit-label="重置密码"
    loading-label="重置"
    @submit="handleSubmit"
    @clear-error="clearError"
  >
    <PasswordField
      id="password"
      v-model="form.password"
      label="新密码"
      placeholder="至少 12 位，需包含字母和数字"
      autocomplete="new-password"
      :disabled="loading"
      required
      :error="fieldErrors.password"
      @focus="fieldErrors.password = ''"
    />

    <PasswordField
      id="confirmPassword"
      v-model="form.confirmPassword"
      label="确认密码"
      placeholder="再次输入新密码"
      autocomplete="new-password"
      :disabled="loading"
      required
      :error="fieldErrors.confirmPassword"
      @focus="fieldErrors.confirmPassword = ''"
    />

    <template #footer>
      <p><NuxtLink to="/login" class="text-primary no-underline font-semibold hover:underline">返回登录</NuxtLink></p>
    </template>
  </AuthFormCard>
</template>

<script setup lang="ts">
definePageMeta({ layout: "auth" })

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const { error, setError, clearError } = useFormError(5000)

const token = computed(() => (route.query.token as string) || "")

const form = reactive({ password: "", confirmPassword: "" })
const loading = ref(false)
const fieldErrors = ref<Record<string, string>>({})

function validate(): boolean {
  const errors: Record<string, string> = {}
  if (!form.password) {
    errors.password = "请输入新密码"
  } else if (form.password.length < 12) {
    errors.password = "密码长度不能少于 12 位"
  } else if (!/[a-z]/.test(form.password)) {
    errors.password = "密码必须包含至少一个小写字母"
  } else if (!/[A-Z]/.test(form.password)) {
    errors.password = "密码必须包含至少一个大写字母"
  } else if (!/[0-9]/.test(form.password)) {
    errors.password = "密码必须包含至少一个数字"
  }
  if (!form.confirmPassword) {
    errors.confirmPassword = "请确认密码"
  } else if (form.password !== form.confirmPassword) {
    errors.confirmPassword = "两次输入的密码不一致"
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
  } catch (e: any) {
    setError(typeof e.data?.error === "string" ? e.data.error : `服务器错误 (${e.status || 502})`)
    loading.value = false
  }
}
</script>
