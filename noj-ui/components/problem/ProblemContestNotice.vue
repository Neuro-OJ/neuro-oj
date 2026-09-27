<script setup lang="ts">
import { publicUrl } from '~/utils/publicIdentifiers'
import type { ProblemContestSecrecyNotice } from '~/utils/problemView'

/**
 * 公开赛保密提示横幅（仅题目所有者与管理员能看到本组件）。
 *
 * 背景：题目一旦被加入公开赛（`kind='public'`，邀请赛除外），除所有者与管理员外，
 * 所有人访问题目相关页面/接口都会拿到 404；竞赛 `end_time` 一过自动恢复可见。
 * 因此本横幅**不可关闭**——它是保密要求的提醒，不是一次性通知。
 */
defineProps<{
  contests: ProblemContestSecrecyNotice[]
}>()
</script>

<template>
  <div
    v-if="contests.length > 0"
    role="status"
    class="mb-4 flex items-start gap-2 rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-text"
  >
    <UIcon name="i-lucide-shield-alert" class="mt-0.5 size-4 shrink-0" />
    <p class="min-w-0">
      当前题目已经被关联到竞赛
      <template v-for="(contest, index) in contests" :key="contest.public_id">
        <span v-if="index > 0">、</span>
        <NuxtLink
          :to="publicUrl('contest', contest.public_id)"
          class="font-medium underline hover:no-underline"
        >{{ contest.title }}</NuxtLink>
      </template>
      ，仅管理员和题目所有者可见，请注意保密工作。
    </p>
  </div>
</template>
