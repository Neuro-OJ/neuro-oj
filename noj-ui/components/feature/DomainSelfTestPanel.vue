<script setup lang="ts">
import type { DomainProblemDetail } from '~/utils/domain-problems';
import type { DomainSelfTest, DomainSelfTestCase } from '~/composables/useDomainSelfTests';
import { domainAnswerKey } from '~/utils/domain-problems';
import { extractApiError } from '~/utils/apiError';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
const props = defineProps<
  { slug: string; problem: Pick<DomainProblemDetail, 'reference' | 'content'>; code: string; language: string; versionId: string; writable: boolean; assignmentOrigin?: AssignmentSubmissionOrigin; expanded?: boolean }
>();
const emit = defineEmits<{ refresh: []; result: [record: DomainSelfTest | null] }>();
const { user } = useAuth(), api = useDomainSelfTests(), capture = useWorkspaceActionScope();
const id = ref(''), sending = ref(false), cancelling = ref(false), failure = ref('');
const customs = ref<Array<DomainSelfTestCase & { enabled: boolean }>>([]);
const samplesEnabled = ref<Record<string, boolean>>({});
const isOi = computed(() => props.problem.content.kind === 'oi');
const key = computed(() =>
  domainAnswerKey(
    user.value?.id ?? '',
    props.slug,
    `self-test:${props.problem.reference.problem_id}`,
    props.versionId,
    props.language,
  )
);
const record = useAsyncData(
  () => `${key.value}:run:${id.value}`,
  () => id.value ? api.detail(props.slug, id.value) : Promise.resolve(null),
);
const current = computed(() => record.data.value?.data.id === id.value ? record.data.value.data : null);
watch(current, value => emit('result', value), { immediate: true });
const pending = computed(() =>
  !!id.value && !record.error.value && (!current.value || ['pending', 'judging'].includes(current.value.status))
);
usePolling({
  intervalMs: computed(() => pending.value ? 1500 : null),
  immediate: false,
  fetcher: () => record.refresh(),
});
const samples = computed(() =>
  props.problem.content.samples.map((sample, index) => ({
    id: `sample_${index + 1}`,
    input: sample.input,
    expected_output: sample.output,
  }))
);
function loadCases() {
  customs.value = [];
  samplesEnabled.value = {};
  if (!import.meta.client) return;
  try {
    const saved = JSON.parse(localStorage.getItem(`noj:self-test-cases:${key.value}`) ?? '[]');
    customs.value = Array.isArray(saved) ? saved : [];
  } catch {
    failure.value = '本地自测用例无法读取，请重新添加';
  }
}
onMounted(loadCases);
watch(key, () => {
  id.value = '';
  failure.value = '';
  sending.value = cancelling.value = false;
  loadCases();
});
watch(customs, (value) => {
  if (!import.meta.client || !user.value) return;
  try {
    localStorage.setItem(`noj:self-test-cases:${key.value}`, JSON.stringify(value));
  } catch {
    failure.value = '自测用例未保存到本地，请保留输入';
  }
}, { deep: true });
function add() {
  customs.value.push({ id: `custom_${crypto.randomUUID()}`, input: '', enabled: true });
}
function expected(item: DomainSelfTestCase, enabled: boolean) {
  if (enabled) item.expected_output = '';
  else delete item.expected_output;
}
async function run() {
  if (!props.writable || pending.value || sending.value) return;
  const selected = [
    ...samples.value.filter((item) => samplesEnabled.value[item.id] !== false),
    ...customs.value.filter((item) => item.enabled),
  ].map(({ id, input, expected_output }) => ({
    id,
    input,
    ...(expected_output === undefined ? {} : { expected_output }),
  }));
  if (isOi.value && !selected.length) {
    failure.value = '请启用至少一个公开样例或自定义用例';
    return;
  }
  const scope = capture(), context = key.value;
  sending.value = true;
  failure.value = '';
  try {
    const response = await api.create(scope.slug, props.problem.reference.display_ref, {
      version_id: props.versionId,
      language: props.language,
      code: props.code,
      ...props.assignmentOrigin,
      ...(isOi.value ? { cases: selected } : {}),
    });
    if (scope.isCurrent() && key.value === context) id.value = response.data.id;
  } catch (error) {
    if (scope.isCurrent() && key.value === context) {
      failure.value = extractApiError(error).message;
      if (extractApiError(error).status === 409) emit('refresh');
    }
  } finally {
    if (scope.isCurrent() && key.value === context) sending.value = false;
  }
}
async function cancel() {
  if (!id.value || cancelling.value) return;
  const scope = capture(), target = id.value;
  cancelling.value = true;
  try {
    await api.cancel(scope.slug, target);
    if (scope.isCurrent() && id.value === target) await record.refresh();
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) cancelling.value = false;
  }
}
defineExpose({ run });
</script>
<template>
  <details :open="expanded" class="mt-4 rounded border border-border p-4">
    <summary class="cursor-pointer font-semibold">代码自测</summary>
    <p class="my-3 text-sm text-text-secondary">使用当前代码、语言与作答版本，自测不计入正式成绩或作业进度。</p>
    <template v-if="isOi">
      <p
        class="mb-3 text-xs text-text-muted">只运行公开样例和自定义输入，1–30 个用例；预期输出可留空，未启用比较时仅运行。</p>
      <div v-for="item in samples" :key="item.id" class="mb-3 rounded border border-border p-3">
        <UCheckbox :model-value="samplesEnabled[item.id] !== false" :label="`公开样例 ${item.id.split('_')[1]}`"
          @update:model-value="value => samplesEnabled[item.id] = !!value" />
        <div class="mt-2 grid gap-2 sm:grid-cols-2">
          <pre class="overflow-auto whitespace-pre-wrap text-xs">{{ item.input }}</pre>
          <pre class="overflow-auto whitespace-pre-wrap text-xs">{{ item.expected_output }}</pre>
        </div>
      </div>
      <div v-for="(item, index) in customs" :key="item.id" class="mb-3 space-y-3 rounded border border-border p-3">
        <div class="flex justify-between gap-3">
          <UCheckbox v-model="item.enabled" :label="`自定义用例 ${index + 1}`" />
          <UButton size="xs" variant="ghost" color="error"
            @click="customs = customs.filter((entry) => entry.id !== item.id)">删除</UButton>
        </div>
        <UTextarea v-model="item.input" aria-label="自测输入" placeholder="输入" class="w-full font-mono" />
        <UCheckbox :model-value="item.expected_output !== undefined" label="比较预期输出"
          @update:model-value="value => expected(item, !!value)" />
        <UTextarea v-if="item.expected_output !== undefined" v-model="item.expected_output" aria-label="自测预期输出"
          placeholder="预期输出（可以为空字符串）" class="w-full font-mono" />
      </div>
      <UButton size="sm" variant="outline" :disabled="customs.length + samples.length >= 30"
        @click="add">添加自定义用例</UButton>
    </template>
    <UAlert v-if="failure" class="mt-3" color="error" :title="failure" />
    <UAlert v-if="record.error.value" class="mt-3" color="error" :title="extractApiError(record.error.value).message">
      <template #actions>
        <UButton @click="record.refresh()">重新读取</UButton>
      </template>
    </UAlert>
    <div class="my-4 flex flex-wrap gap-3">
      <UButton :loading="sending" :disabled="!writable || pending || !code.trim()" @click="run">运行自测</UButton>
      <UButton v-if="pending" color="error" variant="outline" :loading="cancelling" @click="cancel">取消运行</UButton>
      <UButton v-if="id" :to="`/d/${slug}/self-tests/${id}`" variant="ghost">查看本次自测</UButton>
    </div>
    <DomainSelfTestResult v-if="current && !record.error.value" :record="current" />
  </details>
</template>
