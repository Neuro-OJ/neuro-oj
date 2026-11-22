<script setup lang="ts">
/**
 * 知识点选择器：主知识点单选 + 次要知识点至多 3 个。
 *
 * - 数据来自 `GET /knowledge/graph`（按领域分组、可搜索）；
 * - 功能关闭（`KNOWLEDGE_DISABLED`）时整块渲染为空（父组件也不应展示）；
 * - 编辑页与审核页共用，值受 v-model 控制，保存由父组件负责。
 */
import {
  groupNodesByArea,
  MAX_SECONDARY,
  normalizeSelection,
  type KnowledgeGraph,
  type KnowledgeSelection,
} from '~/utils/knowledge';

const props = withDefaults(defineProps<{
  modelValue: KnowledgeSelection;
  graph: KnowledgeGraph | null;
  disabled?: boolean;
  /** 图谱尚未加载完成。 */
  loading?: boolean;
}>(), { disabled: false, loading: false });

const emit = defineEmits<{ 'update:modelValue': [value: KnowledgeSelection] }>();

const primaryQuery = ref('');
const secondaryQuery = ref('');

const groups = computed(() => groupNodesByArea(props.graph));
const nameById = computed(() => new Map((props.graph?.nodes ?? []).map((node) => [node.id, node.name])));

function labelOf(id: string) {
  return nameById.value.get(id) ?? id;
}

function filterNodes(query: string) {
  const q = query.trim().toLowerCase();
  return groups.value
    .map((group) => ({
      area: group.area,
      nodes: group.nodes.filter((node) =>
        !q || node.name.toLowerCase().includes(q) || node.id.toLowerCase().includes(q) ||
        group.area.name.toLowerCase().includes(q)
      ),
    }))
    .filter((group) => group.nodes.length > 0);
}

const primaryGroups = computed(() => filterNodes(primaryQuery.value));
const secondaryAvailable = computed(() => {
  const chosen = new Set(props.modelValue.secondary);
  return filterNodes(secondaryQuery.value)
    .map((group) => ({ area: group.area, nodes: group.nodes.filter((node) => node.id !== props.modelValue.primary) }))
    .filter((group) => group.nodes.length > 0)
    .map((group) => ({ area: group.area, nodes: group.nodes.map((node) => ({ node, selected: chosen.has(node.id) })) }));
});
const secondaryFull = computed(() => props.modelValue.secondary.length >= MAX_SECONDARY || !props.modelValue.primary);

function emitValue(next: Partial<KnowledgeSelection>) {
  emit('update:modelValue', normalizeSelection({ ...props.modelValue, ...next }));
}

function setPrimary(id: string) {
  if (props.disabled) return;
  // 换主知识点时，原主项不自动转为次项；次项与主项冲突时由 normalizeSelection 去掉。
  emitValue({ primary: id });
}

function toggleSecondary(id: string) {
  if (props.disabled || secondaryFull.value) return;
  const current = props.modelValue.secondary;
  emitValue({
    secondary: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
  });
}
</script>

<template>
  <div class="space-y-4" data-testid="knowledge-picker">
    <p v-if="loading" class="text-xs text-text-muted">正在加载知识点…</p>
    <p v-else-if="!graph || !graph.nodes.length" class="text-xs text-text-muted">
      暂无可用知识点：请先在管理后台导入知识图谱内容包。
    </p>
    <template v-else>
      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-sm font-semibold">主知识点</h4>
          <UBadge v-if="modelValue.primary" color="primary" variant="subtle">
            {{ labelOf(modelValue.primary) }}
          </UBadge>
          <span v-else class="text-xs text-text-muted">未选择</span>
        </div>
        <UInput v-model="primaryQuery" icon="i-lucide-search" placeholder="搜索知识点名称或 ID" size="sm"
          class="w-full sm:w-64" aria-label="搜索主知识点" :disabled="disabled" />
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="knowledge-primary" :value="''" :checked="!modelValue.primary"
            :disabled="disabled" @change="setPrimary('')">
          <span class="text-text-muted">不设置主知识点</span>
        </label>
        <div class="max-h-64 space-y-3 overflow-y-auto rounded border border-border p-3">
          <div v-for="group in primaryGroups" :key="`p:${group.area.id}`" class="space-y-1">
            <p class="text-[11px] font-semibold tracking-wider text-text-muted">{{ group.area.name }}</p>
            <label v-for="node in group.nodes" :key="`p:${node.id}`" class="flex items-center gap-2 text-sm"
              :title="node.summary ?? node.id">
              <input type="radio" name="knowledge-primary" :value="node.id"
                :checked="modelValue.primary === node.id" :disabled="disabled" @change="setPrimary(node.id)">
              <span>{{ node.name }}</span>
              <span class="text-[11px] text-text-muted font-mono">{{ node.id }}</span>
            </label>
          </div>
          <p v-if="!primaryGroups.length" class="text-xs text-text-muted">没有匹配的知识点。</p>
        </div>
      </div>
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="text-sm font-semibold">次要知识点</h4>
          <span class="text-xs text-text-muted">{{ modelValue.secondary.length }} / {{ MAX_SECONDARY }}</span>
          <UBadge v-for="id in modelValue.secondary" :key="`s:${id}`" color="neutral" variant="subtle">
            {{ labelOf(id) }}
            <button type="button" class="ml-1 text-text-muted hover:text-error-text" :aria-label="`移除次要知识点 ${labelOf(id)}`"
              :disabled="disabled" @click="toggleSecondary(id)">×</button>
          </UBadge>
        </div>
        <UInput v-model="secondaryQuery" icon="i-lucide-search" placeholder="搜索知识点名称或 ID" size="sm"
          class="w-full sm:w-64" aria-label="搜索次要知识点" :disabled="disabled || secondaryFull" />
        <p v-if="!modelValue.primary" class="text-xs text-text-muted">请先选择主知识点，再添加次要知识点。</p>
        <p v-else-if="secondaryFull" class="text-xs text-text-muted">已选满 {{ MAX_SECONDARY }} 个次要知识点。</p>
        <div v-if="!secondaryFull" class="max-h-64 space-y-3 overflow-y-auto rounded border border-border p-3">
          <div v-for="group in secondaryAvailable" :key="`s:${group.area.id}`" class="space-y-1">
            <p class="text-[11px] font-semibold tracking-wider text-text-muted">{{ group.area.name }}</p>
            <label v-for="item in group.nodes" :key="`s:${item.node.id}`" class="flex items-center gap-2 text-sm"
              :title="item.node.summary ?? item.node.id">
              <input type="checkbox" :value="item.node.id" :checked="item.selected" :disabled="disabled"
                @change="toggleSecondary(item.node.id)">
              <span>{{ item.node.name }}</span>
              <span class="text-[11px] text-text-muted font-mono">{{ item.node.id }}</span>
            </label>
          </div>
          <p v-if="!secondaryAvailable.length" class="text-xs text-text-muted">没有匹配的知识点。</p>
        </div>
      </div>
    </template>
  </div>
</template>
