<script setup lang="ts">
/**
 * 评测错因与知识图谱补强联动面板（嵌入 AI 评测可视化反馈下方）：
 * - 提取 `badcases[].error_type` 与薄弱分项 `metrics`（得分率 < 70%），
 *   向后端请求匹配的知识点、讲解与未掌握前置链；
 * - 知识图谱功能关闭、题目保护或无关联节点时自动静默隐藏。
 */
import { computed, ref, watch } from 'vue';
import type { FeedbackBadcase, FeedbackMetric } from '~/utils/domain/submission/aiFeedback';
import {
  knowledgeNodePath,
  masteryStateColor,
  masteryStateLabel,
  type ProblemRemediationView,
  type RemediationReason,
} from '~/utils/domain/education/knowledge';

const props = defineProps<{
  problemId: string;
  slug: string;
  badcases: FeedbackBadcase[];
  metrics: FeedbackMetric[];
}>();

const knowledge = typeof useKnowledge === 'function' ? useKnowledge() : null;
const remediation = ref<ProblemRemediationView | null>(null);
const loading = ref(false);

const errorTypes = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of props.badcases) {
    const type = item.error_type?.trim();
    if (!type) continue;
    const key = type.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(type);
  }
  return out;
});

const weakMetrics = computed(() =>
  props.metrics
    .filter((m) => m.max_score > 0 && m.score / m.max_score < 0.7)
    .map((m) => m.key || m.label)
    .filter(Boolean)
);

async function load() {
  if (!knowledge || typeof knowledge.loadProblemRemediation !== 'function') return;
  if (!props.problemId || !props.slug) return;
  loading.value = true;
  try {
    remediation.value = await knowledge.loadProblemRemediation(props.problemId, {
      domain: props.slug,
      errorTypes: errorTypes.value,
      weakMetrics: weakMetrics.value,
    });
  } catch {
    remediation.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.problemId, props.slug, errorTypes.value.join(','), weakMetrics.value.join(',')] as const,
  () => {
    void load();
  },
  { immediate: true },
);

function reasonLabel(reason: RemediationReason): string {
  switch (reason) {
    case 'missing_prerequisite':
      return '建议先补前置';
    case 'feedback_signal':
      return '错因关联';
    case 'problem_primary':
      return '本题核心';
    case 'problem_secondary':
      return '相关能力';
  }
}

function reasonBadgeColor(reason: RemediationReason): 'warning' | 'error' | 'primary' | 'neutral' {
  switch (reason) {
    case 'missing_prerequisite':
      return 'warning';
    case 'feedback_signal':
      return 'error';
    case 'problem_primary':
      return 'primary';
    case 'problem_secondary':
      return 'neutral';
  }
}
</script>

<template>
  <UCard
    v-if="!loading && remediation && remediation.items.length > 0"
    data-testid="feedback-knowledge-remediation"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-book-open-check" class="size-4 text-primary" />
        <h4 class="text-sm font-semibold text-text">关联知识点与错因补强</h4>
      </div>
      <span v-if="errorTypes.length > 0" class="text-xs text-text-muted">
        已结合错因：{{ errorTypes.slice(0, 3).join('、') }}
      </span>
    </div>

    <ul class="grid gap-2 sm:grid-cols-2">
      <li
        v-for="item in remediation.items"
        :key="item.node_id"
        class="rounded-[6px] border border-border bg-white p-3 transition-colors hover:border-primary/40"
        data-testid="remediation-node-item"
      >
        <div class="flex items-start justify-between gap-2">
          <NuxtLink
            :to="knowledgeNodePath(slug, item.node_id)"
            class="text-sm font-semibold text-text no-underline hover:text-primary"
          >
            {{ item.name }}
          </NuxtLink>
          <div class="flex shrink-0 items-center gap-1">
            <UBadge :color="reasonBadgeColor(item.reason)" size="xs" variant="subtle">
              {{ reasonLabel(item.reason) }}
            </UBadge>
            <UBadge
              v-if="item.state !== 'none'"
              :color="masteryStateColor(item.state)"
              size="xs"
              variant="subtle"
            >
              {{ masteryStateLabel(item.state) }}
            </UBadge>
          </div>
        </div>
        <p v-if="item.summary" class="mt-1 line-clamp-2 text-xs text-text-secondary">
          {{ item.summary }}
        </p>
        <div class="mt-2 flex items-center justify-between gap-2 text-[11px] text-text-muted">
          <span v-if="item.matched_signals.length > 0">
            命中：{{ item.matched_signals.slice(0, 2).join(', ') }}
          </span>
          <span v-else-if="item.has_doc">含原创图解与例题</span>
          <span v-else>查看阶梯练习</span>
          <NuxtLink
            :to="knowledgeNodePath(slug, item.node_id)"
            class="font-medium text-primary no-underline hover:underline"
          >
            前往补强 →
          </NuxtLink>
        </div>
      </li>
    </ul>
  </UCard>
</template>
