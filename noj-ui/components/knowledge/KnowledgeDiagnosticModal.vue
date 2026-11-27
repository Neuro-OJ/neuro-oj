<script setup lang="ts">
/**
 * 知识图谱快速摸底诊断弹窗：
 * - 允许新手或有基础的选手通过勾选「已掌握的基础领域」或最多 8 个高杠杆核心节点，
 *   写入独立的 `user_knowledge_placements`，立即点亮技能树前置并解锁中高级推荐题；
 * - 严格不修改 `user_knowledge_mastery` 做题计数，保持教练班级矩阵真实可信。
 */
import { computed, ref, watch } from 'vue';
import {
  type DiagnosticPlanView,
  knowledgeNodePath,
} from '~/utils/domain/education/knowledge';
import { extractApiError } from '~/utils/server/apiError';

const props = defineProps<{
  open: boolean;
  slug: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const knowledge = useKnowledge();

const loading = ref(false);
const saving = ref(false);
const failure = ref('');
const plan = ref<DiagnosticPlanView | null>(null);
const selectedNodeIds = ref<Set<string>>(new Set());

async function loadPlan() {
  if (!props.slug || typeof knowledge.loadDiagnosticPlan !== 'function') return;
  loading.value = true;
  failure.value = '';
  try {
    const loaded = await knowledge.loadDiagnosticPlan(props.slug);
    plan.value = loaded;
    selectedNodeIds.value = new Set(loaded?.placed_nodes ?? []);
  } catch (error) {
    failure.value = extractApiError(error).message;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.slug] as const,
  ([isOpen]) => {
    if (isOpen) void loadPlan();
  },
  { immediate: true },
);

function isAreaFullySelected(nodeIds: string[]): boolean {
  return nodeIds.length > 0 && nodeIds.every((id) => selectedNodeIds.value.has(id));
}

function toggleArea(nodeIds: string[]) {
  const next = new Set(selectedNodeIds.value);
  if (isAreaFullySelected(nodeIds)) {
    for (const id of nodeIds) next.delete(id);
  } else {
    for (const id of nodeIds) next.add(id);
  }
  selectedNodeIds.value = next;
}

function toggleNode(nodeId: string) {
  const next = new Set(selectedNodeIds.value);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  selectedNodeIds.value = next;
}

const selectedCount = computed(() => selectedNodeIds.value.size);

async function submit() {
  if (typeof knowledge.submitSelfAssessment !== 'function') return;
  saving.value = true;
  failure.value = '';
  try {
    await knowledge.submitSelfAssessment({
      node_ids: [...selectedNodeIds.value],
      mode: 'replace',
    });
    emit('saved');
    emit('update:open', false);
  } catch (error) {
    failure.value = extractApiError(error).message;
  } finally {
    saving.value = false;
  }
}

function clearAll() {
  selectedNodeIds.value = new Set();
}
</script>

<template>
  <UModal
    :open="open"
    title="快速摸底诊断"
    description="勾选你已掌握的基础领域或核心能力点，系统将立即点亮前置节点并推荐进阶练习；不影响真实做题记录。"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="space-y-5">
        <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

        <div v-if="loading" class="space-y-3 py-4">
          <div class="h-4 w-48 animate-pulse rounded bg-bg-sunken" />
          <div class="h-24 animate-pulse rounded-[6px] bg-bg-sunken" />
        </div>

        <template v-else-if="plan">
          <!-- 领域整区快速标定 -->
          <section class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-semibold text-text">按领域快速勾选已掌握基础</h3>
              <span class="text-xs text-text-muted tabular-nums">
                已选 {{ selectedCount }} 个节点
              </span>
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              <button
                v-for="area in plan.areas"
                :key="area.area_id"
                type="button"
                class="flex items-center justify-between rounded-[6px] border px-3 py-2 text-left text-xs transition-colors"
                :class="
                  isAreaFullySelected(area.foundation_node_ids)
                    ? 'border-primary bg-primary/5 text-text'
                    : 'border-border bg-white text-text-secondary hover:bg-bg-sunken'
                "
                data-testid="diagnostic-area-toggle"
                @click="toggleArea(area.foundation_node_ids)"
              >
                <span class="font-medium text-text">{{ area.name }}</span>
                <span class="tabular-nums text-[11px] text-text-muted">
                  {{ area.foundation_node_ids.filter((id) => selectedNodeIds.has(id)).length }}/{{ area.total_nodes }}
                </span>
              </button>
            </div>
          </section>

          <!-- 核心能力检查点 -->
          <section v-if="plan.checkpoints.length > 0" class="space-y-2">
            <h3 class="text-sm font-semibold text-text">核心能力检查点（解锁最多下游路径）</h3>
            <ul class="space-y-2">
              <li
                v-for="cp in plan.checkpoints"
                :key="cp.node_id"
                class="rounded-[6px] border border-border bg-white p-3"
                data-testid="diagnostic-checkpoint"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1 space-y-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <NuxtLink
                        :to="knowledgeNodePath(slug, cp.node_id)"
                        class="text-sm font-semibold text-text no-underline hover:text-primary"
                      >
                        {{ cp.name }}
                      </NuxtLink>
                      <UBadge size="xs" color="neutral" variant="subtle">
                        {{ cp.area_name }}
                      </UBadge>
                      <span
                        v-if="cp.unlocks_count > 0"
                        class="text-[11px] text-text-muted tabular-nums"
                      >
                        可解锁 {{ cp.unlocks_count }} 个下游节点
                      </span>
                    </div>
                    <p v-if="cp.summary" class="text-xs leading-relaxed text-text-secondary">
                      {{ cp.summary }}
                    </p>
                  </div>
                  <UButton
                    size="xs"
                    :color="selectedNodeIds.has(cp.node_id) ? 'primary' : 'neutral'"
                    :variant="selectedNodeIds.has(cp.node_id) ? 'solid' : 'outline'"
                    :disabled="cp.state === 'mastered'"
                    data-testid="diagnostic-checkpoint-toggle"
                    @click="toggleNode(cp.node_id)"
                  >
                    {{
                      cp.state === 'mastered'
                        ? '已实做掌握'
                        : selectedNodeIds.has(cp.node_id)
                          ? '已标定会用'
                          : '我已掌握'
                    }}
                  </UButton>
                </div>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :disabled="saving || selectedCount === 0"
          @click="clearAll"
        >
          清空自评
        </UButton>
        <div class="flex items-center gap-2">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="saving"
            @click="emit('update:open', false)"
          >
            取消
          </UButton>
          <UButton
            color="primary"
            size="sm"
            :loading="saving"
            data-testid="diagnostic-submit"
            @click="submit"
          >
            保存并刷新技能树
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
