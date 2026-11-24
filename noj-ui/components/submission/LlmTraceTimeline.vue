<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  computeTraceBarStyle,
  computeTraceSpanMs,
  formatFeedbackCost,
  formatFeedbackTokens,
  type LlmSummaryStats,
  type LlmTraceItem,
} from '~/utils/domain/submission/aiFeedback';
import { formatTime } from '~/utils/domain/submission/submissionFormat';

const props = withDefaults(
  defineProps<{
    summary: LlmSummaryStats | null;
    traces: LlmTraceItem[];
    gatewayAvailable?: boolean;
    compact?: boolean;
  }>(),
  {
    gatewayAvailable: true,
    compact: false,
  },
);

const expandedId = ref<string | null>(null);
const totalSpanMs = computed(() => computeTraceSpanMs(props.traces));

function toggleTrace(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

function isErrorTrace(trace: LlmTraceItem): boolean {
  return trace.status !== 'ok';
}

function formatMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content ?? '');
  }
}

function barStyle(trace: LlmTraceItem) {
  const { leftPercent, widthPercent } = computeTraceBarStyle(trace, totalSpanMs.value);
  return { left: `${leftPercent}%`, width: `${widthPercent}%` };
}
</script>

<template>
  <section
    v-if="summary || traces.length > 0"
    class="rounded-lg border border-border bg-bg-panel p-4 shadow-card"
    aria-label="LLM 调用追踪"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-activity" class="size-4 text-primary" />
        <h3 class="text-sm font-semibold text-text">LLM 调用与成本概览</h3>
      </div>
      <span v-if="traces.length > 0" class="text-xs text-text-muted tabular-nums">
        总跨度 {{ formatTime(totalSpanMs) }} · {{ traces.length }} 步调用
      </span>
    </div>

    <!-- 汇总指标胶囊 -->
    <div v-if="summary" class="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <div class="rounded border border-border bg-bg-sunken/50 px-3 py-2 tabular-nums">
        <p class="text-[11px] text-text-muted">调用次数</p>
        <p class="mt-0.5 text-base font-bold text-text">
          {{ summary.total_calls }}
          <span v-if="summary.error_calls > 0" class="ml-1 text-xs font-medium text-error-text">
            ({{ summary.error_calls }} 失败)
          </span>
        </p>
      </div>
      <div class="rounded border border-border bg-bg-sunken/50 px-3 py-2 tabular-nums">
        <p class="text-[11px] text-text-muted">Token 消耗</p>
        <p class="mt-0.5 text-base font-bold text-text">{{ formatFeedbackTokens(summary.total_tokens) }}</p>
        <p class="text-[11px] text-text-muted">
          输入 {{ formatFeedbackTokens(summary.prompt_tokens) }} / 输出 {{ formatFeedbackTokens(summary.completion_tokens) }}
          <span v-if="summary.cached_prompt_tokens > 0">· 缓存 {{ formatFeedbackTokens(summary.cached_prompt_tokens) }}</span>
        </p>
      </div>
      <div class="rounded border border-border bg-bg-sunken/50 px-3 py-2 tabular-nums">
        <p class="text-[11px] text-text-muted">估算成本</p>
        <p class="mt-0.5 text-base font-bold text-primary">{{ formatFeedbackCost(summary.estimated_cost) }}</p>
      </div>
      <div class="rounded border border-border bg-bg-sunken/50 px-3 py-2 tabular-nums">
        <p class="text-[11px] text-text-muted">延迟统计</p>
        <p class="mt-0.5 text-base font-bold text-text">
          均 {{ formatTime(summary.avg_latency_ms) }}
        </p>
        <p class="text-[11px] text-text-muted">
          P95 {{ formatTime(summary.p95_latency_ms) }} · 累计 {{ formatTime(summary.total_latency_ms) }}
        </p>
      </div>
    </div>

    <!-- 分模型聚合胶囊 -->
    <div v-if="summary?.models?.length" class="mb-4 flex flex-wrap gap-2">
      <div
        v-for="item in summary.models"
        :key="item.model"
        class="inline-flex items-center gap-2 rounded border border-border bg-bg-page px-2.5 py-1 text-xs tabular-nums"
      >
        <span class="font-mono font-medium text-text">{{ item.model }}</span>
        <span class="text-text-muted">{{ item.calls }} 次</span>
        <span class="text-text-secondary">{{ formatFeedbackTokens(item.total_tokens) }} tok</span>
      </div>
    </div>

    <!-- 瀑布流时间线 -->
    <div v-if="!compact && traces.length > 0" class="space-y-2">
      <div
        v-for="trace in traces"
        :key="trace.id"
        class="overflow-hidden rounded border border-border"
      >
        <button
          type="button"
          class="flex w-full flex-wrap items-center gap-3 bg-bg-panel px-3 py-2.5 text-left text-xs transition-colors hover:bg-bg-sunken/50"
          :aria-expanded="expandedId === trace.id"
          @click="toggleTrace(trace.id)"
        >
          <span class="w-8 shrink-0 font-mono font-semibold text-text-muted tabular-nums">#{{ trace.seq }}</span>
          <span class="min-w-[110px] max-w-[160px] truncate font-mono font-medium text-text" :title="trace.model">
            {{ trace.model }}
          </span>
          <span
            class="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-semibold"
            :class="isErrorTrace(trace) ? 'bg-error-text/10 text-error-text' : 'bg-signal/15 text-signal-deep'"
          >
            {{ isErrorTrace(trace) ? (trace.error_code || trace.status) : 'OK' }}
          </span>

          <!-- 耗时瀑布条 -->
          <div class="relative h-3 min-w-[120px] flex-1 overflow-hidden rounded-sm bg-bg-sunken">
            <div
              class="absolute top-0 h-full rounded-sm transition-all"
              :class="isErrorTrace(trace) ? 'bg-error-text' : 'bg-primary'"
              :style="barStyle(trace)"
            />
          </div>

          <div class="flex shrink-0 items-center gap-3 text-text-secondary tabular-nums">
            <span>{{ formatTime(trace.latency_ms) }}</span>
            <span>{{ formatFeedbackTokens(trace.total_tokens) }} tok</span>
            <span>{{ formatFeedbackCost(trace.estimated_cost) }}</span>
            <UIcon
              :name="expandedId === trace.id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-3.5 text-text-muted"
            />
          </div>
        </button>

        <!-- 展开详情：脱敏消息、生成参数、错误详情 -->
        <div v-if="expandedId === trace.id" class="space-y-3 border-t border-border bg-bg-page/70 p-3 text-xs">
          <div class="flex flex-wrap gap-4 text-text-secondary tabular-nums">
            <span>偏移: +{{ formatTime(trace.offset_ms) }}</span>
            <span>Prompt: {{ formatFeedbackTokens(trace.prompt_tokens) }}</span>
            <span>Completion: {{ formatFeedbackTokens(trace.completion_tokens) }}</span>
            <span v-if="trace.cached_prompt_tokens > 0">
              Cached: {{ formatFeedbackTokens(trace.cached_prompt_tokens) }}
            </span>
          </div>

          <div
            v-if="trace.error_code"
            class="rounded border border-error-text/30 bg-error-text/5 px-3 py-2 text-error-text"
          >
            错误码：<span class="font-mono font-semibold">{{ trace.error_code }}</span>
          </div>

          <div v-if="Object.keys(trace.request_params).length > 0">
            <p class="mb-1 text-[11px] font-semibold text-text-muted">调用参数</p>
            <pre class="overflow-auto rounded bg-bg-sunken p-2 font-mono text-[11px] text-text">{{
              JSON.stringify(trace.request_params, null, 2)
            }}</pre>
          </div>

          <div v-if="trace.request_messages && trace.request_messages.length > 0" class="space-y-2">
            <p class="text-[11px] font-semibold text-text-muted">脱敏请求消息</p>
            <div
              v-for="(msg, mIdx) in trace.request_messages"
              :key="`${trace.id}-msg-${mIdx}`"
              class="rounded border border-border bg-bg-panel p-2.5"
            >
              <span
                class="mb-1 inline-block rounded bg-bg-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-text-secondary">
                {{ msg.role }}
              </span>
              <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-text">{{
                formatMessageContent(msg.content)
              }}</pre>
            </div>
          </div>
          <p v-else class="text-[11px] text-text-muted">
            请求消息正文已按可见性或安全策略省略。
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
