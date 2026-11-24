<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import type { EvaluationFeedback } from '~/utils/aiFeedback';
import MetricRadarChart from './MetricRadarChart.vue';
import LlmTraceTimeline from './LlmTraceTimeline.vue';
import BadcaseComparison from './BadcaseComparison.vue';

const props = withDefaults(
  defineProps<{
    kind: 'submission' | 'self-test';
    targetId: string;
    slug?: string;
    status?: string;
    resultVisibility?: 'hidden' | 'summary' | 'cases';
    resourceAvailable?: boolean;
    attemptId?: string | null;
    includeMessages?: boolean;
    /** 可选预注入反馈载荷（用于 SSR/单测直传，不额外发请求）。 */
    feedback?: EvaluationFeedback | null;
  }>(),
  {
    resourceAvailable: true,
    includeMessages: false,
  },
);

const canUseFeedbackApi = Boolean(props.slug) && props.feedback === undefined;
const feedbackClient = canUseFeedbackApi && typeof useSubmissionFeedback === 'function'
  ? (() => {
    try {
      return useSubmissionFeedback();
    } catch {
      return null;
    }
  })()
  : null;

const resolvedFeedback = computed<EvaluationFeedback | null>(() => {
  if (props.feedback !== undefined) return props.feedback;
  return feedbackClient?.feedback.value ?? null;
});

const blocked = computed(() => props.resultVisibility === 'hidden' || props.resourceAvailable === false);

const hasRenderableContent = computed(() => {
  const fb = resolvedFeedback.value;
  if (!fb || !fb.visible) return false;
  return fb.metrics.length > 0 ||
    fb.summary !== null ||
    fb.traces.length > 0 ||
    fb.badcases.length > 0;
});

async function refreshFeedback() {
  if (!feedbackClient || !props.slug || !props.targetId || blocked.value) return;
  await feedbackClient.loadFeedback({
    slug: props.slug,
    id: props.targetId,
    kind: props.kind,
    attemptId: props.attemptId,
    includeMessages: props.includeMessages,
  });
}

onMounted(() => {
  void refreshFeedback();
});

watch(
  () => [
    props.slug,
    props.targetId,
    props.status,
    props.attemptId,
    props.resultVisibility,
    props.resourceAvailable,
    props.includeMessages,
  ],
  () => {
    if (blocked.value) {
      feedbackClient?.reset();
      return;
    }
    void refreshFeedback();
  },
);
</script>

<template>
  <div v-if="!blocked && hasRenderableContent && resolvedFeedback" class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-sparkles" class="size-4 text-primary" />
        <h3 class="text-sm font-semibold text-text">AI 评测可视化反馈</h3>
        <UBadge v-if="resolvedFeedback.visibility === 'summary'" size="xs" color="info" variant="subtle">
          仅摘要模式
        </UBadge>
      </div>
      <span
        v-if="!resolvedFeedback.gateway_available && !resolvedFeedback.summary"
        class="text-xs text-text-muted"
      >
        LLM 用量网关暂不可用，已隐藏模型调用明细
      </span>
    </div>

    <MetricRadarChart
      v-if="resolvedFeedback.metrics.length > 0"
      :metrics="resolvedFeedback.metrics"
    />

    <LlmTraceTimeline
      v-if="resolvedFeedback.summary || resolvedFeedback.traces.length > 0"
      :summary="resolvedFeedback.summary"
      :traces="resolvedFeedback.traces"
      :gateway-available="resolvedFeedback.gateway_available"
      :compact="resolvedFeedback.visibility === 'summary'"
    />

    <BadcaseComparison
      v-if="resolvedFeedback.visibility === 'cases' && resolvedFeedback.badcases.length > 0"
      :badcases="resolvedFeedback.badcases"
    />
  </div>
</template>
