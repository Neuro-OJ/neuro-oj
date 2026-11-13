<script setup lang="ts">
/**
 * 题目详情页的知识点标签（只读）：主知识点 + 次要知识点，`pending` 标「待确认」。
 * 未归类或接口返回空时整块不渲染（父组件亦可直接 v-if 门控）。
 */
import type { ProblemKnowledgeView } from '~/utils/knowledge';

const props = defineProps<{ view: ProblemKnowledgeView | null }>();

const classified = computed(() => props.view?.state === 'classified' && !!props.view.primary);
</script>

<template>
  <div v-if="classified && view" class="space-y-1.5 rounded-lg border border-border bg-bg-sunken px-3 py-2">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] font-semibold tracking-wider text-text-muted">知识点</span>
      <UBadge v-if="view.primary" color="primary" variant="subtle" size="sm">{{ view.primary.name }}</UBadge>
      <UBadge v-for="entry in view.secondary" :key="entry.node_id" color="neutral" variant="subtle" size="sm">
        {{ entry.name }}
      </UBadge>
      <UBadge v-if="view.pending" color="warning" variant="subtle" size="sm" icon="i-lucide-clock">待确认</UBadge>
    </div>
  </div>
</template>
