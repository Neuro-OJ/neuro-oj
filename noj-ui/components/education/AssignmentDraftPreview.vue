<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import type { AssignmentDetail } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; task: AssignmentDetail }>();
const education = useEducationApi(), actor = useState<{ id: string } | null>('auth:user', () => null);
const key = computed(() =>
  educationCacheKey(props.slug, actor.value?.id ?? null, props.task.id, props.task.revision, 'draft-preview')
);
const roster = await useAsyncData(
  () => `${key.value}:roster`,
  () => education.members(props.slug, props.task.classroom_id),
);
const training = await useAsyncData(
  () => `${key.value}:training`,
  () =>
    props.task.source_training_id
      ? education.training(props.slug, props.task.source_training_id)
      : Promise.resolve(null),
);
const names = computed(() =>
  roster.data.value?.data.filter((m) =>
    m.role === 'student' && m.effective_active &&
    (!props.task.target_student_ids || props.task.target_student_ids.includes(m.user_id))
  ).map((m) => m.username) ?? []
);
</script>
<template>
  <UCard>
    <h2 class="mb-3 font-semibold">发布预览</h2>
    <p class="text-sm">{{ task.target_student_ids ? '指定学生' : '全班学生' }}：{{ names.length }} 人</p>
    <p class="mt-2 text-sm text-text-secondary">{{ names.join('、') }}</p>
    <UAlert v-if="roster.error.value" class="mt-3" color="error" :title="extractApiError(roster.error.value).message" />
    <p
      class="mt-3 text-xs text-text-muted">{{ task.include_previous_submissions ? '符合条件的发布前提交可以计入' : '只计入发布后受理的合格提交' }}</p>
    <template v-if="task.source_training_id">
      <UAlert v-if="training.error.value" class="mt-3" color="error"
        :title="extractApiError(training.error.value).message" />
      <p class="mt-3 font-medium">{{ training.data.value?.data.title }}</p>
      <p class="mt-2 text-sm">{{ training.data.value?.data.items.map((i) => i.display_ref).join('、') }}</p>
      <p class="mt-2 text-xs text-text-muted">发布时重新展开题单并固定排序；当前预览不替代发布时的授权检查。</p>
      <p
        class="mt-2 text-sm">统一要求：{{ task.source_training_rule?.requirement === 'accepted' ? '正式通过' : `至少 ${(task.source_training_rule?.minimum_score ?? 0) / 100} 分` }}</p>
    </template>
    <ol v-else class="mt-3 space-y-2">
      <li v-for="(item, index) in task.items" :key="item.id"
        class="flex flex-wrap justify-between gap-2 rounded border border-border p-3 text-sm"><span>{{ index + 1 }}. {{ item.reference.display_ref }}</span><span class="tabular-nums">{{ item.requirement === 'accepted' ? '正式通过' : `至少 ${(item.minimum_score ?? 0) / 100} 分` }}</span></li>
    </ol>
  </UCard>
</template>
