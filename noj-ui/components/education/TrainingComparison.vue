<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import type { TrainingComparisonData, TrainingComparisonWindows } from '~/utils/education-comparison';
const props = defineProps<{ slug: string; assignmentId: string; userId: string; anchor: string }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const shown = ref(false), loading = ref(false), failure = ref(''), result = ref<TrainingComparisonData | null>(null);
function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
const anchor = new Date(props.anchor);
const windows = reactive<TrainingComparisonWindows>({
  before_start: localInput(new Date(anchor.getTime() - 86400000)),
  before_end: localInput(anchor),
  after_start: localInput(anchor),
  after_end: localInput(new Date()),
});
const fields = [{ key: 'before_start', label: '训练前开始' }, { key: 'before_end', label: '训练前结束' }, {
  key: 'after_start',
  label: '训练后开始',
}, { key: 'after_end', label: '训练后结束' }] as const;
const metrics = [
  { key: 'accepted_items', label: '正式通过题数' },
  { key: 'achieved_items', label: '达到要求题数' },
  { key: 'scored_items', label: '有正式分数题数' },
  { key: 'submitted_count', label: '受理提交数' },
  { key: 'candidate_count', label: '符合策略候选提交数' },
] as const;
const score = (value: number | null) => value === null ? '暂无正式分数' : `${(value / 100).toFixed(2)} 分`;
async function compare() {
  if (loading.value) return;
  const scope = capture(), assignmentId = props.assignmentId, userId = props.userId;
  loading.value = true;
  failure.value = '';
  result.value = null;
  try {
    const requested = Object.fromEntries(
      Object.entries(windows).map(([key, value]) => [key, new Date(value).toISOString()]),
    ) as unknown as TrainingComparisonWindows;
    const response = await education.trainingComparison(scope.slug, assignmentId, userId, requested);
    if (scope.isCurrent() && props.assignmentId === assignmentId && props.userId === userId) {
      result.value = response.data;
    }
  } catch (error) {
    if (scope.isCurrent() && props.assignmentId === assignmentId && props.userId === userId) {
      failure.value = extractApiError(error).message;
    }
  } finally {
    if (scope.isCurrent()) loading.value = false;
  }
}
watch(() => [props.slug, props.assignmentId, props.userId], () => {
  result.value = null;
  failure.value = '';
  shown.value = false;
  loading.value = false;
});
</script>
<template>
  <section class="space-y-4">
    <UButton variant="outline" @click="shown = !shown">{{ shown ? '收起训练比较' : '比较训练前后记录' }}</UButton>
    <template v-if="shown">
      <form class="space-y-3" @submit.prevent="compare">
        <p
          class="text-xs text-text-muted">按浏览器本地时区填写两段按顺序且不重叠的时间窗，包含开始、不包含结束。默认分界为作业发布时刻，可自行调整。</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <AdminFormField v-for="field in fields" :key="field.key" :label="field.label">
            <UInput v-model="windows[field.key]" type="datetime-local" step="1" required :aria-label="field.label" />
          </AdminFormField>
        </div>
        <UButton type="submit" :loading="loading">读取授权训练比较</UButton>
      </form>
      <UAlert v-if="failure" color="error" :title="failure" />
      <template v-if="result">
        <p class="text-sm text-text-secondary">{{ result.interpretation }}</p>
        <p
          class="text-xs text-text-muted">当前域题库策略 · 读取于 {{ new Date(result.computed_at).toLocaleString() }}。策略或重测变化后，重新读取可能改变比较结果。</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <UCard v-for="period in (['before', 'after'] as const)" :key="period">
            <h3 class="mb-2 font-semibold">{{ period === 'before' ? '训练前' : '训练后' }}</h3>
            <p
              class="mb-3 text-xs text-text-muted">{{ new Date(result.windows[`${period}_start`]).toLocaleString() }} → {{ new Date(result.windows[`${period}_end`]).toLocaleString() }}</p>
            <p v-for="metric in metrics" :key="metric.key"
              class="text-sm tabular-nums">{{ metric.label }}：{{ result[period][metric.key] }}</p>
          </UCard>
        </div>
        <UCard v-for="item in result.items" :key="item.item_id" class="space-y-3">
          <h3 class="font-mono font-semibold">{{ item.reference.display_ref }}</h3>
          <p
            class="text-xs text-text-muted">{{ item.requirement === 'accepted' ? '要求正式通过' : `最低分要求 ${(item.minimum_score! / 100).toFixed(2)}` }} · {{ item.policy.mode === 'any' ? '任意有效发布版本' : '指定有效版本' }} · 策略修订 {{ item.policy.revision }}</p>
          <UAlert v-if="!item.resource_available" color="warning" title="资源当前不可用，保留授权训练依据" />
          <div class="grid gap-3 sm:grid-cols-2">
            <div v-for="period in (['before', 'after'] as const)" :key="period"
              class="space-y-2 rounded border border-border p-3">
              <p
                class="text-sm font-medium">{{ period === 'before' ? '训练前' : '训练后' }}：{{ score(item[period].score) }}</p>
              <p
                class="text-xs">{{ item[period].accepted ? '有正式通过记录' : '无正式通过记录' }} · {{ item[period].achieved ? '已达到要求' : '未达到要求' }}</p>
              <p
                class="text-xs text-text-muted tabular-nums">受理 {{ item[period].submitted_count }} · 合格候选 {{ item[period].candidate_count }} · 评测中 {{ item[period].pending_count }} · 版本不匹配 {{ item[period].version_mismatch_count }}</p>
              <UCollapsible v-if="item[period].best || item[period].passed">
                <UButton variant="ghost" size="xs">查看候选与通过来源</UButton>
                <template #content>
                  <div v-for="kind in (['best', 'passed'] as const)" :key="kind" class="mt-3 text-xs">
                    <template v-if="item[period][kind]">
                      <p>{{ kind === 'best' ? '最高分候选' : '正式通过候选' }} · {{ new Date(item[period][kind]!.received_at).toLocaleString() }} · {{ score(item[period][kind]!.score) }}</p>
                      <p
                        class="mt-1 break-all font-mono text-text-muted">提交 {{ item[period][kind]!.submission_id }}</p>
                      <p
                        class="mt-1 break-all font-mono text-text-muted">评测尝试 {{ item[period][kind]!.attempt_id }}</p>
                      <p
                        class="mt-1 break-all font-mono text-text-muted">评测版本 {{ item[period][kind]!.version_id }}</p>
                    </template>
                  </div>
                </template>
              </UCollapsible>
            </div>
          </div>
          <p
            class="text-sm tabular-nums">分数变化：{{ item.score_change === null ? '两窗没有可比较的正式分数' : `${item.score_change > 0 ? '+' : ''}${(item.score_change / 100).toFixed(2)}` }}</p>
        </UCard>
      </template>
    </template>
  </section>
</template>
