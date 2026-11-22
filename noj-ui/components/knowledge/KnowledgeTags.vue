<script setup lang="ts">
/**
 * 题目详情页的知识点标签（只读）：主知识点 + 次要知识点，`pending` 标「待确认」。
 *
 * P2：传了 `domain` 时标签可点击，跳到域内知识点页 `/d/<域>/knowledge/<节点>`。
 * 未归类或接口返回空时整块不渲染（父组件亦可直接 v-if 门控）。
 */
import type { ProblemKnowledgeView } from '~/utils/knowledge';

const props = defineProps<{ view: ProblemKnowledgeView | null; domain?: string }>();

const classified = computed(() => props.view?.state === 'classified' && !!props.view.primary);

/** 知识点页地址；未传域时返回 null（只读展示）。 */
function nodeTo(nodeId: string): string | null {
  return props.domain ? `/d/${encodeURIComponent(props.domain)}/knowledge/${encodeURIComponent(nodeId)}` : null;
}
</script>

<template>
  <div v-if="classified && view" class="space-y-1.5 rounded-lg border border-border bg-bg-sunken px-3 py-2">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] font-semibold tracking-wider text-text-muted">知识点</span>
      <template v-if="view.primary">
        <NuxtLink
          v-if="nodeTo(view.primary.node_id)"
          :to="nodeTo(view.primary.node_id)!"
          class="no-underline transition-opacity hover:opacity-80"
          :title="`查看知识点：${view.primary.name}`"
        >
          <UBadge color="primary" variant="subtle" size="sm">{{ view.primary.name }}</UBadge>
        </NuxtLink>
        <UBadge v-else color="primary" variant="subtle" size="sm">{{ view.primary.name }}</UBadge>
      </template>
      <template v-for="entry in view.secondary" :key="entry.node_id">
        <NuxtLink
          v-if="nodeTo(entry.node_id)"
          :to="nodeTo(entry.node_id)!"
          class="no-underline transition-opacity hover:opacity-80"
          :title="`查看知识点：${entry.name}`"
        >
          <UBadge color="neutral" variant="subtle" size="sm">{{ entry.name }}</UBadge>
        </NuxtLink>
        <UBadge v-else color="neutral" variant="subtle" size="sm">{{ entry.name }}</UBadge>
      </template>
      <UBadge v-if="view.pending" color="warning" variant="subtle" size="sm" icon="i-lucide-clock">待确认</UBadge>
    </div>
  </div>
</template>
