<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { contestPenaltyText } from '~/utils/domain-contests';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute();
const { slug } = useWorkspace();
const { user } = useAuth();
const api = useDomainContests();
const id = computed(() => String(route.params.contestId));
const official = ref(false), group = ref<'classroom' | 'other' | 'all'>('classroom'), classroomId = ref('');
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest-ranking', id.value));
const { data: contest, refresh: refreshContest } = await useAsyncData(
  computed(() => `${key.value}:contest`),
  () => api.detail(slug.value!, id.value),
);
const { data, error, status, refresh } = await useAsyncData(
  computed(() => `${key.value}:${official.value}:${classroomId.value}`),
  () => api.ranking(slug.value!, id.value, official.value, classroomId.value || undefined),
);
watch(group, (next) => {
  if (next !== 'classroom') classroomId.value = '';
});
const rows = computed(() => data.value?.classrooms?.length
  ? group.value === 'all'
    ? data.value.data ?? []
    : group.value === 'classroom'
      ? data.value.classroom_rows ?? []
      : data.value.other_rows ?? []
  : data.value?.data ?? []);
useSeoMeta({ title: '比赛成绩榜' });
usePolling({ intervalMs: computed(() => contest.value?.data.status !== 'ended' ? 2000 : null), immediate: false, fetcher: () => refreshContest() });
watch(() => contest.value?.data.status, (next, previous) => {
  if (previous && next !== previous) void refresh();
});
usePolling({
  intervalMs: computed(() => contest.value?.data.status === 'running' && !official.value ? 5000 : null),
  immediate: false,
  fetcher: () => refresh(),
});
</script>
<template>
  <div class="space-y-4">
    <div class="flex flex-wrap justify-between gap-3">
      <h2 class="text-xl font-semibold">{{ contest?.data.title }} · 成绩榜</h2>
      <div class="flex gap-2">
        <UButton :variant="official ? 'outline' : 'solid'" @click="official = false">实时榜</UButton>
        <UButton :variant="official ? 'solid' : 'outline'" @click="official = true">正式成绩</UButton>
        <UButton icon="i-lucide-refresh-cw" variant="ghost" aria-label="刷新榜单" @click="refresh()" />
      </div>
    </div>
    <div v-if="data?.classrooms?.length" class="flex flex-wrap items-center gap-3">
      <USelect v-model="group" :items="[{ label: '关联班级学生', value: 'classroom' }, { label: '其他选手', value: 'other' }, { label: '全部参赛者', value: 'all' }]" aria-label="榜单分组" />
      <USelect v-if="group === 'classroom'" v-model="classroomId" :items="[{ label: '全部关联班级', value: '' }, ...data.classrooms.map(room => ({ label: room.name, value: room.id }))]" aria-label="班级筛选" />
      <p class="text-xs text-text-muted">按当前学生名单分组，赛后练习不计入比赛成绩。</p>
    </div>
    <UAlert v-if="data?.view === 'frozen' || data?.frozen" color="warning"
      title="榜单已封榜，封榜后的提交显示待揭榜。本人结果仍按赛制显示。" />
    <UAlert v-if="data?.snapshot" color="info"
      :title="`正式成绩 V${data.snapshot.version} · ${data.snapshot.note || '首次发布'}`" />
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : rows.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无可展示的成绩" @retry="refresh()">
      <div class="overflow-auto rounded border border-border bg-bg-panel">
        <table class="w-full text-sm">
          <thead class="bg-bg-sunken">
            <tr>
              <th class="p-3 text-left">名次</th>
              <th class="p-3 text-left">选手</th>
              <th class="p-3 text-right">{{ contest?.data.type === 'acm' ? '解题数' : '总分' }}</th>
              <th v-if="contest?.data.type === 'acm'" class="p-3 text-right">总罚时</th>
              <th class="p-3 text-left">各题成绩</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.user_id" class="border-t border-border">
              <td class="p-3 tabular-nums">{{ row.rank }}</td>
              <td class="p-3">{{ row.username }}</td>
              <td
                class="p-3 text-right tabular-nums">{{ row.pending && data?.view !== 'frozen' ? '待处理' : contest?.data.type === 'acm' ? row.solved : (row.total_score / 100).toFixed(2) }}</td>
              <td v-if="contest?.data.type === 'acm'"
                class="p-3 text-right tabular-nums">{{ contestPenaltyText(row.penalty_ms ?? 0) }}</td>
              <td class="p-3">
                <span v-for="score in row.problem_scores" :key="score.label" class="mr-3 inline-block tabular-nums">
                  {{ score.label }}:
                  <template v-if="contest?.data.type === 'acm'">{{ score.accepted ? 'AC' : score.attempts ? `${score.attempts} 次未通过` : '未提交' }}<span v-if="score.accepted"> · {{ contestPenaltyText(score.penalty_ms ?? 0) }}</span></template>
                  <template v-else>{{ score.best_score == null ? '待处理' : (score.best_score / 100).toFixed(2) }}</template>
                  <span v-if="score.pending" class="ml-1 text-text-muted">{{ data?.view === 'frozen' ? '待揭榜' : '待处理' }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncContent>
  </div>
</template>
