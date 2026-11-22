<script setup lang="ts">
// 政策重大变更同意弹窗（PIPL）。
//
// 登录用户且存在**重大版本**未同意时弹出，**不可关闭**（无 X / 无取消 / 禁用 Esc）。
// 同意后调用记录端点并刷新用户状态。
//
// 挂载于 layouts/default.vue；`pending` 为空时不渲染。

import { ref, watch } from 'vue'
import { useToast } from '~/composables/useToast'
import { extractApiError } from '~/utils/apiError'
import type { PendingConsent } from '~/utils/legalConsent'

const props = defineProps<{ pending: PendingConsent[] }>()

const { toast } = useToast()
const { api } = useApi()
const { fetchUser } = useAuth()

const open = ref(false)
const submitting = ref(false)

// 出现新的待同意项时打开弹窗。
// 2026-09-25 评审：以"首个待同意项"为键，而不是数组长度——长度不变但内容
// 变化（如 privacy 换成 terms）时此前不会重开弹窗。
watch(
  () => props.pending[0]?.kind ?? null,
  (kind) => {
    if (kind) open.value = true
  },
  { immediate: true },
)

async function agreeAll() {
  if (submitting.value) return
  submitting.value = true
  try {
    for (const item of props.pending) {
      await api.post('/api/v1/legal/consent', { kind: item.kind }, { silent: true })
    }
    await fetchUser()
    open.value = false
    toast.success('感谢确认，已记录你的同意')
  } catch (err) {
    toast.error(extractApiError(err).message)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :dismissible="false"
    :close="false"
    :title="'政策更新通知'"
    :ui="{ content: 'bg-default focus:outline-none' }"
  >
    <template #body>
      <div class="space-y-4 text-sm text-text-secondary">
        <p>我们更新了以下条款。请阅读并确认后继续使用本平台：</p>
        <ul class="space-y-2">
          <li v-for="item in pending" :key="item.kind" class="flex items-start gap-2">
            <UIcon name="i-lucide-file-text" class="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              <b class="text-text">{{ item.label }}</b>
              <span class="ml-1 tabular-nums text-text-muted">
                v{{ item.agreedVersion }} → v{{ item.requiredVersion }}
              </span>
              <span v-if="item.changeSummary" class="mt-1 block text-xs text-text-muted">
                变更摘要：{{ item.changeSummary }}
              </span>
              <NuxtLink
                v-if="item.kind === 'privacy' || item.kind === 'terms'"
                :to="item.kind === 'terms' ? '/legal/terms' : '/legal/privacy'"
                target="_blank"
                class="mt-1 inline-block text-xs text-primary no-underline hover:underline"
              >查看全文</NuxtLink>
            </span>
          </li>
        </ul>
        <p class="text-xs text-text-muted">
          我已年满 14 周岁，或在监护人陪同下已阅读并同意更新后的上述条款。
        </p>
      </div>
    </template>
    <template #footer>
      <UButton block :loading="submitting" @click="agreeAll">我已知悉并同意</UButton>
    </template>
  </UModal>
</template>
