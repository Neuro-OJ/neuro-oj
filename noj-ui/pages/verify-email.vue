<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"

definePageMeta({ layout: "auth" })
const route = useRoute()
const { t, locale } = useI18n()
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
    error.value = extractApiError(cause, locale.value).message
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
    error.value = extractApiError(cause, locale.value).message
  } finally {
    resending.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-md rounded-lg border border-border bg-white p-8 text-center">
    <UIcon name="i-lucide-mail-check" class="mx-auto mb-4 size-12 text-primary" />
    <h1 class="text-xl font-bold">{{ t('verify.title') }}</h1>
    <p v-if="state === 'waiting' && deliveryFailed" class="mt-3 text-warning-text">{{ t('verify.deliveryFailed') }}</p>
    <p v-else-if="state === 'waiting'" class="mt-3 text-text-secondary">{{ t('verify.sent') }}</p>
    <p v-else-if="state === 'pending'" class="mt-3 text-text-secondary">{{ t('verify.pending') }}</p>
    <p v-else-if="state === 'success'" class="mt-3 text-success-text">{{ t('verify.success') }}</p>
    <p v-else class="mt-3 text-error-text">{{ error || t('verify.invalid') }}</p>

    <p v-if="resendResult === 'sent'" class="mt-3 text-13px text-success-text">{{ t('verify.resent') }}</p>
    <p v-else-if="resendResult === 'failed'" class="mt-3 text-13px text-error-text">{{ t('verify.resendFailed') }}</p>

    <div class="mt-6 flex items-center justify-center gap-3">
      <UButton
        v-if="state === 'waiting' && deliveryFailed"
        color="primary"
        :loading="resending"
        @click="resendEmail"
      >{{ t('verify.resend') }}</UButton>
      <UButton to="/" color="primary" :variant="state === 'waiting' && deliveryFailed ? 'outline' : 'solid'">{{ t('common.backHome') }}</UButton>
    </div>
  </div>
</template>
