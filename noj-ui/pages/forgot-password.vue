<template>
  <AuthFormCard
    title="忘记密码"
    subtitle="输入注册邮箱，我们会发送一封重置密码的邮件"
    :error="error"
    :loading="loading"
    submit-label="发送重置链接"
    loading-label="发送"
    @submit="handleSubmit"
    @clear-error="clearError"
  >
    <!-- 成功 banner -->
    <template #banner-success>
      <Transition name="slide">
        <div v-if="submitted" class="bg-green-50 border border-green-200 text-green-700 rounded-md px-3.5 py-2.5 text-sm flex items-center justify-center gap-3 fixed top-[74px] left-1/2 -translate-x-1/2 z-[99] max-w-[380px] w-[calc(100%-48px)]">
          <span>密码重置链接已发送到 {{ submittedEmail }}，请检查邮箱（链接 15 分钟内有效）</span>
        </div>
      </Transition>
    </template>

    <TextInput
      id="email"
      v-model="email"
      label="邮箱"
      placeholder="请输入注册时使用的邮箱"
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

    <template #footer>
      <p>想起密码了？<NuxtLink to="/login" class="text-primary no-underline font-semibold hover:underline">返回登录</NuxtLink></p>
    </template>
  </AuthFormCard>
</template>

<script setup lang="ts">
import { Mail } from "@lucide/vue"

definePageMeta({ layout: "auth" })

const auth = useAuth()
const { error, setError, clearError } = useFormError()

const email = ref("")
const loading = ref(false)
const submitted = ref(false)
const submittedEmail = ref("")
const fieldErrors = ref<Record<string, string>>({})

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
