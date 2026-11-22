<script setup lang="ts">
/**
 * 题目编辑页的「知识点」区块：读取当前归类状态，主/次要知识点选择后单独保存
 * （调用 `PUT /knowledge/problems/:problemId`，不影响题目草稿/版本）。
 *
 * 无编辑权限时不渲染；功能关闭或接口返回空时隐藏。
 */
import { extractApiError } from '~/utils/apiError';
import {
  mappingStateLabel,
  normalizeSelection,
  parsePassRatioOverride,
  selectionFromView,
  type ProblemKnowledgeView,
  type KnowledgeSelection,
} from '~/utils/knowledge';

const props = defineProps<{ problemId: string; writable: boolean }>();

const knowledge = useKnowledge();

const view = ref<ProblemKnowledgeView | null>(null);
const loading = ref(true);
const saving = ref(false);
const failure = ref('');
const message = ref('');
const hidden = computed(() => !props.writable || knowledge.disabled.value);

const selection = ref<KnowledgeSelection>({ primary: '', secondary: [] });
/** 及格线覆盖（百分比文本；空串 = 用空间默认，提交时转为 null）。 */
const passRatio = ref('');
const initialPassRatio = computed(() => {
  const value = view.value?.difficulty?.pass_ratio_override;
  return value === null || value === undefined ? '' : String(value);
});
const dirty = computed(() => {
  const current = normalizeSelection(selection.value);
  const initial = selectionFromView(view.value);
  return current.primary !== initial.primary ||
    current.secondary.join(',') !== initial.secondary.join(',') ||
    passRatio.value.trim() !== initialPassRatio.value;
});

/** 及格线输入错误（越界/非整数），保存前拦截。 */
const passRatioError = computed(() => parsePassRatioOverride(passRatio.value).error ?? '');

async function load() {
  if (hidden.value) return;
  loading.value = true;
  failure.value = '';
  try {
    const [loadedView] = await Promise.all([knowledge.loadProblem(props.problemId), knowledge.loadGraph(true)]);
    if (knowledge.disabled.value) return;
    view.value = loadedView;
    selection.value = selectionFromView(loadedView);
    passRatio.value = loadedView?.difficulty?.pass_ratio_override == null
      ? ''
      : String(loadedView.difficulty.pass_ratio_override);
  } catch (error) {
    if (knowledge.disabled.value) return;
    failure.value = extractApiError(error).message;
  } finally {
    loading.value = false;
  }
}

watch(() => [props.problemId, props.writable] as const, () => {
  if (!hidden.value) void load();
}, { immediate: true });

const stateBadge = computed(() => mappingStateLabel(view.value));

async function save() {
  const payload = normalizeSelection(selection.value);
  if (saving.value || !payload.primary || passRatioError.value) return;
  const ratio = parsePassRatioOverride(passRatio.value);
  saving.value = true;
  failure.value = '';
  message.value = '';
  try {
    // 及格线仅在变化时随 PUT 提交；null 表示清除覆盖、改用空间默认。
    // 未读到难度（旧后端 / 字段缺省）时不附带该字段，避免误清除已有覆盖。
    const options = view.value?.difficulty && ratio.value !== (view.value.difficulty.pass_ratio_override ?? null)
      ? { passRatioOverride: ratio.value }
      : {};
    const next = await knowledge.saveProblem(props.problemId, payload, options);
    if (knowledge.disabled.value) return;
    view.value = next;
    selection.value = selectionFromView(next);
    passRatio.value = next?.difficulty?.pass_ratio_override == null
      ? ''
      : String(next.difficulty.pass_ratio_override);
    message.value = '知识点已保存';
  } catch (error) {
    if (knowledge.disabled.value) return;
    failure.value = extractApiError(error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UCard v-if="!hidden">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h3 class="font-semibold">知识点</h3>
        <UBadge v-if="stateBadge" :color="stateBadge.color" variant="subtle" size="sm">{{ stateBadge.label }}</UBadge>
        <UBadge v-else color="neutral" variant="subtle" size="sm">未归类</UBadge>
      </div>
      <UButton v-if="dirty" size="xs" variant="ghost" :disabled="!!saving"
        @click="selection = selectionFromView(view); passRatio = initialPassRatio">放弃修改</UButton>
    </div>
    <UAlert v-if="failure" color="error" :title="failure" class="mb-3" />
    <UAlert v-if="message" color="success" :title="message" class="mb-3" />
    <KnowledgePicker v-model="selection" :graph="knowledge.graph.value" :loading="loading" :disabled="!!saving" />
    <div class="mt-4 max-w-xs space-y-1 border-t border-border pt-3">
      <label for="knowledge-pass-ratio" class="block text-sm font-medium text-text">及格线（可选，百分比）</label>
      <UInput
        id="knowledge-pass-ratio"
        v-model="passRatio"
        type="number"
        min="0"
        max="100"
        step="1"
        inputmode="numeric"
        placeholder="留空使用空间默认"
        :disabled="!!saving || loading"
        :aria-invalid="!!passRatioError"
      />
      <p v-if="passRatioError" class="text-xs text-error">{{ passRatioError }}</p>
      <p v-else class="text-xs text-text-muted">学生有效得分达到该百分比即视为达标；留空则使用空间默认及格线。</p>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <UButton :loading="saving" :disabled="!dirty || !selection.primary || loading" @click="save">保存知识点</UButton>
      <span class="text-xs text-text-muted">
        {{ dirty ? '有未保存的知识点修改' : '知识点独立保存，不影响题目草稿与版本' }}
      </span>
    </div>
  </UCard>
</template>
