<script setup lang="ts">
import { teachingUtcTime } from '~/utils/education';
import type { AssignmentRemediationPreview, RemediationSelectionInput } from '~/utils/education-remediation-preview';
const props = defineProps<{
  preview: Pick<AssignmentRemediationPreview, 'students' | 'items' | 'updating' | 'excluded' | 'preview_token'>;
  initialTitle: string;
  saving: boolean;
}>();
const emit = defineEmits<{ create: [input: RemediationSelectionInput]; refresh: [] }>();
const title = ref(props.initialTitle), deadline = ref(''), error = ref('');
const students = ref<string[]>([]), items = ref<string[]>([]);
const candidateItems = computed(() => {
  const missed = new Set(props.preview.students.flatMap((student) => student.item_ids));
  return props.preview.items.filter((item) => item.resource_available && missed.has(item.id));
});
const eligibleStudents = computed(() =>
  props.preview.students.filter((student) => student.item_ids.some((id) => items.value.includes(id)))
);
watch(() => props.preview.preview_token, () => {
  students.value = props.preview.students.map((student) => student.user_id);
  items.value = candidateItems.value.map((item) => item.id);
}, { immediate: true });
watch(items, () => {
  students.value = students.value.filter((id) => eligibleStudents.value.some((student) => student.user_id === id));
});
function missedLabels(itemIds: string[]) {
  return props.preview.items.filter((item) => itemIds.includes(item.id)).map((item) => item.reference.display_ref).join(
    '、',
  );
}
function submit() {
  error.value = '';
  try {
    if (!title.value.trim()) throw new Error('请填写任务标题');
    if (!students.value.length || !items.value.length) throw new Error('至少选择一名学生和一道题目');
    emit('create', {
      title: title.value.trim(),
      target_student_ids: [...students.value],
      item_ids: [...items.value],
      deadline_at: teachingUtcTime(deadline.value),
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : '请检查补题任务设置';
  }
}
</script>
<template>
  <form class="space-y-4" @submit.prevent="submit">
    <UAlert v-if="preview.updating" color="warning" title="部分成绩仍在更新"
      description="待更新成绩已排除。可以先为当前确定未达标的学生布置补题，稍后刷新候选名单。" />
    <UAlert v-if="error" color="error" :title="error" />
    <AdminFormField label="补题任务标题" required>
      <UInput v-model="title" :disabled="saving" :maxlength="200" class="w-full" aria-label="补题任务标题" />
    </AdminFormField>
    <AdminFormField label="截止时间（可选）">
      <UInput v-model="deadline" :disabled="saving" type="datetime-local" aria-label="补题截止时间" />
    </AdminFormField>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium tabular-nums">学生 {{ students.length }} / {{ preview.students.length }}</p>
      <UButton variant="ghost" size="sm" :disabled="saving"
        @click="students = students.length === eligibleStudents.length ? [] : eligibleStudents.map(s => s.user_id)">
        {{ students.length === eligibleStudents.length ? '取消全选学生' : '全选学生' }}
      </UButton>
    </div>
    <div class="max-h-56 space-y-2 overflow-auto rounded border border-border p-3">
      <div v-for="student in preview.students" :key="student.user_id">
        <UCheckbox :label="student.username"
          :disabled="saving || !eligibleStudents.some(s => s.user_id === student.user_id)"
          :model-value="students.includes(student.user_id)"
          @update:model-value="v => students = v ? [...students, student.user_id] : students.filter(id => id !== student.user_id)" />
        <p class="ml-6 text-xs text-text-muted">未达标：{{ missedLabels(student.item_ids) }}</p>
      </div>
      <p v-if="!preview.students.length" class="text-sm text-text-muted">没有可以布置补题的未达标学生。</p>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium tabular-nums">题目 {{ items.length }} / {{ candidateItems.length }}</p>
      <UButton variant="ghost" size="sm" :disabled="saving"
        @click="items = items.length === candidateItems.length ? [] : candidateItems.map(i => i.id)">
        {{ items.length === candidateItems.length ? '取消全选题目' : '全选题目' }}
      </UButton>
    </div>
    <div class="max-h-48 space-y-2 overflow-auto rounded border border-border p-3">
      <UCheckbox v-for="item in candidateItems" :key="item.id" :disabled="saving"
        :label="`${item.reference.display_ref} · ${item.requirement === 'accepted' ? '正式通过' : `至少 ${(item.minimum_score! / 100).toFixed(2)} 分`}`"
        :model-value="items.includes(item.id)"
        @update:model-value="v => items = v ? [...items, item.id] : items.filter(id => id !== item.id)" />
    </div>
    <p class="text-sm text-text-muted tabular-nums">
      已排除 {{ preview.excluded.pending_cells }} 个待完成成绩、{{ preview.excluded.unavailable_items }} 道不可用题目及
      {{ preview.excluded.historical_students }} 名历史学生。
    </p>
    <p
      class="text-sm text-text-secondary">每名所选学生将收到全部所选题目。选题变化后，没有对应未达标题目的学生会退出选择。创建独立草稿后可预览并发布；新任务独立计算进度，原成绩和提交保持原有记录。</p>
    <div class="flex flex-wrap gap-2">
      <UButton type="submit" :loading="saving" :disabled="!students.length || !items.length">
        创建补题草稿
      </UButton>
      <UButton variant="outline" :disabled="saving" @click="emit('refresh')">刷新候选名单</UButton>
    </div>
  </form>
</template>
