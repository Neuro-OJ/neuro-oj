<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import type { AssignmentDetail, MatrixData } from '~/utils/education';
import { currentPageRemediation } from '~/utils/education-remediation';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; task: AssignmentDetail; writable: boolean; matrix?: MatrixData }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const open = ref(false), title = ref(''), selectedStudents = ref<string[]>([]), selectedItems = ref<string[]>([]);
const targets = ref('selected'),
  items = ref('all'),
  originalRevision = ref(0),
  saving = ref(false),
  error = ref(''),
  key = ref(crypto.randomUUID());
const roster = await useAsyncData(
  () => educationCacheKey(props.slug, actor.value?.id ?? null, props.task.classroom_id, 'copy-roster'),
  () => education.members(props.slug, props.task.classroom_id),
);
const students = computed(() =>
  roster.data.value?.data.filter((m) => m.role === 'student' && m.effective_active) ?? []
);
const remediation = computed(() => props.matrix ? currentPageRemediation(props.matrix) : null);
function prepare(fromMatrix = false) {
  title.value = `${props.task.title}（补题）`;
  originalRevision.value = props.task.revision;
  selectedItems.value = [];
  selectedStudents.value = [];
  targets.value = 'selected';
  items.value = 'all';
  if (fromMatrix && remediation.value) {
    selectedStudents.value = remediation.value.studentIds.filter((id) => students.value.some((s) => s.user_id === id));
    selectedItems.value = remediation.value.itemIds;
    items.value = 'selected';
  }
  error.value = '';
  open.value = true;
}
watch([title, selectedStudents, selectedItems, targets, items], () => {
  key.value = crypto.randomUUID();
}, { deep: true });
async function copy() {
  if (saving.value || !props.writable) return;
  const scope = capture(), id = props.task.id;
  saving.value = true;
  error.value = '';
  try {
    if (targets.value === 'selected' && !selectedStudents.value.length) throw new Error('至少选择一名学生');
    if (items.value === 'selected' && !selectedItems.value.length) throw new Error('至少选择一道题目');
    const result = await education.copy(scope.slug, id, originalRevision.value, key.value, {
      title: title.value,
      ...(targets.value === 'selected' ? { target_student_ids: [...selectedStudents.value] } : {}),
      ...(items.value === 'selected' ? { item_ids: [...selectedItems.value] } : {}),
    });
    if (!scope.isCurrent() || props.task.id !== id) return;
    open.value = false;
    await navigateTo(workspacePath(scope.slug, `assignments/${result.data.id}`));
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
watch(() => [props.slug, props.task.id, actor.value?.id], () => {
  open.value = false;
});
</script>
<template>
  <div v-if="writable">
    <div class="flex flex-wrap gap-2">
      <UButton variant="outline" icon="i-lucide-copy" @click="prepare()">复制／布置补题</UButton>
      <UButton v-if="remediation" variant="outline" icon="i-lucide-list-filter"
        :disabled="!remediation.studentIds.length" @click="prepare(true)">为当前页未达标学生布置补题</UButton>
    </div>
    <UModal v-model:open="open" title="创建独立补题草稿">
      <template #body>
        <form class="space-y-4" @submit.prevent="copy">
          <UAlert v-if="error" color="error" :title="error" />
          <AdminFormField label="新任务标题" required>
            <UInput v-model="title" class="w-full" :maxlength="200" required aria-label="补题标题" />
          </AdminFormField>
          <AdminFormField label="目标学生">
            <USelect v-model="targets"
              :items="[{ label: '指定学生', value: 'selected' }, { label: '全班学生', value: 'all' }]"
              aria-label="补题学生范围" />
          </AdminFormField>
          <div v-if="targets === 'selected'" class="grid max-h-48 gap-2 overflow-auto sm:grid-cols-2">
            <UCheckbox v-for="student in students" :key="student.user_id" :label="student.username"
              :model-value="selectedStudents.includes(student.user_id)"
              @update:model-value="v => selectedStudents = v ? [...selectedStudents, student.user_id] : selectedStudents.filter(id => id !== student.user_id)" />
          </div>
          <UAlert v-if="roster.error.value" color="error" :title="extractApiError(roster.error.value).message" />
          <AdminFormField label="题目范围">
            <USelect v-model="items"
              :items="[{ label: '原作业全部题目', value: 'all' }, ...(task.items.length ? [{ label: '指定题目', value: 'selected' }] : [])]"
              aria-label="补题题目范围" />
          </AdminFormField>
          <div v-if="items === 'selected'" class="grid max-h-48 gap-2 overflow-auto sm:grid-cols-2">
            <UCheckbox v-for="item in task.items" :key="item.id" :label="item.reference.display_ref"
              :model-value="selectedItems.includes(item.id)"
              @update:model-value="v => selectedItems = v ? [...selectedItems, item.id] : selectedItems.filter(id => id !== item.id)" />
          </div>
          <p
            class="text-sm text-text-muted">创建后进入草稿预览，再调整截止并发布。新任务独立计算，不修改原任务或比赛成绩。</p>
          <p
            class="text-sm text-text-muted">所选学生收到所选全部题目；矩阵快捷选择仅包括当前页，发布前可调整名单和题目。</p>
          <UButton type="submit" :loading="saving">创建补题草稿</UButton>
        </form>
      </template>
    </UModal>
  </div>
</template>
