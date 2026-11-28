<script setup lang="ts">
/**
 * 知识图谱「全图总览」交互画布：
 * - 拖拽任意位置（含节点表面）流畅平移，5px 位移阈值区分点击与拖拽；
 * - 触控板双指滑动直接平移，双指捏合或 Cmd/Ctrl+滚轮以指针为中心平滑缩放；
 * - 内置交互式小地图（点击/拖拽秒速跳转视口）、全屏切换与一键适配全图；
 * - 悬停或点击节点锁定跨领域完整前置链（蓝）与后继链（绿），并弹出节点快览面板。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { KnowledgeGraph, MasteryItem } from '~/utils/domain/education/knowledge';
import {
  buildGlobalSkillTreeLayout,
  collectDependencyChain,
  type GlobalSkillTreeEdgeLayout,
  type SkillTreeNodeLayout,
  type SkillTreeNodeStatus,
} from '~/utils/domain/education/knowledgeTree';

const props = defineProps<{
  graph: KnowledgeGraph | null;
  slug: string;
  syllabus: string;
  onlyWithProblems: boolean;
  masteryByNode: ReadonlyMap<string, MasteryItem>;
  placedNodeIds: ReadonlySet<string>;
  recommendedIds: ReadonlySet<string>;
  focusedAreaId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'select-area', areaId: string): void;
  (e: 'focus-area-change', areaId: string | null): void;
}>();

const MIN_SCALE = 0.12;
const MAX_SCALE = 1.65;
const MINIMAP_W = 168;
const MINIMAP_H = 104;

const viewportRef = ref<HTMLElement | null>(null);
const viewportSize = ref({ width: 920, height: 600 });
const scale = ref(0.5);
const panX = ref(16);
const panY = ref(16);
const isDragging = ref(false);
const isMinimapDragging = ref(false);
const isFullscreen = ref(false);
const dragStart = ref({ x: 0, y: 0, panX: 0, panY: 0, moved: false });
let suppressNextClick = false;

const showCrossEdges = ref(false);
const hoveredNodeId = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
const internalFocusedAreaId = ref<string | null>(props.focusedAreaId ?? null);

watch(
  () => props.focusedAreaId,
  (next) => {
    internalFocusedAreaId.value = next ?? null;
  },
);

const globalLayout = computed(() =>
  buildGlobalSkillTreeLayout(props.graph, {
    syllabus: props.syllabus,
    onlyWithProblems: props.onlyWithProblems,
    masteryByNode: props.masteryByNode,
    placedNodeIds: props.placedNodeIds,
    recommendedIds: props.recommendedIds,
  })
);

const areaNameMap = computed(() => {
  const map = new Map<string, string>();
  for (const area of props.graph?.areas ?? []) {
    map.set(area.id, area.name);
  }
  return map;
});

const nodeLayoutById = computed(() => {
  const map = new Map<string, SkillTreeNodeLayout>();
  for (const item of globalLayout.value.nodes) {
    map.set(item.node.id, item);
  }
  return map;
});

/** 已锁定选中优先于悬停，避免聚焦后被鼠标经过的其他节点抢占高亮。 */
const activeFocusNodeId = computed(() => selectedNodeId.value ?? hoveredNodeId.value);

const activeChain = computed(() => {
  const id = activeFocusNodeId.value;
  if (!id) return null;
  const { ancestors, descendants } = collectDependencyChain(props.graph, id);
  return { center: id, ancestors, descendants };
});

const selectedNodeLayout = computed<SkillTreeNodeLayout | null>(() => {
  if (!selectedNodeId.value) return null;
  return nodeLayoutById.value.get(selectedNodeId.value) ?? null;
});

const selectedChainCounts = computed(() => {
  if (!selectedNodeId.value) return { ancestors: 0, descendants: 0 };
  const { ancestors, descendants } = collectDependencyChain(props.graph, selectedNodeId.value);
  return { ancestors: ancestors.size, descendants: descendants.size };
});

const scalePercent = computed(() => Math.round(scale.value * 100));

