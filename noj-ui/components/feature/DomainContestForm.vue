<script setup lang="ts">
import type { DomainContest } from '~/composables/useDomainContests';
import type { ContestPayload, ContestType } from '~/composables/useContests';
import type { DomainProblemSummary } from '~/utils/domain-problems';
import { DOMAIN_CONTEST_TYPES, domainContestAllows, domainContestDefaults } from '~/utils/domain-contests';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; existing?: DomainContest }>();
const api = useDomainContests();
const problemApi = useDomainProblems();
const scope = useWorkspaceActionScope();
const { user } = useAuth();
const title = ref(props.existing?.title ?? '');
const description = ref(props.existing?.description ?? '');
const type = ref<ContestType>(props.existing?.type ?? 'kaggle');
const localTime = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const start = ref(props.existing ? localTime(props.existing.start_time) : '');
const end = ref(props.existing ? localTime(props.existing.end_time) : '');
const defaults = domainContestDefaults(type.value);
const visibility = ref(props.existing?.ranking_visibility ?? defaults.ranking_visibility);
const freezeMinutes = ref((props.existing?.freeze_duration_seconds ?? defaults.freeze_duration_seconds) / 60);
const penalty = ref(props.existing?.config.penalty_minutes ?? 20);
const scoreboard = ref<'self' | 'full'>(props.existing?.config.scoreboard_scope ?? 'self');
const isPublic = ref(props.existing?.is_public ?? true);
const password = ref('');
const selected = ref<Array<{ problem: DomainProblemSummary; score: number; label: string }>>([]);
if (props.existing) {
  const existingId = props.existing.id;
  const loaded = await useAsyncData(
    `contest-edit-problems:${props.slug}:${existingId}:${user.value?.id}`,
    () => api.problems(props.slug, existingId),
  );
  if (loaded.data.value) {
    selected.value = loaded.data.value.data.map((problem) => ({
      problem: {
        reference: problem.reference!,
        title: problem.title,
        kind: problem.is_objective ? 'objective' : problem.judge_type === 'oi' ? 'oi' : 'ai',
        version_id: problem.version_id!,
        version: problem.version!,
        binding_id: problem.problem_id,
        policy_revision: problem.effective_version_policy_revision ?? 1,
      },
      score: problem.score / 100,
      label: problem.label,
    }));
  }
}
const search = ref('');
const page = ref(1);
const requestKey = computed(() => `contest-picker:${props.slug}:${user.value?.id}:${page.value}:${search.value}`);
const { data: choices, error: choicesError, refresh: refreshChoices } = await useAsyncData(
  requestKey,
  () => problemApi.list(props.slug, page.value, search.value),
);
const available = computed(() =>
  choices.value?.items.filter((problem) => domainContestAllows(type.value, problem.kind)) ?? []
);
const locked = computed(() => !!props.existing && props.existing.status !== 'pending');
const saving = ref(false);
const error = ref('');
watch(type, (value) => {
  if (locked.value) return;
  const config = domainContestDefaults(value);
  visibility.value = config.ranking_visibility;
  freezeMinutes.value = config.freeze_duration_seconds / 60;
  selected.value = selected.value.filter((entry) => domainContestAllows(value, entry.problem.kind));
});
function add(problem: DomainProblemSummary) {
  if (!selected.value.some((entry) => entry.problem.binding_id === problem.binding_id)) {
    selected.value.push({ problem, score: 100, label: String.fromCharCode(65 + selected.value.length) });
  }
}
async function save() {
  if (saving.value) return;
  const operation = scope();
  const body: ContestPayload = {
    title: title.value,
    description: description.value,
    start_time: new Date(start.value).toISOString(),
    end_time: new Date(end.value).toISOString(),
    type: type.value,
    kind: isPublic.value ? 'public' : 'invite',
    is_public: isPublic.value,
    affect_global_ranking: false,
    ranking_visibility: visibility.value,
    freeze_duration_seconds: freezeMinutes.value * 60,
    config: type.value === 'acm'
      ? { penalty_minutes: penalty.value }
      : type.value === 'kaggle'
      ? { scoreboard_scope: scoreboard.value }
      : {},
    ...(password.value ? { password: password.value } : {}),
    problems: selected.value.map((entry, sort_order) => ({
      problem_id: entry.problem.reference.problem_id,
      sort_order,
      label: entry.label,
      score: Math.round(entry.score * 100),
    })),
  };
  saving.value = true;
  error.value = '';
  try {
    const response = props.existing
      ? await api.update(
        operation.slug,
        props.existing.id,
        locked.value ? { title: body.title, description: body.description } : body,
        props.existing.revision,
      )
      : await api.create(operation.slug, body);
    if (operation.isCurrent()) await navigateTo(`/d/${operation.slug}/contests/${response.data.id}`);
  } catch (e) {
    if (operation.isCurrent()) error.value = extractApiError(e).message;
  } finally {
    if (operation.isCurrent()) saving.value = false;
  }
}
</script>
<template>
  <form class="space-y-5" @submit.prevent="save">
    <UCard class="space-y-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <AdminFormField label="比赛名称" required>
          <UInput v-model="title" required class="w-full" />
        </AdminFormField>
        <AdminFormField label="赛制">
          <USelect v-model="type" :items="[...DOMAIN_CONTEST_TYPES]" :disabled="locked" class="w-full" />
        </AdminFormField>
        <AdminFormField label="开始时间" required>
          <UInput v-model="start" type="datetime-local" required :disabled="locked" />
        </AdminFormField>
        <AdminFormField label="结束时间" required>
          <UInput v-model="end" type="datetime-local" required :disabled="locked" />
        </AdminFormField>
      </div>
      <p
        class="my-3 text-sm text-text-secondary">{{ DOMAIN_CONTEST_TYPES.find((entry) => entry.value === type)?.description }}</p>
      <AdminFormField label="比赛说明">
        <MarkdownEditor v-model="description" />
      </AdminFormField>
    </UCard>
    <UCard>
      <div class="grid gap-4 sm:grid-cols-2">
        <AdminFormField label="榜单可见性">
          <USelect v-model="visibility"
            :items="[{ value: 'participants', label: '仅参赛者' }, { value: 'public', label: '公开' }, { value: 'hidden', label: '隐藏' }]"
            :disabled="locked" />
        </AdminFormField>
        <AdminFormField v-if="type === 'kaggle'" label="赛时榜单">
          <USelect v-model="scoreboard"
            :items="[{ value: 'self', label: '本人榜' }, { value: 'full', label: '完整榜' }]" :disabled="locked" />
        </AdminFormField>
        <AdminFormField v-if="type === 'acm'" label="每次计罚失败（分钟）">
          <UInput v-model.number="penalty" type="number" min="0" max="1440" :disabled="locked" />
        </AdminFormField>
        <AdminFormField v-if="type === 'acm'" label="结束前封榜窗口（分钟，0 关闭）">
          <UInput v-model.number="freezeMinutes" type="number" min="0" :disabled="locked" />
        </AdminFormField>
        <AdminFormField label="比赛入口">
          <UCheckbox v-model="isPublic" label="域内公开比赛入口" :disabled="locked" />
        </AdminFormField>
        <AdminFormField v-if="!isPublic" label="报名密码">
          <UInput v-model="password" type="password" autocomplete="new-password" :disabled="locked" />
        </AdminFormField>
      </div>
      <UAlert v-if="locked" class="mt-4" title="已开赛，赛制与计分规则已锁定。当前仅修改名称和说明。" color="info" />
    </UCard>
    <UCard v-if="!locked">
      <h3 class="mb-3 font-semibold">题目与顺序</h3>
      <UAlert v-if="selected.some((entry) => entry.problem.reference.is_shared)" color="warning"
        title="引用公开题无法保证来源题面、题解及其他域练习保密。" class="mb-3" />
      <div v-for="(entry, index) in selected" :key="entry.problem.binding_id" class="mb-2 flex items-center gap-2">
        <UInput v-model="entry.label" aria-label="题目标号" class="w-20" /><span class="flex-1">{{ entry.problem.reference.display_ref }} · {{ entry.problem.title }}</span>
        <UInput v-model.number="entry.score" type="number" min="1" aria-label="题目满分" class="w-24" :disabled="entry.problem.kind === 'objective' || type === 'acm'" />
        <UButton type="button" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="移除题目" @click="selected.splice(index, 1)" />
      </div>
      <UInput v-model="search" placeholder="搜索本域题库" class="my-3 w-full" @update:model-value="page = 1" />
      <UAlert v-if="choicesError" color="error" :title="extractApiError(choicesError).message">
        <template #actions>
          <UButton @click="refreshChoices()">重试</UButton>
        </template>
      </UAlert>
      <div class="max-h-72 overflow-auto">
        <UButton v-for="problem in available" :key="problem.binding_id" type="button" color="neutral" variant="ghost"
          class="mb-1 mr-1" @click="add(problem)">{{ problem.reference.display_ref }} · {{ problem.title }}</UButton>
      </div>
      <UPagination v-if="choices && choices.total > 30" v-model:page="page" :total="choices.total"
        :items-per-page="30" />
      <p class="mt-3 text-xs text-text-muted">客观题百分制原分直接计入总分，不乘题目满分。</p>
    </UCard>
    <UAlert v-if="error" color="error" :title="error" />
    <UButton type="submit" :loading="saving"
      :disabled="!title.trim() || !start || !end || (!locked && !selected.length)">保存比赛</UButton>
  </form>
</template>
