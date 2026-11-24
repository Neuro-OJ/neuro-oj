<script setup lang="ts">
import { computed, ref } from 'vue';
import { computeRadarGeometry, type FeedbackMetric, formatMetricValue } from '~/utils/domain/submission/aiFeedback';

const props = withDefaults(
  defineProps<{
    metrics: FeedbackMetric[];
    title?: string;
  }>(),
  {
    title: '分项能力雷达图',
  },
);

const hoveredKey = ref<string | null>(null);
const geometry = computed(() => computeRadarGeometry(props.metrics, 280));
const isRadar = computed(() => props.metrics.length >= 3 && geometry.value.axes.length >= 3);
const activeAxis = computed(() => {
  if (!geometry.value.axes.length) return null;
  return geometry.value.axes.find((axis) => axis.key === hoveredKey.value) ?? null;
});
</script>

<template>
  <section
    v-if="metrics.length > 0"
    class="rounded-lg border border-border bg-bg-panel p-4 shadow-card"
    aria-label="分项能力评估"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-radar" class="size-4 text-primary" />
        <h3 class="text-sm font-semibold text-text">{{ title }}</h3>
      </div>
      <div
        v-if="activeAxis"
        class="inline-flex items-center gap-1.5 rounded bg-primary-bg px-2 py-0.5 text-xs font-medium text-primary-dark tabular-nums"
      >
        <span>{{ activeAxis.label }}</span>
        <span class="font-bold">{{ activeAxis.scoreText }}</span>
        <span class="text-text-muted">({{ activeAxis.percent }}%)</span>
      </div>
      <span v-else class="text-xs text-text-muted">悬停顶点查看精确得分</span>
    </div>

    <div v-if="isRadar" class="grid items-center gap-4 md:grid-cols-[280px_1fr]">
      <div class="flex justify-center">
        <svg
          :viewBox="`0 0 ${geometry.size} ${geometry.size}`"
          class="h-auto w-full max-w-[280px] select-none"
          role="img"
          :aria-label="title"
        >
          <!-- 同心网格层 -->
          <polygon
            v-for="(ring, idx) in geometry.rings"
            :key="`ring-${idx}`"
            :points="ring"
            fill="none"
            stroke="var(--c-border)"
            stroke-width="1"
            :stroke-dasharray="idx < geometry.rings.length - 1 ? '3 3' : undefined"
          />

          <!-- 维度轴线 -->
          <line
            v-for="axis in geometry.axes"
            :key="`axis-${axis.key}`"
            :x1="axis.x1"
            :y1="axis.y1"
            :x2="axis.x2"
            :y2="axis.y2"
            stroke="var(--c-border)"
            stroke-width="1"
          />

          <!-- 能力覆盖多边形 -->
          <polygon
            :points="geometry.polygonPoints"
            fill="var(--c-primary)"
            fill-opacity="0.18"
            stroke="var(--c-primary)"
            stroke-width="2"
            stroke-linejoin="round"
          />

          <!-- 维度标签与交互顶点 -->
          <g v-for="axis in geometry.axes" :key="`node-${axis.key}`">
            <text
              :x="axis.labelX"
              :y="axis.labelY"
              :text-anchor="axis.textAnchor"
              dominant-baseline="central"
              class="fill-text-secondary text-[11px] font-medium"
            >
              {{ axis.label }}
            </text>
            <circle
              :cx="axis.pointX"
              :cy="axis.pointY"
              :r="hoveredKey === axis.key ? 5.5 : 4"
              fill="var(--c-primary)"
              stroke="var(--c-bg-panel)"
              stroke-width="1.5"
              class="transition-all"
            />
            <circle
              :cx="axis.pointX"
              :cy="axis.pointY"
              r="12"
              fill="transparent"
              tabindex="0"
              class="cursor-pointer outline-none"
              :aria-label="`${axis.label}: ${axis.scoreText}`"
              @mouseenter="hoveredKey = axis.key"
              @mouseleave="hoveredKey = null"
              @focus="hoveredKey = axis.key"
              @blur="hoveredKey = null"
            />
          </g>
        </svg>
      </div>

      <!-- 维度数值明细 -->
      <div class="space-y-2.5">
        <div
          v-for="axis in geometry.axes"
          :key="`detail-${axis.key}`"
          class="rounded border px-3 py-2 transition-colors"
          :class="hoveredKey === axis.key ? 'border-primary bg-primary-bg/40' : 'border-border bg-bg-sunken/40'"
          @mouseenter="hoveredKey = axis.key"
          @mouseleave="hoveredKey = null"
        >
          <div class="flex items-center justify-between gap-2 text-xs">
            <span class="font-medium text-text">{{ axis.label }}</span>
            <span class="font-semibold text-text tabular-nums">
              {{ axis.scoreText }}
              <span class="ml-1 text-text-muted">({{ axis.percent }}%)</span>
            </span>
          </div>
          <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm bg-bg-sunken">
            <div
              class="h-full rounded-sm bg-primary transition-all"
              :style="{ width: `${axis.percent}%` }"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 不足 3 个维度时降级为横向条形指标卡 -->
    <div v-else class="grid gap-2.5 sm:grid-cols-2">
      <div
        v-for="metric in metrics"
        :key="metric.key"
        class="rounded border border-border bg-bg-sunken/40 px-3 py-2"
      >
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="font-medium text-text">{{ metric.label }}</span>
          <span class="font-semibold text-primary tabular-nums">{{ formatMetricValue(metric) }}</span>
        </div>
        <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm bg-bg-sunken">
          <div
            class="h-full rounded-sm bg-primary"
            :style="{ width: `${Math.min(100, Math.max(0, (metric.score / metric.max_score) * 100))}%` }"
          />
        </div>
      </div>
    </div>
  </section>
</template>
