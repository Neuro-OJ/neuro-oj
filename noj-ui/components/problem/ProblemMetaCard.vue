<script setup lang="ts">
import type { ProblemView } from '~/utils/problemView'
import { formatAcceptanceRate } from '~/utils/submissionFormat'
import type { PublicProblemStats } from '~/utils/problemStats'

/**
 * 题目信息卡片（#511，右栏）：编号 / 难度 / 提供者 / 标签 / 通过率。
 *
 * 通过率复用 `useProblemStats().fetchPublic` 的公开统计；赛期后端抑制时
 * `submit_count`/`accepted_count`/`acceptance_rate` 三者同为空，
 * 这里用占位文案表达，**不用仍返回的 `attempt_count` 顶替**（防算术还原）。
 */
const props = defineProps<{
  problem: ProblemView
  stats?: PublicProblemStats | null
}>()

const router = useRouter()

const problemTags = computed(() => props.problem.tags.filter((t) => t.kind === 'problem'))
const algorithmTags = computed(() => props.problem.tags.filter((t) => t.kind === 'algorithm'))

const acceptanceText = computed(() => {
  const stats = props.stats
  if (!stats) return null
  if (stats.suppressed_reason === 'running_contest') return '竞赛进行中，暂不显示'
  if (stats.submit_count === 0) return '暂无通过记录'
  return `${formatAcceptanceRate(stats.acceptance_rate)} · ${stats.accepted_count}/${stats.submit_count}`
})
</script>

<template>
  <section class="rounded-xl border border-border bg-white p-5">
    <h2 class="mb-3 text-sm font-semibold text-text">题目信息</h2>
    <dl class="space-y-2.5 text-sm">
      <div class="flex items-center justify-between gap-3">
        <dt class="text-text-secondary">编号</dt>
        <dd class="font-mono text-xs font-semibold text-text">{{ problem.display_id }}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-text-secondary">难度</dt>
        <dd><DifficultyBadge :difficulty="problem.difficulty" /></dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-text-secondary">提供者</dt>
        <dd class="min-w-0">
          <UserIdentity
            v-if="problem.owner_username"
            :user="{ id: problem.owner_id ?? '', username: problem.owner_username }"
            size="sm"
            :show-avatar="false"
          />
          <span v-else class="text-text-secondary">平台</span>
        </dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-text-secondary">通过率</dt>
        <dd class="tabular-nums text-text">{{ acceptanceText ?? '—' }}</dd>
      </div>
    </dl>

    <div v-if="problemTags.length || algorithmTags.length || problem.has_hidden_algorithm_tags" class="mt-4 border-t border-border pt-3">
      <h3 class="mb-2 text-xs font-semibold text-text-secondary">标签</h3>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="t in problemTags"
          :key="t.id"
          type="button"
          class="inline-flex cursor-pointer items-center rounded-full border border-primary/20 bg-primary/5 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
          @click="router.push(`/problems?tag=${t.id}`)"
        >
          {{ t.name }}
        </button>
        <span
          v-for="t in algorithmTags"
          :key="t.id"
          class="inline-flex items-center rounded-full border border-signal/30 bg-signal/5 px-2.5 py-0.5 text-xs font-medium text-signal-deep"
        >
          {{ t.name }}
        </span>
        <span
          v-if="problem.has_hidden_algorithm_tags"
          class="inline-flex cursor-default items-center gap-1 rounded-full border border-border bg-bg-sunken px-2.5 py-0.5 text-xs font-medium text-text-muted"
          title="通过本题后可查看算法标签"
        >
          <UIcon name="i-lucide-lock" class="size-3" />
          算法标签 · 通过后显示
        </span>
      </div>
    </div>
  </section>
</template>
