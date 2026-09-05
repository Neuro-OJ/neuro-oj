<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"

const auth = useAuth()
const sending = ref(false)
const message = ref("")

async function resend() {
  sending.value = true
  message.value = ""
  try {
    await auth.resendEmailVerification()
    message.value = "验证邮件已发送，请检查收件箱"
  } catch (error: unknown) {
    message.value = extractApiError(error).message
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div
    v-if="auth.user.value && !auth.user.value.email_verified"
    class="fixed top-(--header-h) inset-x-0 z-40 flex flex-wrap items-center justify-center gap-3 border-b border-warning-border bg-warning-bg px-4 py-2 text-sm text-warning-text"
  >
    <span>请验证邮箱后再提交、参与社区或发送私信。</span>
    <UButton size="xs" color="warning" variant="outline" :loading="sending" @click="resend">
      重新发送验证邮件
    </UButton>
    <span v-if="message" class="text-xs">{{ message }}</span>
  </div>
</template>
