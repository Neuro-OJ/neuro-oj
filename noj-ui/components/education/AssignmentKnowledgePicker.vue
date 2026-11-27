<script setup lang="ts">
/**
 * 作业编辑器「按知识点添加」：选知识点 + 题数 → 调 `knowledge-pick` 预览 → 加入作业。
 *
 * - 只负责挑题与预览，不创建作业；追加/去重由父组件（`AssignmentEditor`）处理；
 * - 总开关关闭或接口 404 `KNOWLEDGE_DISABLED` 时整块渲染为空；
 * - 预览由后端按阶梯均匀抽样，这里只展示题号、标题与难度档。
 */
import { extractApiError } from '~/utils/server/apiError';
import {
  difficultyTierColor,
  difficultyTierLabel,
  KNOWLEDGE_PICK_DEFAULT,
  KNOWLEDGE_PICK_MAX,
  KNOWLEDGE_PICK_MIN,
  type KnowledgeGraph,
  type KnowledgePickItem,
  type KnowledgeSelection,
  nodeName,
  parsePickCount,
} from '~/utils/domain/education/knowledge';

const props = defineProps<{
  slug: string;
  classroomId: string;
  graph: KnowledgeGraph | null;
  /** 已在作业中的题目标识（`display_ref`），用于禁用重复项。 */
  existing?: string[];
}>();
const emit = defineEmits<{ add: [items: KnowledgePickItem[]] }>();

const knowledge = useKnowledge();
const capture = useWorkspaceActionScope();

const selection = ref<KnowledgeSelection>({ primary: '', secondary: [] });
const countRaw = ref(String(KNOWLEDGE_PICK_DEFAULT));
const preview = ref<KnowledgePickItem[]>([]);
const previewNode = ref('');
const loading = ref(false);
const failure = ref('');
const hidden = computed(() => knowledge.disabled.value);

const count = computed(() => parsePickCount(countRaw.value));
/** 当前预览属于所选知识点（换了知识点后旧预览失效）。 */
const previewValid = computed(() => !!previewNode.value && previewNode.value === selection.value.primary);
const items = computed(() => (previewValid.value ? preview.value : []));
const added = computed(() => new Set(props.existing ?? []));

function refOf(item: KnowledgePickItem) {
  return String(item.number ?? item.problem_id);
}

async function load() {
  if (hidden.value) return;
  try {
    await knowledge.loadGraph();
  } catch (e) {
    failure.value = extractApiError(e).message;
  }
}
void load();

async function runPreview() {
  if (loading.value || !selection.value.primary || !count.value.value) return;
  const scope = capture(), classId = props.classroomId, node = selection.value.primary;
  loading.value = true;
  failure.value = '';
  try {
    const view = await knowledge.loadClassroomPick(scope.slug, classId, node, count.value.value);
    if (!scope.isCurrent() || props.classroomId !== classId || selection.value.primary !== node) return;
    preview.value = view?.items ?? [];
    previewNode.value = view?.node_id ?? '';
  } catch (e) {
    if (!scope.isCurrent() || props.classroomId !== classId) return;
    failure.value = extractApiError(e).message;
  } finally {
    loading.value = false;
  }
}

function addAll() {
  const fresh = items.value.filter((item) => !added.value.has(refOf(item)));
  if (fresh.length) emit('add', fresh);
}

watch(() => selection.value.primary, () => {
  preview.value = [];
  previewNode.value = '';
  failure.value = '';
});

defineExpose({ runPreview, addAll });
</script>

<template>
  <div
    v-if="!hidden"
    class="space-y-3 rounded-md border border-primary/20 bg-primary-bg/40 p-4"
    data-testid="assignment-knowledge-picker"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-brain" class="size-4 text-primary" />
        <h3 class="text-sm font-semibold text-text">按知识点添加</h3>
      </div>
      <span class="text-xs text-text-muted">从所选知识点的题目阶梯中按难度均匀挑选</span>
    </div>

    <div class="flex flex-wrap items-start gap-3">
      <div class="min-w-0 grow">
        <KnowledgePicker v-model="selection" :graph="graph" :disabled="loading" />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UInput
          v-model="countRaw"
          type="number"
          :min="KNOWLEDGE_PICK_MIN"
          :max="KNOWLEDGE_PICK_MAX"
          aria-label="按知识点挑题数量"
          class="w-24 tabular-nums"
        />
        <UButton
          type="button"
          color="primary"
          variant="outline"
          :loading="loading"
          :disabled="!selection.primary || !count.value"
          @click="runPreview"
        >
          预览题目
        </UButton>
      </div>
    </div>
    <p v-if="count.error" class="text-xs text-error">{{ count.error }}</p>
    <UAlert v-if="failure" color="error" :title="failure" />

    <div v-if="items.length" class="space-y-2" data-testid="knowledge-pick-preview">
      <p class="text-xs text-text-secondary">
        「{{ nodeName(graph, previewNode) }}」挑选了 {{ items.length }} 道题：
      </p>
      <div class="divide-y divide-border rounded border border-border bg-bg-panel dark:bg-bg-panel">
        <div
          v-for="item in items"
          :key="item.problem_id"
          class="flex items-center gap-2 px-3 py-2 text-sm"
          data-testid="knowledge-pick-item"
        >
          <span class="shrink-0 font-mono text-xs text-primary">{{ item.number ?? '—' }}</span>
          <span class="min-w-0 flex-1 truncate text-text" :title="item.title">{{ item.title }}</span>
          <UBadge :color="difficultyTierColor(item.tier)" variant="subtle" size="sm">
            {{ difficultyTierLabel(item.tier) }}
          </UBadge>
          <span v-if="added.has(refOf(item))" class="text-xs text-text-muted">已在作业中</span>
        </div>
      </div>
      <UButton type="button" color="primary" size="sm" @click="addAll">加入作业</UButton>
    </div>
  </div>
</template>
