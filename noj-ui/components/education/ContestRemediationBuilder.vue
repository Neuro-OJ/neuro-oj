<script setup lang="ts">
import { educationCacheKey, teachingScore } from '~/utils/education';
import type {
  ContestRemediationCriteria,
  ContestRemediationPreview,
  RemediationSelectionInput,
} from '~/utils/education-remediation-preview';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
/** 与路由页名称区分，避免组件解析误认为页面自身。 */
const props = defineProps<{ slug: string; classroomId: string; writable: boolean }>();
const education = useEducationApi(), contests = useDomainContests(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const page = ref(1), contestId = ref(''), ranking = ref<'live' | 'official'>('official');
const selectedTitle = ref('');
const requirement = ref<'accepted' | 'min_score'>('accepted'), minimum = ref('60');
const preview = ref<ContestRemediationPreview | null>(null), basis = ref<ContestRemediationCriteria | null>(null);
const loading = ref(false), saving = ref(false), error = ref('');
let sequence = 0, previousBody = '', key = crypto.randomUUID();
const options = await useAsyncData(
  () => educationCacheKey(props.slug, actor.value?.id ?? null, props.classroomId, 'remediation-contests', page.value),
  () => contests.list(props.slug, page.value),
);
watch(contestId, (id) => {
  selectedTitle.value = options.data.value?.data.find((contest) => contest.id === id)?.title ?? selectedTitle.value;
});
async function refresh() {
  if (loading.value || saving.value || !props.writable) return;
  error.value = '';
  if (!contestId.value) {
    error.value = '请先选择比赛';
    return;
  }
  let criteria: ContestRemediationCriteria;
  try {
    criteria = {
      contest_id: contestId.value,
      ranking_source: ranking.value,
      requirement: requirement.value,
      ...(requirement.value === 'min_score' ? { minimum_score: teachingScore(minimum.value) } : {}),
    };
  } catch (e) {
    error.value = e instanceof Error ? e.message : '请检查最低分';
    return;
  }
  const context = capture(), classroomId = props.classroomId, request = ++sequence;
  loading.value = true;
  preview.value = null;
  try {
    const result = await education.contestRemediationPreview(context.slug, classroomId, criteria);
    if (!context.isCurrent() || request !== sequence || classroomId !== props.classroomId) return;
    basis.value = criteria;
    preview.value = result.data;
  } catch (e) {
    if (context.isCurrent() && request === sequence) error.value = extractApiError(e).message;
  } finally {
    if (request === sequence) loading.value = false;
  }
}
async function create(input: RemediationSelectionInput) {
  if (saving.value || !preview.value || !basis.value || !props.writable) return;
  const context = capture(), classroomId = props.classroomId, source = preview.value;
  const body = { ...basis.value, ...input, preview_token: source.preview_token };
  const signature = JSON.stringify(body);
  if (signature !== previousBody) {
    previousBody = signature;
    key = crypto.randomUUID();
  }
  error.value = '';
  saving.value = true;
  try {
    const result = await education.createContestRemediation(
      context.slug,
      classroomId,
      source.source.revision,
      key,
      body,
    );
    if (!context.isCurrent() || classroomId !== props.classroomId) return;
    await navigateTo(workspacePath(context.slug, `assignments/${result.data.id}`));
  } catch (e) {
    if (context.isCurrent()) error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
watch(
  [contestId, ranking, requirement, minimum, () => props.slug, () => props.classroomId, () => actor.value?.id],
  () => {
    ++sequence;
    preview.value = null;
    basis.value = null;
    loading.value = false;
  },
);
</script>
<template>
  <div class="space-y-5">
    <UAlert color="info" title="比赛成绩用于选取补题对象"
      description="只使用当前获授权的比赛成绩，不因教练身份解除比赛保密。新作业使用当前空间题库策略，独立计算进度；原排名、正式快照及提交保留原记录。" />
    <UAlert v-if="error" color="error" :title="error" />
    <div class="space-y-3 rounded border border-border p-4">
      <h2 class="font-semibold">选择同域来源比赛</h2>
      <AsyncContent
        :status="options.error.value ? 'error' : options.status.value === 'pending' ? 'loading' : options.data.value?.data.length ? 'data' : 'empty'"
        :error="options.error.value ? extractApiError(options.error.value).message : undefined"
        empty-text="暂无可访问的比赛" @retry="options.refresh()">
        <URadioGroup v-model="contestId" :disabled="saving || loading"
          :items="options.data.value?.data.map(contest => ({ label: contest.title, value: contest.id }))"
          aria-label="补题来源比赛" />
      </AsyncContent>
      <UPagination v-if="options.data.value && options.data.value.pagination.total_pages > 1" v-model:page="page"
        :total="options.data.value.pagination.total" :items-per-page="20" />
      <p v-if="preview" class="text-sm text-text-secondary">已选择：{{ preview.source.title }}</p>
      <p v-else-if="contestId" class="text-sm text-text-muted">已选择：{{ selectedTitle }}。请读取候选名单。</p>
    </div>
    <div class="flex flex-wrap items-end gap-4">
      <AdminFormField label="成绩来源">
        <USelect v-model="ranking" :disabled="loading || saving" aria-label="比赛补题成绩来源"
          :items="[{ label: '正式成绩（已发布快照）', value: 'official' }, { label: '实时榜（按当前授权）', value: 'live' }]" />
      </AdminFormField>
      <AdminFormField label="补题达标要求">
        <USelect v-model="requirement" :disabled="loading || saving" aria-label="比赛补题达标要求"
          :items="[{ label: '正式通过', value: 'accepted' }, { label: '最低原始分', value: 'min_score' }]" />
      </AdminFormField>
      <AdminFormField v-if="requirement === 'min_score'" label="最低分（百分制）">
        <UInput v-model="minimum" type="number" min="0" max="100" step="0.01" :disabled="loading || saving"
          aria-label="比赛补题最低分" />
      </AdminFormField>
      <UButton :loading="loading" :disabled="saving || !contestId || !writable" @click="refresh">预览全班候选</UButton>
    </div>
    <p
      class="text-sm text-text-muted">最低分按正式评测原始百分制成绩判断；通过要求依据正式判定，不从比赛加权得分推断。</p>
    <UCard v-if="preview">
      <h2
        class="mb-3 font-semibold">{{ preview.source.title }} · {{ preview.source.ranking_source === 'official' ? preview.source.snapshot_version === null ? '正式成绩' : `正式快照 v${preview.source.snapshot_version}` : '当前获授权实时成绩' }}</h2>
      <RemediationSelection :preview="preview" :initial-title="`${preview.source.title}（补题）`" :saving="saving"
        @create="create" @refresh="refresh" />
    </UCard>
  </div>
</template>
