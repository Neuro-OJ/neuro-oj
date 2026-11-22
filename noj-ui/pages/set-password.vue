<template>
  <div class="w-full max-w-[380px]">
    <AuthFormCard
      title="设置本地密码"
      subtitle="为了方便日后登录和管理绑定账号，请先设置密码。"
      :error="error"
      :loading="loading"
      submit-label="设置密码"
      loading-label="保存中"
      @submit="handleSubmit"
      @clear-error="clearError"
    >
      <PasswordField
        id="password"
        v-model="form.password"
        label="新密码"
        placeholder="至少 8 位，需包含大小写字母和数字"
        autocomplete="new-password"
        :disabled="loading"
        :error="fieldErrors.password"
        @blur="validatePasswordField"
        @focus="fieldErrors.password = ''"
      />
      <PasswordField
        id="confirm-password"
        v-model="form.confirmPassword"
        label="确认密码"
        placeholder="再次输入密码"
        autocomplete="new-password"
        :disabled="loading"
        :error="fieldErrors.confirmPassword"
        @focus="fieldErrors.confirmPassword = ''"
      />
    </AuthFormCard>
  </div>
</template>

<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import { validatePassword, validatePasswordMatch } from "~/utils/validatePassword"

definePageMeta({ layout: "auth", middleware: "auth" })

const router = useRouter()
const auth = useAuth()
const { error, setError, clearError } = useFormError()
const form = reactive({ password: "", confirmPassword: "" })
const fieldErrors = reactive({ password: "", confirmPassword: "" })
const loading = ref(false)

function validatePasswordField() {
  const current = auth.user.value
  const result = validatePassword(form.password, {
    username: current?.username,
    email: current?.email,
  })
  fieldErrors.password = result.valid ? "" : result.message
  return result.valid
}

function validate() {
  let valid = validatePasswordField()
  fieldErrors.confirmPassword = ""
  if (!form.confirmPassword) {
    fieldErrors.confirmPassword = "请确认密码"
    valid = false
  } else {
    const mismatch = validatePasswordMatch(form.password, form.confirmPassword)
    if (mismatch) {
      fieldErrors.confirmPassword = mismatch
      valid = false
    }
  }
  return valid
}

async function handleSubmit() {
  clearError()
  if (!validate()) return
  loading.value = true
  try {
    await auth.setPassword(form.password)
    router.replace("/")
  } catch (err: unknown) {
    setError(extractApiError(err).message)
  } finally {
    loading.value = false
  }
}
</script>