/** 小地图缩放与视口映射计算。 */
const minimap = computed(() => {
  const gw = Math.max(1, globalLayout.value.width);
  const gh = Math.max(1, globalLayout.value.height);
  const pad = 6;
  const ratio = Math.min((MINIMAP_W - pad * 2) / gw, (MINIMAP_H - pad * 2) / gh);
  const offsetX = (MINIMAP_W - gw * ratio) / 2;
  const offsetY = (MINIMAP_H - gh * ratio) / 2;
  const vw = viewportSize.value.width;
  const vh = viewportSize.value.height;
  const viewWorldX = -panX.value / scale.value;
  const viewWorldY = -panY.value / scale.value;
  const viewWorldW = vw / scale.value;
  const viewWorldH = vh / scale.value;
  return {
    ratio,
    offsetX,
    offsetY,
    rectX: offsetX + viewWorldX * ratio,
    rectY: offsetY + viewWorldY * ratio,
    rectW: Math.max(10, viewWorldW * ratio),
    rectH: Math.max(8, viewWorldH * ratio),
  };
});

function measureViewport() {
  const el = viewportRef.value;
  if (!el) return;
  viewportSize.value = {
    width: el.clientWidth || 920,
    height: el.clientHeight || 600,
  };
}

function clampScale(next: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next * 1000) / 1000));
}

function fitToViewport() {
  measureViewport();
  const { width, height } = globalLayout.value;
  if (!width || !height) return;
  const { width: vw, height: vh } = viewportSize.value;
  const padding = 20;
  const nextScale = clampScale(Math.min((vw - padding * 2) / width, (vh - padding * 2) / height, 1));
  scale.value = nextScale;
  panX.value = Math.round((vw - width * nextScale) / 2);
  panY.value = Math.round((vh - height * nextScale) / 2);
  internalFocusedAreaId.value = null;
  emit('focus-area-change', null);
}

function zoomAt(nextScaleRaw: number, clientX?: number, clientY?: number) {
  const el = viewportRef.value;
  const nextScale = clampScale(nextScaleRaw);
  if (Math.abs(nextScale - scale.value) < 0.001) return;
  if (el) {
    const rect = el.getBoundingClientRect();
    const cx = clientX !== undefined ? clientX - rect.left : rect.width / 2;
    const cy = clientY !== undefined ? clientY - rect.top : rect.height / 2;
    const worldX = (cx - panX.value) / scale.value;
    const worldY = (cy - panY.value) / scale.value;
    scale.value = nextScale;
    panX.value = Math.round(cx - worldX * nextScale);
    panY.value = Math.round(cy - worldY * nextScale);
  } else {
    scale.value = nextScale;
  }
}

function focusNodeById(nodeId: string) {
  const item = nodeLayoutById.value.get(nodeId);
  if (!item) return;
  measureViewport();
  hoveredNodeId.value = null;
  selectedNodeId.value = item.node.id;
  internalFocusedAreaId.value = item.node.area;
  emit('focus-area-change', item.node.area);
  const { width: vw, height: vh } = viewportSize.value;
  const targetScale = clampScale(Math.max(scale.value, 0.95));
  scale.value = targetScale;
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  panX.value = Math.round(vw / 2 - centerX * targetScale);
  panY.value = Math.round(vh / 2 - centerY * targetScale);
}

function focusArea(areaId: string) {
  const cluster = globalLayout.value.clusters.find((c) => c.areaId === areaId);
  if (!cluster) return;
  measureViewport();
  hoveredNodeId.value = null;
  selectedNodeId.value = null;
  internalFocusedAreaId.value = areaId;
  emit('focus-area-change', areaId);
  const { width: vw, height: vh } = viewportSize.value;
  const pad = 28;
  const nextScale = clampScale(
    Math.min((vw - pad * 2) / cluster.width, (vh - pad * 2) / cluster.height, 1.05),
  );
  scale.value = nextScale;
  const cx = cluster.x + cluster.width / 2;
  const cy = cluster.y + cluster.height / 2;
  panX.value = Math.round(vw / 2 - cx * nextScale);
  panY.value = Math.round(vh / 2 - cy * nextScale);
}

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
  void nextTick(() => {
    measureViewport();
    if (!selectedNodeId.value && !internalFocusedAreaId.value) {
      fitToViewport();
    }
  });
}

/**
 * 触控板 / 滚轮交互（对齐 Figma / Miro 桌面习惯）：
 * - 双指捏合或 Cmd/Ctrl + 滚轮 → 以指针为中心平滑缩放；
 * - 普通双指滑动 / 滚轮 → 直接流畅平移画布，避免误触发剧烈缩放。
 */
function onWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) {
    const zoomFactor = Math.exp(-event.deltaY * 0.008);
    zoomAt(scale.value * zoomFactor, event.clientX, event.clientY);
  } else {
    panX.value = Math.round(panX.value - event.deltaX);
    panY.value = Math.round(panY.value - event.deltaY);
  }
}

function onWindowPointerMove(event: PointerEvent) {
  if (!isDragging.value) return;
  const dx = event.clientX - dragStart.value.x;
  const dy = event.clientY - dragStart.value.y;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
    dragStart.value.moved = true;
  }
  panX.value = Math.round(dragStart.value.panX + dx);
  panY.value = Math.round(dragStart.value.panY + dy);
}

function onWindowPointerUp() {
  if (!isDragging.value) return;
  if (dragStart.value.moved) {
    suppressNextClick = true;
    globalThis.setTimeout(() => {
      suppressNextClick = false;
    }, 0);
  }
  isDragging.value = false;
  globalThis.removeEventListener?.('pointermove', onWindowPointerMove);
  globalThis.removeEventListener?.('pointerup', onWindowPointerUp);
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  // 忽略画布浮层控件内部的按下事件
  const target = event.target as HTMLElement | null;
  if (target?.closest('[data-canvas-ui="true"]')) return;
  isDragging.value = true;
  dragStart.value = {
    x: event.clientX,
    y: event.clientY,
    panX: panX.value,
    panY: panY.value,
    moved: false,
  };
  globalThis.addEventListener?.('pointermove', onWindowPointerMove);
  globalThis.addEventListener?.('pointerup', onWindowPointerUp);
}

function onCanvasBackgroundClick() {
  if (suppressNextClick) return;
  selectedNodeId.value = null;
  internalFocusedAreaId.value = null;
  emit('focus-area-change', null);
}

function onNodeClick(item: SkillTreeNodeLayout) {
  if (suppressNextClick) return;
  hoveredNodeId.value = null;
  if (selectedNodeId.value === item.node.id) {
    selectedNodeId.value = null;
  } else {
    selectedNodeId.value = item.node.id;
    internalFocusedAreaId.value = item.node.area;
    emit('focus-area-change', item.node.area);
  }
}

function onDocLinkClick(event: MouseEvent) {
  if (suppressNextClick) {
    event.preventDefault();
  }
}

function onNodeDblClick(item: SkillTreeNodeLayout) {
  if (suppressNextClick) return;
  if (typeof navigateTo === 'function') {
    void navigateTo(nodePath(item.node.id));
  }
}

function jumpFromMinimap(event: PointerEvent) {
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const { ratio, offsetX, offsetY } = minimap.value;
  if (ratio <= 0) return;
  const worldX = (mx - offsetX) / ratio;
  const worldY = (my - offsetY) / ratio;
  measureViewport();
  panX.value = Math.round(viewportSize.value.width / 2 - worldX * scale.value);
  panY.value = Math.round(viewportSize.value.height / 2 - worldY * scale.value);
}

function onMinimapPointerDown(event: PointerEvent) {
  isMinimapDragging.value = true;
  jumpFromMinimap(event);
}

function onMinimapPointerMove(event: PointerEvent) {
  if (!isMinimapDragging.value) return;
  jumpFromMinimap(event);
}

function onMinimapPointerUp() {
  isMinimapDragging.value = false;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (selectedNodeId.value) {
      selectedNodeId.value = null;
    } else if (isFullscreen.value) {
      isFullscreen.value = false;
      void nextTick(() => measureViewport());
    }
  }
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  measureViewport();
  void nextTick(() => fitToViewport());
  globalThis.addEventListener?.('keydown', onKeyDown);
  if (typeof ResizeObserver !== 'undefined' && viewportRef.value) {
    resizeObserver = new ResizeObserver(() => measureViewport());
    resizeObserver.observe(viewportRef.value);
  }
});

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('pointermove', onWindowPointerMove);
  globalThis.removeEventListener?.('pointerup', onWindowPointerUp);
  globalThis.removeEventListener?.('keydown', onKeyDown);
  resizeObserver?.disconnect();
});

watch(
  () => [props.syllabus, props.onlyWithProblems, props.graph?.nodes.length],
  () => {
    selectedNodeId.value = null;
    void nextTick(() => fitToViewport());
  },
);

defineExpose({
  focusArea,
  focusNodeById,
  fitToViewport,
});

