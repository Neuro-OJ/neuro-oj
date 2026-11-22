<script setup lang="ts">
import type { DomainSelfTest } from '~/composables/useDomainSelfTests';
import type { UiFrameResult } from '~/utils/uiFrame';
import { domainUiSubmissionResult, domainUiSelfTestResult } from '~/utils/domain-ui-runs';
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { diffLines } from '~/utils/textDiff';
const props = defineProps<{
  slug: string; problemId: string; reference: string; contestId?: string; submissionId: string;
  selfTest: DomainSelfTest | null; code: string; writable: boolean;
}>();
const emit = defineEmits<{ result: [value: UiFrameResult | null]; restore: [code: string] }>();
const { user } = useAuth(), submissions = useDomainSubmissions(), selfTests = useDomainSelfTests(), capture = useWorkspaceActionScope();
const page = ref(1), failure = ref(''), comparing = ref<string | null>(null);
const rollback = ref<{ previous: string; restored: string } | null>(null);
const key = computed(() => workspaceCacheKey(props.slug, user.value?.id ?? null, 'ui-runs', props.problemId, props.contestId ?? 'practice'));
const directory = await useAsyncData(() => `${key.value}:page:${page.value}`, async () => {
  const [formal, practice] = await Promise.all([
    submissions.list(props.slug, page.value, { problem_id: props.problemId, contest_id: props.contestId }),
    props.contestId ? Promise.resolve(null) : selfTests.list(props.slug, props.reference, page.value),
  ]);
  return { formal, practice };
});
const latestId = computed(() => props.submissionId || directory.data.value?.formal.data.find(row => row.language === 'ui')?.id || '');
const detail = await useAsyncData(() => `${key.value}:latest:${latestId.value}`, () =>
  latestId.value ? submissions.detail(props.slug, latestId.value) : Promise.resolve(null),
);
const current = computed(() => detail.data.value?.data.id === latestId.value ? detail.data.value.data : null);
const latestSelfTestId = computed(() => props.selfTest?.id || directory.data.value?.practice?.data.find(row => row.language === 'ui')?.id || '');
const practiceDetail = await useAsyncData(() => `${key.value}:self-test:${latestSelfTestId.value}`, () =>
  props.selfTest ? Promise.resolve({ data: props.selfTest }) : latestSelfTestId.value ? selfTests.detail(props.slug, latestSelfTestId.value) : Promise.resolve(null),
);
const currentPractice = computed(() => props.selfTest ?? practiceDetail.data.value?.data ?? null);
const pending = computed(() => current.value?.result_visibility !== 'hidden' && !!latestId.value &&
  (!current.value || ['pending', 'judging'].includes(current.value.status ?? 'pending')));
const practicePending = computed(() => !props.selfTest && !!latestSelfTestId.value &&
  (!currentPractice.value || ['pending', 'judging'].includes(currentPractice.value.status)));
usePolling({ intervalMs: computed(() => (pending.value || practicePending.value) && !detail.error.value && !practiceDetail.error.value ? 1500 : null), immediate: false, fetcher: async () => { await Promise.all([detail.refresh(), practiceDetail.refresh()]); } });
const frameResult = computed(() => {
  const formal = current.value, practice = currentPractice.value;
  if (practice && (!formal || Date.parse(practice.created_at) > Date.parse(formal.created_at))) return domainUiSelfTestResult(practice);
  return formal ? domainUiSubmissionResult(formal) : null;
});
watch(frameResult, value => emit('result', value), { immediate: true });
watch(() => props.submissionId, () => { page.value = 1; directory.refresh(); });
watch(() => props.selfTest?.id, () => directory.refresh());
watch(() => props.code, value => { if (rollback.value && value !== rollback.value.restored) rollback.value = null; });
const rows = computed(() => [
  ...(directory.data.value?.formal.data ?? []).filter(row => row.language === 'ui').map(row => ({ id: row.id, kind: 'submit' as const, created_at: row.created_at })),
  ...(directory.data.value?.practice?.data ?? []).filter(row => row.language === 'ui').map(row => ({ id: row.id, kind: 'self-test' as const, created_at: row.created_at })),
].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
const totalPages = computed(() => Math.max(directory.data.value?.formal.pagination.total_pages ?? 1, directory.data.value?.practice?.pagination.total_pages ?? 1));
async function read(row: typeof rows.value[number], restore: boolean) {
  const scope = capture();
  failure.value = '';
  try {
    const record = row.kind === 'submit' ? (await submissions.detail(scope.slug, row.id)).data : (await selfTests.detail(scope.slug, row.id)).data;
    if (!scope.isCurrent()) return;
    if (record.code == null) { failure.value = '此记录不提供原参数'; return; }
    if (restore) {
      rollback.value = { previous: props.code, restored: record.code };
      emit('restore', record.code);
    } else comparing.value = record.code;
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  }
}
function undo() {
  if (!rollback.value || !props.writable) return;
  const previous = rollback.value.previous;
  rollback.value = null;
  emit('restore', previous);
}
</script>
<template>
  <section class="mt-4 space-y-3 rounded border border-border p-4">
    <div class="flex items-center justify-between gap-3"><h4 class="font-semibold">界面运行历史</h4><UButton variant="ghost" @click="directory.refresh(); detail.refresh()">刷新历史</UButton></div>
    <UAlert v-if="directory.error.value || detail.error.value || practiceDetail.error.value || failure" color="error" :title="failure || extractApiError(directory.error.value ?? detail.error.value ?? practiceDetail.error.value).message" />
    <p v-if="frameResult" class="text-sm tabular-nums">{{ frameResult.kind === 'submit' ? '提交' : '自测' }}：{{ frameResult.label }}{{ frameResult.score === null ? '' : ` · ${frameResult.score} 分` }}</p>
    <div v-if="rollback" class="flex items-center gap-3 text-sm"><span>已恢复历史参数</span><UButton variant="ghost" :disabled="!writable" @click="undo">撤销回滚</UButton></div>
    <div v-for="row in rows" :key="`${row.kind}:${row.id}`" class="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm">
      <span>{{ row.kind === 'submit' ? '提交' : '自测' }} · {{ new Date(row.created_at).toLocaleString() }}</span>
      <UButton variant="ghost" @click="read(row, false)">对比参数</UButton><UButton variant="outline" :disabled="!writable" @click="read(row, true)">回滚参数</UButton>
      <UButton variant="ghost" :to="`/d/${slug}/${row.kind === 'submit' ? 'submissions' : 'self-tests'}/${row.id}`">运行详情</UButton>
    </div>
    <div v-if="comparing !== null" class="max-h-64 overflow-auto rounded bg-bg-sunken p-3 font-mono text-xs">
      <div v-for="(line,index) in diffLines(comparing, code)" :key="index" class="whitespace-pre-wrap break-words" :class="line.kind === 'add' ? 'text-success-text' : line.kind === 'del' ? 'text-error-text' : 'text-text-secondary'">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }} {{ line.text }}</div>
    </div>
    <div v-if="totalPages > 1" class="flex items-center gap-3"><UButton variant="ghost" :disabled="page <= 1" @click="page--">上一页运行</UButton><span class="tabular-nums">{{ page }} / {{ totalPages }}</span><UButton variant="ghost" :disabled="page >= totalPages" @click="page++">下一页运行</UButton></div>
  </section>
</template>
