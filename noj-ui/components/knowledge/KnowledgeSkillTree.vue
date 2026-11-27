<script setup lang="ts">
/**
 * 知识图谱轻量技能树视图（DAG）：
 * - 按 14 领域分 Tab 展示，支持按考纲（IOAI / NOAI / LMCC）与「仅看有题节点」过滤；
 * - 拓扑分层布局 + SVG 依赖连线，悬停节点高亮上下游前置/后继连线；
 * - 严格使用 Precision Instrument 设计 Token（Signal 绿 / Primary 蓝 / Neutral 灰，1px 发丝边与 6px 圆角）。
 */
import { computed, ref, watch } from 'vue';
import type {
  KnowledgeGraph,
  KnowledgeRecommendation,
  MasteryItem,
} from '~/utils/domain/education/knowledge';
import {
  buildSkillTreeLayout,
  type SkillTreeNodeLayout,
  type SkillTreeNodeStatus,
  summarizeSkillTreeAreas,
} from '~/utils/domain/education/knowledgeTree';

const props = withDefaults(
  defineProps<{
    graph: KnowledgeGraph | null;
    slug: string;
    masteryItems?: MasteryItem[];
    recommendations?: KnowledgeRecommendation[];
    placedNodeIds?: string[];
  }>(),
  {
    masteryItems: () => [],
    recommendations: () => [],
    placedNodeIds: () => [],
  },
);

const selectedSyllabus = ref<'all' | 'ioai' | 'noai' | 'lmcc'>('all');
const onlyWithProblems = ref(false);
const hoveredNodeId = ref<string | null>(null);

const masteryByNode = computed(() => {
  const map = new Map<string, MasteryItem>();
  for (const item of props.masteryItems) {
    map.set(item.node_id, item);
  }
  return map;
});

const placedSet = computed(() => new Set(props.placedNodeIds));
const recommendedSet = computed(() => new Set(props.recommendations.map((item) => item.node.id)));

const areas = computed(() =>
  summarizeSkillTreeAreas(props.graph, masteryByNode.value, placedSet.value, selectedSyllabus.value)
);

const selectedAreaId = ref('');

watch(
  areas,
  (nextAreas) => {
    if (nextAreas.length === 0) {
      selectedAreaId.value = '';
      return;
    }
    if (!nextAreas.some((area) => area.id === selectedAreaId.value)) {
      const preferred = nextAreas.find((area) => area.availableProblems > 0) ?? nextAreas[0]!;
      selectedAreaId.value = preferred.id;
    }
  },
  { immediate: true },
);

const layout = computed(() =>
  buildSkillTreeLayout(props.graph, {
    areaId: selectedAreaId.value,
    syllabus: selectedSyllabus.value,
    onlyWithProblems: onlyWithProblems.value,
    masteryByNode: masteryByNode.value,
    placedNodeIds: placedSet.value,
    recommendedIds: recommendedSet.value,
  })
);

const activeNodeLayout = computed<SkillTreeNodeLayout | null>(() => {
  if (!hoveredNodeId.value) return null;
  return layout.value.nodes.find((item) => item.node.id === hoveredNodeId.value) ?? null;
});

const highlightedIds = computed(() => {
  const active = activeNodeLayout.value;
  if (!active) return null;
  return new Set<string>([active.node.id, ...active.requiresInArea, ...active.dependentsInArea]);
});

function nodePath(id: string): string {
  return `/d/${encodeURIComponent(props.slug)}/knowledge/${encodeURIComponent(id)}`;
}

function isEdgeHighlighted(fromId: string, toId: string): boolean {
  if (!hoveredNodeId.value) return false;
  return fromId === hoveredNodeId.value || toId === hoveredNodeId.value;
}

function statusLabel(status: SkillTreeNodeStatus): string {
  switch (status) {
    case 'mastered':
      return '已掌握';
    case 'placed':
      return '已摸底';
    case 'learning':
      return '学习中';
    case 'recommended':
      return '推荐';
    case 'available':
      return '已解锁';
    default:
      return '未解锁';
  }
}

function statusDotClass(status: SkillTreeNodeStatus): string {
  switch (status) {
    case 'mastered':
      return 'bg-signal';
    case 'placed':
    case 'learning':
    case 'recommended':
      return 'bg-primary';
    case 'available':
      return 'bg-text-secondary';
    default:
      return 'bg-border-strong';
  }
}

function cardClass(item: SkillTreeNodeLayout): string {
  const dimmed = highlightedIds.value && !highlightedIds.value.has(item.node.id);
  const opacity = dimmed ? 'opacity-45' : 'opacity-100';
  switch (item.status) {
    case 'mastered':
      return `${opacity} border-signal/40 bg-verdict-accepted-bg/40 hover:border-signal`;
    case 'placed':
    case 'recommended':
      return `${opacity} border-primary/50 bg-primary-bg/70 hover:border-primary`;
    case 'learning':
      return `${opacity} border-primary/40 bg-bg-panel hover:border-primary`;
    case 'available':
      return `${opacity} border-border bg-bg-panel hover:border-primary/60`;
    default:
      return `${opacity} border-border bg-bg-sunken/70 hover:border-border-strong`;
  }
}

function badgeClass(status: SkillTreeNodeStatus): string {
  switch (status) {
    case 'mastered':
      return 'bg-verdict-accepted-bg text-verdict-accepted';
    case 'placed':
    case 'learning':
    case 'recommended':
      return 'bg-primary-bg text-primary';
    case 'available':
      return 'bg-bg-sunken text-text-secondary';
    default:
      return 'bg-bg-sunken text-text-muted';
  }
}
</script>

