<script setup lang="ts">
/**
 * 知识图谱轻量技能树视图（左栏领域总览导航 + 右侧全图/单领域 DAG 画布）：
 * - 左侧栏集中展示全图完成度、节点搜索定位与 14 领域进度列表，消除顶部冗余横条；
 * - 右侧支持「全图总览」（可拖拽、触控板平移/缩放、小地图、全屏、跨领域依赖链高亮）
 *   与「单领域精读 DAG」一键切换；
 * - 严格使用 Precision Instrument 设计 Token（Signal 绿 / Primary 蓝 / Neutral 灰 / 6px 圆角）。
 */
import { computed, nextTick, ref, watch } from 'vue';
import KnowledgeGlobalOverview from '~/components/knowledge/KnowledgeGlobalOverview.vue';
import type { KnowledgeGraph, KnowledgeRecommendation, MasteryItem } from '~/utils/domain/education/knowledge';
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
    canMarkFamiliar?: boolean;
    markingNodeId?: string | null;
  }>(),
  {
    masteryItems: () => [],
    recommendations: () => [],
    placedNodeIds: () => [],
    canMarkFamiliar: false,
    markingNodeId: null,
  },
);

const emit = defineEmits<{
  (e: 'mark-familiar', payload: { nodeId: string; includePrerequisites: boolean }): void;
  (e: 'unmark-familiar', nodeId: string): void;
}>();

const selectedSyllabus = ref<'all' | 'ioai' | 'noai' | 'lmcc'>('all');
const onlyWithProblems = ref(false);
const hoveredNodeId = ref<string | null>(null);
const viewMode = ref<'overview' | 'area'>('overview');
const selectedAreaId = ref('');
const focusedAreaId = ref<string | null>(null);
const searchQuery = ref('');
const searchFocused = ref(false);
const overviewRef = ref<InstanceType<typeof KnowledgeGlobalOverview> | null>(null);

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

const areaNameMap = computed(() => {
  const map = new Map<string, string>();
  for (const area of props.graph?.areas ?? []) {
    map.set(area.id, area.name);
  }
  return map;
});

const globalTotals = computed(() => {
  let total = 0;
  let mastered = 0;
  let placed = 0;
  let learning = 0;
  let review = 0;
  for (const area of areas.value) {
    total += area.totalNodes;
    mastered += area.masteredCount;
    placed += area.placedCount;
    learning += area.learningCount;
    review += area.reviewCount;
  }
  const done = mastered + placed;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return { total, mastered, placed, learning, review, done, percent };
});

const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q || !props.graph) return [];
  const normSyllabus = selectedSyllabus.value.toLowerCase();
  return props.graph.nodes
    .filter((node) => {
      if (
        normSyllabus !== 'all' &&
        (!node.syllabus || !node.syllabus.some((tag) => tag.toLowerCase() === normSyllabus))
      ) {
        return false;
      }
      if (onlyWithProblems.value) {
        const count = node.problem_count ?? masteryByNode.value.get(node.id)?.problem_count ?? 0;
        if (count <= 0) return false;
      }
      return (
        node.name.toLowerCase().includes(q) ||
        node.id.toLowerCase().includes(q) ||
        (areaNameMap.value.get(node.area)?.toLowerCase().includes(q) ?? false)
      );
    })
    .slice(0, 8);
});

function openOverview() {
  viewMode.value = 'overview';
  focusedAreaId.value = null;
  void nextTick(() => overviewRef.value?.fitToViewport());
}

function openArea(areaId: string) {
  selectedAreaId.value = areaId;
  focusedAreaId.value = areaId;
  viewMode.value = 'area';
}

function focusAreaInOverview(areaId: string) {
  focusedAreaId.value = areaId;
  if (viewMode.value !== 'overview') {
    viewMode.value = 'overview';
    void nextTick(() => overviewRef.value?.focusArea(areaId));
  } else {
    overviewRef.value?.focusArea(areaId);
  }
}

function jumpToSearchHit(nodeId: string, areaId: string) {
  searchQuery.value = '';
  searchFocused.value = false;
  focusedAreaId.value = areaId;
  if (viewMode.value !== 'overview') {
    viewMode.value = 'overview';
    void nextTick(() => overviewRef.value?.focusNodeById(nodeId));
  } else {
    overviewRef.value?.focusNodeById(nodeId);
  }
}

function onSearchBlur() {
  globalThis.setTimeout(() => {
    searchFocused.value = false;
  }, 160);
}

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

