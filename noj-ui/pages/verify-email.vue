<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"

definePageMeta({ layout: "auth" })
const route = useRoute()
const auth = useAuth()
const token = computed(() => typeof route.query.token === "string" ? route.query.token : "")
const deliveryFailed = computed(() => route.query.sent === "0")
const state = ref<"pending" | "success" | "error" | "waiting">(token.value ? "pending" : "waiting")
const error = ref("")

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
</script>

<template>
  <div class="w-full max-w-md rounded-lg border border-border bg-white p-8 text-center">
    <UIcon name="i-lucide-mail-check" class="mx-auto mb-4 size-12 text-primary" />
    <h1 class="text-xl font-bold">邮箱验证</h1>
    <p v-if="state === 'waiting' && deliveryFailed" class="mt-3 text-warning-text">注册成功，但邮件服务暂不可用。请稍后在首页重新发送验证邮件。</p>
    <p v-else-if="state === 'waiting'" class="mt-3 text-text-secondary">注册成功。验证邮件已发送，请打开邮件中的链接完成验证。</p>
    <p v-else-if="state === 'pending'" class="mt-3 text-text-secondary">正在验证，请稍候…</p>
    <p v-else-if="state === 'success'" class="mt-3 text-success-text">邮箱验证成功，现在可以使用全部功能。</p>
    <p v-else class="mt-3 text-error-text">{{ error || "验证链接无效或已过期" }}</p>
    <UButton class="mt-6" to="/" color="primary">返回首页</UButton>
  </div>
</template>
