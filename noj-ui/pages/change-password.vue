<template>
  <AuthFormCard
    title="修改密码"
    :error="error"
    :loading="loading"
    submit-label="提交"
    loading-label="提交"
    @submit="handleSubmit"
    @clear-error="clearError"
  >
    <PasswordField
      id="oldPassword"
      v-model="form.oldPassword"
      label="原密码"
      placeholder="请输入当前密码"
      autocomplete="current-password"
      :disabled="loading"
      :error="fieldErrors.oldPassword"
      @focus="fieldErrors.oldPassword = ''"
    />

    <PasswordField
      id="newPassword"
      v-model="form.newPassword"
      label="新密码"
      placeholder="至少 12 位，需包含字母和数字"
      autocomplete="new-password"
      :disabled="loading"
      :error="fieldErrors.newPassword"
      @focus="fieldErrors.newPassword = ''"
    />

    <PasswordField
      id="confirmPassword"
      v-model="form.confirmPassword"
      label="确认密码"
      placeholder="再次输入新密码"
      autocomplete="new-password"
      :disabled="loading"
      :error="fieldErrors.confirmPassword"
      @focus="fieldErrors.confirmPassword = ''"
    />

    <template #footer>
      <button type="button" class="bg-transparent border-0 text-primary text-sm cursor-pointer p-0 font-semibold hover:underline" @click="handleLogout">使用其他账号登录</button>
    </template>
  </AuthFormCard>
</template>

<script setup lang="ts">
definePageMeta({ layout: "auth" })

const router = useRouter()
const auth = useAuth()
const { showToast } = useToast()
const { error, setError, clearError } = useFormError()

const form = reactive({
  oldPassword: "",
  newPassword: "",
  confirmPassword: "",
})
const loading = ref(false)

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
  } else if (form.newPassword.length < 12) {
    fieldErrors.newPassword = "密码长度不能少于 12 位"
    valid = false
  } else if (!/[a-z]/.test(form.newPassword)) {
    fieldErrors.newPassword = "密码必须包含至少一个小写字母"
    valid = false
  } else if (!/[A-Z]/.test(form.newPassword)) {
    fieldErrors.newPassword = "密码必须包含至少一个大写字母"
    valid = false
  } else if (!/[0-9]/.test(form.newPassword)) {
    fieldErrors.newPassword = "密码必须包含至少一个数字"
    valid = false
  } else if (form.newPassword === form.oldPassword) {
    fieldErrors.newPassword = "新密码不能与原密码相同"
    valid = false
  }

  if (!form.confirmPassword) {
    fieldErrors.confirmPassword = "请确认密码"
    valid = false
  } else if (form.newPassword !== form.confirmPassword) {
    fieldErrors.confirmPassword = "两次输入的密码不一致"
    valid = false
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