function areaSegmentWidth(count: number, total: number): string {
  if (total <= 0 || count <= 0) return '0%';
  return `${Math.min(100, (count / total) * 100)}%`;
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
      return '已标熟';
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
    <!-- 顶部标题 + 考纲/有题过滤 -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 id="skill-tree-heading" class="text-lg font-semibold text-text">AI 知识技能树</h2>
        <p class="text-xs text-text-secondary">
          左侧按 14 领域总览进度与定位，右侧自由平移缩放全图或切换单领域精读。
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

        <label
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-border bg-bg-panel px-2.5 py-1 text-xs text-text-secondary">
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

    <!-- 状态图例 -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-signal" />已掌握
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-primary" />学习中 / 推荐 / 已标熟
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-text-secondary" />前置已通
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-border-strong" />前置未完成
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full bg-warning" />待复习
      </span>
    </div>

    <!-- 主体：左侧领域总览导航栏 + 右侧交互画布 -->
    <div class="grid gap-3 lg:grid-cols-[264px_minmax(0,1fr)] lg:items-start">
      <!-- 左侧栏：全局进度 + 搜索 + 14 领域进度列表 -->
      <aside
        class="flex flex-col overflow-hidden rounded-[6px] border border-border bg-bg-panel lg:max-h-[666px]"
        data-testid="overview-area-sidebar"
      >
        <!-- 全局进度遥测 -->
        <div class="space-y-2 border-b border-border p-3">
          <div class="flex items-center justify-between text-xs">
            <span class="font-semibold text-text">全图进度</span>
            <span class="font-medium text-signal tabular-nums">
              {{ globalTotals.done }}/{{ globalTotals.total }}（{{ globalTotals.percent }}%）
            </span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-bg-sunken">
            <div
              class="h-full bg-signal transition-all"
              :style="{ width: `${globalTotals.percent}%` }"
            />
          </div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted tabular-nums">
            <span>已掌握 {{ globalTotals.mastered }}</span>
            <span v-if="globalTotals.placed > 0">已标熟 {{ globalTotals.placed }}</span>
            <span class="text-primary">学习中 {{ globalTotals.learning }}</span>
            <span v-if="globalTotals.review > 0" class="text-verdict-partial">
              待复习 {{ globalTotals.review }}
            </span>
          </div>

          <!-- 节点搜索框 -->
          <div class="relative pt-1">
            <UInput
              v-model="searchQuery"
              type="search"
              size="xs"
              icon="i-lucide-search"
              placeholder="搜索并定位知识点..."
              class="w-full"
              data-testid="overview-search-input"
              @focus="searchFocused = true"
              @blur="onSearchBlur"
            />
            <ul
              v-if="searchFocused && searchResults.length > 0"
              class="absolute left-0 right-0 top-full z-40 mt-1 max-h-60 overflow-y-auto rounded-[6px] border border-border-strong bg-bg-elevated py-1 shadow-dropdown"
              data-testid="overview-search-results"
            >
              <li v-for="hit in searchResults" :key="hit.id">
                <UButton
                  type="button"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  block
                  class="justify-between rounded-none px-2.5 py-1.5 text-left hover:bg-primary-bg/70"
                  @mousedown.prevent="jumpToSearchHit(hit.id, hit.area)"
                >
                  <span class="truncate font-medium text-text">{{ hit.name }}</span>
                  <span class="shrink-0 text-[10px] text-text-muted">
                    {{ areaNameMap.get(hit.area) ?? hit.area }}
                  </span>
                </UButton>
              </li>
            </ul>
          </div>
        </div>

        <!-- 全图总览入口 + 14 领域滚动列表 -->
        <div
          class="flex-1 divide-y divide-border/70 overflow-y-auto"
          role="tablist"
          aria-label="知识领域"
          data-testid="overview-area-grid"
        >
          <UButton
            type="button"
            role="tab"
            :aria-selected="viewMode === 'overview' && focusedAreaId === null"
            :color="viewMode === 'overview' && focusedAreaId === null ? 'primary' : 'neutral'"
            :variant="viewMode === 'overview' && focusedAreaId === null ? 'soft' : 'ghost'"
            size="xs"
            block
            class="justify-between rounded-none px-3 py-2 text-left font-medium"
            data-testid="skill-area-tab-overview"
            @click="openOverview()"
          >
            <span>全图总览（适配全部）</span>
            <span class="text-[11px] tabular-nums opacity-80">{{ areas.length }} 域</span>
          </UButton>

          <div
            v-for="area in areas"
            :key="area.id"
            class="px-3 py-2 transition-colors"
            :class="(viewMode === 'area' && selectedAreaId === area.id) ||
                (viewMode === 'overview' && focusedAreaId === area.id)
              ? 'bg-primary-bg/60'
              : 'hover:bg-bg-sunken/50'"
            :data-testid="`overview-area-card-${area.id}`"
          >
            <div class="flex items-center justify-between gap-2">
              <UButton
                type="button"
                :color="(viewMode === 'area' && selectedAreaId === area.id) ||
                    (viewMode === 'overview' && focusedAreaId === area.id)
                  ? 'primary'
                  : 'neutral'"
                variant="link"
                size="xs"
                class="min-w-0 flex-1 justify-start truncate p-0 text-left font-semibold"
                :title="`${area.name}（点击在总览中聚焦）`"
                @click="focusAreaInOverview(area.id)"
              >
                {{ area.name }}
              </UButton>
              <span class="shrink-0 text-[11px] font-medium text-text-secondary tabular-nums">
                {{ area.masteredCount + area.placedCount }}/{{ area.totalNodes }}
              </span>
            </div>

            <div class="mt-1.5 flex h-1 overflow-hidden rounded-full bg-bg-sunken">
              <div
                class="h-full bg-signal"
                :style="{ width: areaSegmentWidth(area.masteredCount, area.totalNodes) }"
              />
              <div
                class="h-full bg-primary"
                :style="{ width: areaSegmentWidth(area.placedCount + area.learningCount, area.totalNodes) }"
              />
            </div>

            <div class="mt-1.5 flex items-center justify-between gap-1 text-[10px] text-text-muted tabular-nums">
              <span class="inline-flex items-center gap-1.5 truncate">
                <span v-if="area.avgAbility !== null" class="font-medium text-text-secondary">
                  均分 {{ area.avgAbility }}
                </span>
                <span v-else>题 {{ area.availableProblems }}</span>
                <span v-if="area.reviewCount > 0" class="text-verdict-partial">
                  复习 {{ area.reviewCount }}
                </span>
              </span>

              <UButton
                type="button"
                role="tab"
                :aria-selected="viewMode === 'area' && selectedAreaId === area.id"
                color="primary"
                :variant="viewMode === 'area' && selectedAreaId === area.id ? 'solid' : 'ghost'"
                size="xs"
                class="shrink-0 px-1.5 py-0.5 text-[10px]"
                :data-testid="`skill-area-tab-${area.id}`"
                @click="openArea(area.id)"
              >
                单域 {{ area.masteredCount + area.placedCount }}/{{ area.totalNodes }}
              </UButton>
            </div>
          </div>
        </div>
      </aside>

      <!-- 右侧主画布区：全图总览 OR 单领域精读 -->
      <div class="min-w-0">
        <KnowledgeGlobalOverview
          v-if="viewMode === 'overview'"
          ref="overviewRef"
          :graph="graph"
          :slug="slug"
          :syllabus="selectedSyllabus"
          :only-with-problems="onlyWithProblems"
          :mastery-by-node="masteryByNode"
          :placed-node-ids="placedSet"
          :recommended-ids="recommendedSet"
          :focused-area-id="focusedAreaId"
          :can-mark-familiar="canMarkFamiliar"
          :marking-node-id="markingNodeId"
          @select-area="openArea"
          @focus-area-change="focusedAreaId = $event"
          @mark-familiar="emit('mark-familiar', $event)"
          @unmark-familiar="emit('unmark-familiar', $event)"
        />

        <div
          v-else
          class="overflow-hidden rounded-[6px] border border-border bg-bg-panel"
        >
          <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
            <span class="font-semibold text-text">
              {{ areaNameMap.get(selectedAreaId) ?? selectedAreaId }} · 单领域拓扑
            </span>
            <UButton
              type="button"
              color="primary"
              variant="ghost"
              size="xs"
              icon="i-lucide-arrow-left"
              @click="openOverview()"
            >
              返回全图总览
            </UButton>
          </div>

          <div
            v-if="layout.nodes.length === 0"
            class="px-4 py-12 text-center text-sm text-text-secondary"
          >
            当前筛选条件下暂无匹配知识点，请取消「只显示有题节点」或切换考纲。
          </div>
          <div
            v-else
            class="h-[620px] overflow-auto bg-bg-sunken/40"
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
                  <span class="inline-flex shrink-0 items-center gap-1">
                    <span
                      v-if="item.needsReview"
                      class="rounded-[4px] bg-verdict-partial-bg px-1.5 py-0.5 text-[10px] font-medium text-verdict-partial"
                      data-testid="skill-node-review-badge"
                    >
                      待复习
                    </span>
                    <span
                      class="rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium"
                      :class="badgeClass(item.status)"
                    >
                      {{ statusLabel(item.status) }}
                    </span>
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
                    <span
                      v-if="item.abilityScore !== null && item.abilityScore > 0"
                      class="font-medium text-text-secondary"
                      data-testid="skill-node-ability"
                    >
                      能力 {{ item.abilityScore }}
                    </span>
                    <span v-if="item.hasDoc" class="text-primary" title="含原理讲解">讲解</span>
                    <span>题 {{ item.problemCount }}</span>
                  </span>
                </div>
              </NuxtLink>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