function nodePath(id: string): string {
  return `/d/${encodeURIComponent(props.slug)}/knowledge/${encodeURIComponent(id)}`;
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

function nodeHighlightRole(nodeId: string): 'center' | 'ancestor' | 'descendant' | 'dim' | 'normal' {
  const chain = activeChain.value;
  if (!chain) return 'normal';
  if (nodeId === chain.center) return 'center';
  if (chain.ancestors.has(nodeId)) return 'ancestor';
  if (chain.descendants.has(nodeId)) return 'descendant';
  return 'dim';
}

function nodeCardClass(item: SkillTreeNodeLayout): string {
  const role = nodeHighlightRole(item.node.id);
  const ring = role === 'center'
    ? 'ring-2 ring-primary z-20'
    : role === 'ancestor'
    ? 'ring-1 ring-primary/80 z-10'
    : role === 'descendant'
    ? 'ring-1 ring-signal/80 z-10'
    : '';
  const opacity = role === 'dim' ? 'opacity-25' : 'opacity-100';
  let base: string;
  switch (item.status) {
    case 'mastered':
      base = 'border-signal/45 bg-verdict-accepted-bg/50 hover:border-signal';
      break;
    case 'placed':
    case 'recommended':
      base = 'border-primary/50 bg-primary-bg/75 hover:border-primary';
      break;
    case 'learning':
      base = 'border-primary/45 bg-bg-panel hover:border-primary';
      break;
    case 'available':
      base = 'border-border bg-bg-panel hover:border-primary/60';
      break;
    default:
      base = 'border-border bg-bg-sunken/80 hover:border-border-strong';
      break;
  }
  return `${base} ${ring} ${opacity}`;
}

function edgeState(edge: GlobalSkillTreeEdgeLayout): 'upstream' | 'downstream' | 'normal' | 'dim' | 'hidden' {
  const chain = activeChain.value;
  if (chain) {
    const upHit = (edge.toId === chain.center && chain.ancestors.has(edge.fromId)) ||
      (chain.ancestors.has(edge.toId) && chain.ancestors.has(edge.fromId));
    if (upHit) return 'upstream';
    const downHit = (edge.fromId === chain.center && chain.descendants.has(edge.toId)) ||
      (chain.descendants.has(edge.fromId) && chain.descendants.has(edge.toId));
    if (downHit) return 'downstream';
    return edge.crossArea && !showCrossEdges.value ? 'hidden' : 'dim';
  }
  if (edge.crossArea && !showCrossEdges.value) return 'hidden';
  return 'normal';
}

function edgeStroke(edge: GlobalSkillTreeEdgeLayout): string {
  const state = edgeState(edge);
  if (state === 'upstream') return 'var(--c-primary)';
  if (state === 'downstream') return 'var(--c-signal)';
  return 'var(--c-border-strong)';
}

function edgeStrokeWidth(edge: GlobalSkillTreeEdgeLayout): number {
  const state = edgeState(edge);
  if (state === 'upstream' || state === 'downstream') return 2.2;
  return edge.crossArea ? 1 : 1.2;
}

function edgeOpacity(edge: GlobalSkillTreeEdgeLayout): number {
  const state = edgeState(edge);
  if (state === 'hidden') return 0;
  if (state === 'upstream' || state === 'downstream') return 0.95;
  if (state === 'dim') return edge.crossArea ? 0.04 : 0.14;
  return edge.crossArea ? 0.22 : 0.72;
}
</script>

<template>
  <Teleport to="body" :disabled="!isFullscreen">
    <div
      data-testid="knowledge-global-overview"
      :class="isFullscreen
        ? 'fixed inset-4 z-[100] flex flex-col overflow-hidden rounded-[6px] border border-border-strong bg-bg-panel shadow-modal'
        : 'flex flex-col overflow-hidden rounded-[6px] border border-border bg-bg-panel'"
    >
      <!-- 顶部极简工具条 -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
        <div class="flex flex-wrap items-center gap-2 text-text-muted">
          <span>拖拽或双指滑动平移 · 捏合 / Ctrl+滚轮缩放 · 点击节点锁定依赖链</span>
          <span
            v-if="activeChain"
            class="inline-flex items-center gap-2 border-l border-border pl-2 tabular-nums"
            data-testid="overview-chain-badge"
          >
            <span class="inline-flex items-center gap-1 text-primary">
            <span class="h-0.5 w-3 bg-primary" />前置链 {{ activeChain.ancestors.size }}
          </span>
            <span class="inline-flex items-center gap-1 text-signal">
            <span class="h-0.5 w-3 bg-signal" />后继链 {{ activeChain.descendants.size }}
          </span>
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <label
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-border bg-bg-panel px-2 py-1 text-xs text-text-secondary">
          <input
            v-model="showCrossEdges"
            type="checkbox"
            class="accent-primary"
            data-testid="overview-cross-edges-toggle"
          />
          常显跨领域连线
        </label>

          <button
            type="button"
            class="rounded-[4px] border border-border bg-bg-panel px-2 py-1 text-xs font-medium text-text-secondary hover:border-border-strong hover:text-text"
            data-testid="overview-fullscreen-btn"
            @click="toggleFullscreen"
          >
          {{ isFullscreen ? '退出全屏 (Esc)' : '全屏查看' }}
        </button>
        </div>
      </div>

      <!-- 画布主体 -->
      <div
        v-if="globalLayout.nodes.length === 0"
        class="flex flex-1 items-center justify-center px-4 py-12 text-center text-sm text-text-secondary"
      >
      当前筛选条件下暂无匹配知识点，请取消「只显示有题节点」或切换考纲。
    </div>
      <div
        v-else
        ref="viewportRef"
        class="relative w-full overflow-hidden bg-bg-sunken/40 select-none"
        :class="[
        isFullscreen ? 'min-h-0 flex-1' : 'h-[620px]',
        isDragging ? 'cursor-grabbing' : 'cursor-grab',
      ]"
        data-testid="overview-canvas-viewport"
        @wheel.prevent="onWheel"
        @pointerdown="onPointerDown"
        @click="onCanvasBackgroundClick"
      >
        <!-- 缩放平移内容层（非拖拽时带顺滑过渡） -->
        <div
          class="absolute left-0 top-0 origin-top-left will-change-transform"
          :class="isDragging || isMinimapDragging ? '' : 'transition-transform duration-200 ease-out'"
          :style="{
          width: `${globalLayout.width}px`,
          height: `${globalLayout.height}px`,
          transform: `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`,
        }"
        >
          <!-- 领域泳道分区框 -->
          <div
            v-for="cluster in globalLayout.clusters"
            :key="cluster.areaId"
            class="absolute rounded-[6px] border transition-colors"
            :class="internalFocusedAreaId === cluster.areaId
            ? 'border-primary/65 bg-primary-bg/20'
            : 'border-border bg-bg-panel/65'"
            :style="{
            left: `${cluster.x}px`,
            top: `${cluster.y}px`,
            width: `${cluster.width}px`,
            height: `${cluster.height}px`,
          }"
            :data-testid="`overview-cluster-${cluster.areaId}`"
          >
            <div class="flex items-center justify-between gap-2 border-b border-border/80 px-2.5 py-1 text-xs">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate font-semibold text-text">{{ cluster.name }}</span>
                <span class="text-[11px] text-text-muted tabular-nums">
                {{ cluster.masteredCount + cluster.placedCount }}/{{ cluster.nodeCount }}
              </span>
              </span>
              <button
                type="button"
                data-canvas-ui="true"
                class="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary-bg"
                @click.stop="emit('select-area', cluster.areaId)"
              >
              单领域 →
            </button>
            </div>
          </div>

          <!-- 全图 SVG 边层（领域内 + 跨领域） -->
          <svg
            class="pointer-events-none absolute inset-0"
            :width="globalLayout.width"
            :height="globalLayout.height"
            aria-hidden="true"
          >
            <path
              v-for="edge in globalLayout.edges"
              :key="edge.id"
              :d="edge.path"
              fill="none"
              :stroke="edgeStroke(edge)"
              :stroke-width="edgeStrokeWidth(edge)"
              :stroke-opacity="edgeOpacity(edge)"
              :stroke-dasharray="edge.crossArea && edgeState(edge) === 'normal' ? '4 4' : undefined"
            />
          </svg>

          <!-- 全图节点卡片层（支持从表面直接拖拽；单击锁定依赖链，点击「讲解」或双击直达讲解详情页） -->
          <div
            v-for="item in globalLayout.nodes"
            :key="item.node.id"
            role="button"
            tabindex="0"
            class="absolute flex cursor-pointer flex-col justify-between rounded-[6px] border px-2 py-1 text-left transition-opacity"
            :class="nodeCardClass(item)"
            :style="{
            left: `${item.x}px`,
            top: `${item.y}px`,
            width: `${item.width}px`,
            height: `${item.height}px`,
          }"
            :data-testid="`skill-node-${item.node.id}`"
            @click.stop="onNodeClick(item)"
            @dblclick.stop="onNodeDblClick(item)"
            @keydown.enter.prevent="onNodeClick(item)"
            @mouseenter="hoveredNodeId = item.node.id"
            @mouseleave="hoveredNodeId = null"
            @focus="hoveredNodeId = item.node.id"
            @blur="hoveredNodeId = null"
          >
            <div class="flex items-start justify-between gap-1">
              <div class="flex min-w-0 items-center gap-1">
                <span class="size-1.5 shrink-0 rounded-full" :class="statusDotClass(item.status)" />
                <span class="line-clamp-1 text-[11px] font-semibold leading-tight text-text">
                {{ item.node.name }}
              </span>
              </div>
              <span class="inline-flex shrink-0 items-center gap-0.5">
                <span
                  v-if="item.needsReview"
                  class="rounded-[4px] bg-verdict-partial-bg px-1 py-0.5 text-[9px] font-medium text-verdict-partial"
                  data-testid="skill-node-review-badge"
                >
                待复习
              </span>
                <span
                  class="rounded-[4px] px-1 py-0.5 text-[9px] font-medium"
                  :class="badgeClass(item.status)"
                >
                {{ statusLabel(item.status) }}
              </span>
              </span>
            </div>

            <div class="flex items-center justify-between gap-1 text-[10px] text-text-muted tabular-nums">
              <span class="truncate">{{ item.node.id }}</span>
              <span class="inline-flex shrink-0 items-center gap-1">
                <span
                  v-if="item.abilityScore !== null && item.abilityScore > 0"
                  class="font-medium text-text-secondary"
                  data-testid="skill-node-ability"
                >
                能力 {{ item.abilityScore }}
              </span>
                <NuxtLink
                  v-if="item.hasDoc"
                  :to="nodePath(item.node.id)"
                  class="font-medium text-primary no-underline hover:underline"
                  title="打开原理讲解与阶梯练习页"
                  :data-testid="`skill-node-doc-${item.node.id}`"
                  @click.stop="onDocLinkClick"
                >
                  讲解
                </NuxtLink>
                <span>题 {{ item.problemCount }}</span>
              </span>
            </div>
          </div>
        </div>

        <!-- 左下角：交互式小地图 + 悬浮缩放控件 -->
        <div
          data-canvas-ui="true"
          class="absolute bottom-3 left-3 z-30 flex flex-col gap-2"
          @click.stop
        >
          <!-- 小地图（点击或拖拽快速导航） -->
          <div
            class="relative cursor-crosshair overflow-hidden rounded-[6px] border border-border-strong bg-bg-panel/92 shadow-card backdrop-blur-xs"
            :style="{ width: `${MINIMAP_W}px`, height: `${MINIMAP_H}px` }"
            title="点击或拖拽小地图快速跳转"
            data-testid="overview-minimap"
            @pointerdown.stop="onMinimapPointerDown"
            @pointermove.stop="onMinimapPointerMove"
            @pointerup.stop="onMinimapPointerUp"
            @pointerleave="onMinimapPointerUp"
          >
            <svg :width="MINIMAP_W" :height="MINIMAP_H" aria-hidden="true">
              <rect
                v-for="cluster in globalLayout.clusters"
                :key="`mm-${cluster.areaId}`"
                :x="minimap.offsetX + cluster.x * minimap.ratio"
                :y="minimap.offsetY + cluster.y * minimap.ratio"
                :width="Math.max(4, cluster.width * minimap.ratio)"
                :height="Math.max(4, cluster.height * minimap.ratio)"
                rx="2"
                :fill="internalFocusedAreaId === cluster.areaId ? 'var(--c-primary-bg)' : 'var(--c-bg-sunken)'"
                :stroke="internalFocusedAreaId === cluster.areaId ? 'var(--c-primary)' : 'var(--c-border-strong)'"
                stroke-width="1"
              />
              <rect
                :x="minimap.rectX"
                :y="minimap.rectY"
                :width="minimap.rectW"
                :height="minimap.rectH"
                rx="2"
                fill="var(--c-primary)"
                fill-opacity="0.14"
                stroke="var(--c-primary)"
                stroke-width="1.5"
              />
            </svg>
          </div>

          <!-- 悬浮缩放与适配按钮 -->
          <div
            class="inline-flex items-center gap-1 rounded-[6px] border border-border-strong bg-bg-panel/95 p-1 text-xs shadow-card tabular-nums backdrop-blur-xs">
            <button
              type="button"
              class="rounded-[4px] px-2 py-0.5 text-text-secondary hover:bg-bg-sunken hover:text-text"
              title="缩小"
              data-testid="overview-zoom-out"
              @click="zoomAt(scale * 0.82)"
            >
            −
          </button>
            <button
              type="button"
              class="rounded-[4px] px-1.5 py-0.5 font-medium text-text hover:bg-bg-sunken"
              title="重置为 100%"
              data-testid="overview-zoom-reset"
              @click="zoomAt(1)"
            >
            {{ scalePercent }}%
          </button>
            <button
              type="button"
              class="rounded-[4px] px-2 py-0.5 text-text-secondary hover:bg-bg-sunken hover:text-text"
              title="放大"
              data-testid="overview-zoom-in"
              @click="zoomAt(scale * 1.22)"
            >
            +
          </button>
            <span class="mx-0.5 h-3.5 w-px bg-border" />
            <button
              type="button"
              class="rounded-[4px] px-2 py-0.5 font-medium text-primary hover:bg-primary-bg"
              data-testid="overview-fit-btn"
              @click="fitToViewport()"
            >
            适配全图
          </button>
          </div>
        </div>

        <!-- 右下角选中节点快览面板 -->
        <div
          v-if="selectedNodeLayout"
          data-canvas-ui="true"
          class="absolute bottom-3 right-3 z-30 w-80 max-w-[calc(100%-24px)] rounded-[6px] border border-border-strong bg-bg-elevated p-3 shadow-dropdown"
          data-testid="overview-node-inspector"
          @click.stop
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-[11px] text-text-muted">
              {{ areaNameMap.get(selectedNodeLayout.node.area) ?? selectedNodeLayout.node.area }} · {{ selectedNodeLayout.node.id }}
            </p>
              <h3 class="mt-0.5 text-sm font-semibold text-text">
              {{ selectedNodeLayout.node.name }}
            </h3>
            </div>
            <button
              type="button"
              class="rounded-[4px] px-1.5 py-0.5 text-xs text-text-muted hover:bg-bg-sunken hover:text-text"
              aria-label="关闭节点详情"
              @click="selectedNodeId = null"
            >
            ×
          </button>
          </div>

          <p v-if="selectedNodeLayout.node.summary" class="mt-1.5 line-clamp-2 text-xs text-text-secondary">
          {{ selectedNodeLayout.node.summary }}
        </p>

          <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums">
            <span
              class="rounded-[4px] px-1.5 py-0.5 font-medium"
              :class="badgeClass(selectedNodeLayout.status)"
            >
            {{ statusLabel(selectedNodeLayout.status) }}
          </span>
            <span
              v-if="selectedNodeLayout.needsReview"
              class="rounded-[4px] bg-verdict-partial-bg px-1.5 py-0.5 font-medium text-verdict-partial"
            >
            待复习
          </span>
            <span
              v-if="selectedNodeLayout.abilityScore !== null && selectedNodeLayout.abilityScore > 0"
              class="rounded-[4px] bg-bg-sunken px-1.5 py-0.5 font-medium text-text-secondary"
            >
            能力 {{ selectedNodeLayout.abilityScore }}
          </span>
            <span class="text-text-muted">题 {{ selectedNodeLayout.problemCount }}</span>
            <span class="text-primary">前置 {{ selectedChainCounts.ancestors }}</span>
            <span class="text-signal">后继 {{ selectedChainCounts.descendants }}</span>
          </div>

          <div class="mt-3 flex items-center gap-2">
            <NuxtLink
              :to="nodePath(selectedNodeLayout.node.id)"
              class="inline-flex flex-1 items-center justify-center rounded-[4px] bg-primary px-2.5 py-1.5 text-xs font-medium text-white no-underline hover:bg-primary-dark"
              data-testid="overview-inspector-open-node"
            >
            进入讲解与练习
          </NuxtLink>
            <button
              type="button"
              class="rounded-[4px] border border-border bg-bg-panel px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:border-border-strong hover:text-text"
              @click="emit('select-area', selectedNodeLayout.node.area)"
            >
            单领域视图
          </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