<template>
  <section
    v-if="graph && graph.nodes.length > 0"
    aria-labelledby="skill-tree-heading"
    class="space-y-3"
    data-testid="knowledge-skill-tree"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 id="skill-tree-heading" class="text-lg font-semibold text-text">AI 知识技能树</h2>
        <p class="text-xs text-text-secondary">
          按领域展示前置依赖拓扑，悬停节点可高亮上下游路径，点击进入讲解与阶梯练习。
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="inline-flex rounded-[4px] border border-border bg-bg-panel p-0.5 text-xs">
          <button
            v-for="item in [
              { id: 'all', label: '全部考纲' },
              { id: 'ioai', label: 'IOAI' },
              { id: 'noai', label: 'NOAI' },
              { id: 'lmcc', label: 'LMCC' },
            ]"
            :key="item.id"
            type="button"
            class="rounded-[4px] px-2 py-1 font-medium transition-colors"
            :class="selectedSyllabus === item.id
              ? 'bg-primary-bg text-primary'
              : 'text-text-secondary hover:text-text'"
            @click="selectedSyllabus = item.id as typeof selectedSyllabus"
          >
            {{ item.label }}
          </button>
        </div>

        <label class="inline-flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-border bg-bg-panel px-2.5 py-1 text-xs text-text-secondary">
          <input
            v-model="onlyWithProblems"
            type="checkbox"
            class="accent-primary"
            data-testid="skill-tree-only-problems"
          />
          只显示有题节点
        </label>
      </div>
    </div>

    <!-- 领域导航栏 -->
    <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="知识领域">
      <button
        v-for="area in areas"
        :key="area.id"
        type="button"
        role="tab"
        :aria-selected="selectedAreaId === area.id"
        class="inline-flex items-center gap-1.5 rounded-[4px] border px-2.5 py-1 text-xs font-medium transition-colors"
        :class="selectedAreaId === area.id
          ? 'border-primary bg-primary-bg text-primary'
          : 'border-border bg-bg-panel text-text-secondary hover:border-border-strong hover:text-text'"
        :data-testid="`skill-area-tab-${area.id}`"
        @click="selectedAreaId = area.id"
      >
        <span>{{ area.name }}</span>
        <span class="tabular-nums text-[11px] opacity-80">
          {{ area.masteredCount + area.placedCount }}/{{ area.totalNodes }}
        </span>
      </button>
    </div>

    <!-- 状态图例 -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-signal" />已掌握
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-primary" />学习中 / 推荐 / 已摸底
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-text-secondary" />前置已通
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-border-strong" />前置未完成
      </span>
    </div>

    <!-- 拓扑 DAG 画布 -->
    <div
      v-if="layout.nodes.length === 0"
      class="rounded-[6px] border border-border bg-bg-panel px-4 py-8 text-center text-sm text-text-secondary"
    >
      当前筛选条件下暂无匹配知识点，请取消「只显示有题节点」或切换考纲。
    </div>
    <div
      v-else
      class="overflow-x-auto rounded-[6px] border border-border bg-bg-sunken/40"
    >
      <div
        class="relative"
        :style="{ width: `${layout.width}px`, height: `${layout.height}px` }"
      >
        <svg
          class="pointer-events-none absolute inset-0"
          :width="layout.width"
          :height="layout.height"
          aria-hidden="true"
        >
          <path
            v-for="edge in layout.edges"
            :key="edge.id"
            :d="edge.path"
            fill="none"
            :stroke="isEdgeHighlighted(edge.fromId, edge.toId) ? 'var(--c-primary)' : 'var(--c-border-strong)'"
            :stroke-width="isEdgeHighlighted(edge.fromId, edge.toId) ? 2 : 1.25"
            :stroke-opacity="hoveredNodeId && !isEdgeHighlighted(edge.fromId, edge.toId) ? 0.25 : 0.85"
          />
        </svg>

        <NuxtLink
          v-for="item in layout.nodes"
          :key="item.node.id"
          :to="nodePath(item.node.id)"
          class="absolute flex flex-col justify-between rounded-[6px] border p-2.5 no-underline shadow-card transition-all"
          :class="cardClass(item)"
          :style="{
            left: `${item.x}px`,
            top: `${item.y}px`,
            width: `${item.width}px`,
            height: `${item.height}px`,
          }"
          :data-testid="`skill-node-${item.node.id}`"
          @mouseenter="hoveredNodeId = item.node.id"
          @mouseleave="hoveredNodeId = null"
          @focus="hoveredNodeId = item.node.id"
          @blur="hoveredNodeId = null"
        >
          <div class="flex items-start justify-between gap-1.5">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="size-2 shrink-0 rounded-full" :class="statusDotClass(item.status)" />
              <span class="line-clamp-2 text-xs font-semibold leading-snug text-text">
                {{ item.node.name }}
              </span>
            </div>
            <span
              class="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium"
              :class="badgeClass(item.status)"
            >
              {{ statusLabel(item.status) }}
            </span>
          </div>

          <div class="flex items-center justify-between gap-2 text-[11px] text-text-muted tabular-nums">
            <span class="truncate">
              <template v-if="item.externalRequires.length > 0">
                前置域 {{ item.externalRequires.filter((r) => r.completed).length }}/{{ item.externalRequires.length }}
              </template>
              <template v-else>
                {{ item.node.id }}
              </template>
            </span>
            <span class="inline-flex shrink-0 items-center gap-2">
              <span v-if="item.hasDoc" class="text-primary" title="含原理讲解">讲解</span>
              <span>题 {{ item.problemCount }}</span>
            </span>
          </div>
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
