<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"

definePageMeta({ layout: "auth" })
const route = useRoute()
const auth = useAuth()
const token = computed(() => typeof route.query.token === "string" ? route.query.token : "")
const deliveryFailed = computed(() => route.query.sent === "0")
const state = ref<"pending" | "success" | "error" | "waiting">(token.value ? "pending" : "waiting")
const error = ref("")

// issue #426：重发入口与真实发送结果反馈
const resending = ref(false)
const resendResult = ref<"sent" | "failed" | null>(null)

onMounted(async () => {
  if (!token.value) return
  try {
    await auth.verifyEmail(token.value)
    state.value = "success"
  } catch (cause: unknown) {
    error.value = extractApiError(cause).message
    state.value = "error"
  }
})

async function resendEmail() {
  if (resending.value) return
  resending.value = true
  resendResult.value = null
  try {
    const result = await auth.resendEmailVerification()
    resendResult.value = result.sent === false ? "failed" : "sent"
  } catch (cause: unknown) {
    resendResult.value = "failed"
    error.value = extractApiError(cause).message
  } finally {
    resending.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-md rounded-lg border border-border bg-white p-8 text-center">
    <UIcon name="i-lucide-mail-check" class="mx-auto mb-4 size-12 text-primary" />
    <h1 class="text-xl font-bold">邮箱验证</h1>
    <p v-if="state === 'waiting' && deliveryFailed" class="mt-3 text-warning-text">注册成功，但验证邮件未能发出。请点击下方按钮重新发送。</p>
    <p v-else-if="state === 'waiting'" class="mt-3 text-text-secondary">注册成功。验证邮件已发送，请打开邮件中的链接完成验证。</p>
    <p v-else-if="state === 'pending'" class="mt-3 text-text-secondary">正在验证，请稍候…</p>
    <p v-else-if="state === 'success'" class="mt-3 text-success-text">邮箱验证成功，现在可以使用全部功能。</p>
    <p v-else class="mt-3 text-error-text">{{ error || "验证链接无效或已过期" }}</p>

    <p v-if="resendResult === 'sent'" class="mt-3 text-13px text-success-text">验证邮件已重新发送，请查收。</p>
    <p v-else-if="resendResult === 'failed'" class="mt-3 text-13px text-error-text">验证邮件发送失败，邮件服务可能暂时不可用，请稍后重试。</p>

    <div class="mt-6 flex items-center justify-center gap-3">
      <UButton
        v-if="state === 'waiting' && deliveryFailed"
        color="primary"
        :loading="resending"
        @click="resendEmail"
      >重新发送验证邮件</UButton>
      <UButton to="/" color="primary" :variant="state === 'waiting' && deliveryFailed ? 'outline' : 'solid'">返回首页</UButton>
    </div>
  </div>
</template>
