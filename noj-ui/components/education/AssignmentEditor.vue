<script setup lang="ts">
import {
  educationCacheKey,
  teachingLocalTime,
  teachingScore,
  teachingTrainingId,
  teachingUtcTime,
} from '~/utils/education';
import type { AssignmentDetail, AssignmentDraftInput, TeachingProblemOption } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; classroomId: string; initial?: AssignmentDetail }>();
const emit = defineEmits<{ saved: [id: string] }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const originalRevision = props.initial?.revision ?? 0;
const title = ref(props.initial?.title ?? ''), description = ref(props.initial?.description ?? '');
const deadline = ref(teachingLocalTime(props.initial?.deadline_at ?? null));
const previous = ref(props.initial?.include_previous_submissions ?? false);
const selectedStudents = ref([...(props.initial?.target_student_ids ?? [])]);
const target = ref(props.initial?.target_student_ids ? 'selected' : 'all');
const mode = ref(props.initial?.source_training_id ? 'training' : 'items');
const trainingLink = ref(props.initial?.source_training_id ?? ''), trainingTitle = ref('');
const trainingRequirement = ref(props.initial?.source_training_rule?.requirement ?? 'accepted');
const trainingScore = ref(String((props.initial?.source_training_rule?.minimum_score ?? 6000) / 100));
const trainingPreview = ref<string[]>([]), trainingChecked = ref(props.initial?.source_training_id ?? '');
const items = ref(
  (props.initial?.items ?? []).map((i) => ({
    binding_id: i.binding_id,
    reference: i.reference.display_ref,
    requirement: i.requirement,
    score: String((i.minimum_score ?? 6000) / 100),
  })),
);
const keyword = ref(''), searchDraft = ref(''), problemPage = ref(1), reference = ref('');
const saving = ref(false), adding = ref(false), checking = ref(false), error = ref('');
const snapshot = () => JSON.stringify({ title: title.value, description: description.value, deadline: deadline.value,
  previous: previous.value, students: selectedStudents.value, target: target.value, mode: mode.value,
  training: trainingLink.value, requirement: trainingRequirement.value, score: trainingScore.value, items: items.value,
});
const savedSnapshot = ref(snapshot());
useUnsavedChanges(() => snapshot() !== savedSnapshot.value);
const base = computed(() =>
  educationCacheKey(props.slug, actor.value?.id ?? null, props.classroomId, 'assignment-editor')
);
const roster = await useAsyncData(
  () => `${base.value}:members`,
  () => education.members(props.slug, props.classroomId),
);
const problems = await useAsyncData(
  () => `${base.value}:problems:${problemPage.value}:${keyword.value}`,
  () => education.problems(props.slug, problemPage.value, keyword.value),
);
const students = computed(() =>
  roster.data.value?.data.filter((m) => m.role === 'student' && m.effective_active) ?? []
);
watch(keyword, () => {
  problemPage.value = 1;
});
watch(trainingLink, () => {
  trainingChecked.value = '';
  trainingTitle.value = '';
  trainingPreview.value = [];
});
function add(item: TeachingProblemOption) {
  if (!items.value.some((i) => i.binding_id === item.binding_id) && items.value.length < 200) {
    items.value.push({
      binding_id: item.binding_id,
      reference: item.reference.display_ref,
      requirement: 'accepted',
      score: '60',
    });
  }
}
function move(index: number, delta: number) {
  const other = index + delta;
  if (other >= 0 && other < items.value.length) {
    [items.value[index], items.value[other]] = [items.value[other]!, items.value[index]!];
  }
}
async function addReference() {
  if (adding.value) return;
  const scope = capture(), classId = props.classroomId;
  adding.value = true;
  error.value = '';
  try {
    const result = await education.problem(scope.slug, reference.value.trim());
    if (scope.isCurrent() && props.classroomId === classId) {
      add({ ...result, title: result.content.title, kind: result.content.kind });
      reference.value = '';
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    adding.value = false;
  }
}
async function previewTraining() {
  if (checking.value) return;
  const scope = capture(), entered = trainingLink.value;
  checking.value = true;
  error.value = '';
  try {
    const id = teachingTrainingId(entered), result = await education.training(scope.slug, id);
    if (!scope.isCurrent() || trainingLink.value !== entered) return;
    trainingChecked.value = id;
    trainingTitle.value = result.data.title;
    trainingPreview.value = result.data.items.map((i) => i.display_ref);
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    checking.value = false;
  }
}
function payload(): AssignmentDraftInput {
  if (!title.value.trim()) throw new Error('请填写作业标题');
  if (target.value === 'selected' && !selectedStudents.value.length) throw new Error('至少选择一名学生');
  const input: AssignmentDraftInput = {
    title: title.value.trim(),
    description: description.value,
    deadline_at: teachingUtcTime(deadline.value),
    include_previous_submissions: previous.value,
    target_student_ids: target.value === 'all' ? null : [...selectedStudents.value],
  };
  if (mode.value === 'training') {
    const id = teachingTrainingId(trainingLink.value);
    if (id !== trainingChecked.value) throw new Error('请先预览题单并确认题目');
    input.training = {
      id,
      requirement: trainingRequirement.value,
      minimum_score: trainingRequirement.value === 'min_score' ? teachingScore(trainingScore.value) : null,
    };
  } else {
    if (!items.value.length) throw new Error('至少选择一道题目');
    input.items = items.value.map((i) => ({
      binding_id: i.binding_id,
      requirement: i.requirement,
      minimum_score: i.requirement === 'min_score' ? teachingScore(i.score) : null,
    }));
  }
  return input;
}
async function save() {
  if (saving.value) return;
  const scope = capture(), classId = props.classroomId, id = props.initial?.id;
  saving.value = true;
  error.value = '';
  try {
    const input = payload();
    const result = id
      ? await education.saveAssignment(scope.slug, id, input, originalRevision)
      : await education.createAssignment(scope.slug, classId, input);
    if (scope.isCurrent() && props.classroomId === classId) {
      savedSnapshot.value = snapshot();
      emit('saved', result.data.id);
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <form class="space-y-5" @submit.prevent="save">
    <UAlert v-if="error" color="error" :title="error" />
    <UAlert v-if="initial?.publish_error" color="warning" title="上次定时发布失败"
      :description="initial.publish_error" />
    <AdminFormField label="作业标题" required>
      <UInput v-model="title" class="w-full" :maxlength="200" required aria-label="作业标题" />
    </AdminFormField>
    <AdminFormField label="作业说明">
      <MarkdownEditor v-model="description" height="240px" :maxlength="30000" />
    </AdminFormField>
    <div class="grid gap-4 sm:grid-cols-2">
      <AdminFormField label="截止时间" hint="按当地时间填写。留空表示无截止；截止后仍可练习。">
        <UInput v-model="deadline" type="datetime-local" aria-label="作业截止时间" />
      </AdminFormField>
      <AdminFormField label="历史提交">
        <UCheckbox v-model="previous" label="允许符合条件的发布前提交计入" />
      </AdminFormField>
    </div>
    <UCard>
      <h2 class="mb-3 font-semibold">目标学生</h2>
      <USelect v-model="target" :items="[{ label: '全班学生', value: 'all' }, { label: '指定学生', value: 'selected' }]"
        aria-label="作业目标范围" />
      <p v-if="target === 'all'"
        class="mt-3 text-sm text-text-muted">发布时固定实际名单，未截止时新加入的学生会自动补入。</p>
      <template v-else>
        <UAlert v-if="roster.error.value" class="mt-3" color="error"
          :title="extractApiError(roster.error.value).message" />
        <div class="mt-3 grid max-h-64 gap-2 overflow-auto sm:grid-cols-2">
          <UCheckbox v-for="student in students" :key="student.user_id"
            :model-value="selectedStudents.includes(student.user_id)" :label="student.username"
            @update:model-value="v => selectedStudents = v ? [...selectedStudents, student.user_id] : selectedStudents.filter(id => id !== student.user_id)" />
        </div>
      </template>
    </UCard>
    <UCard>
      <h2 class="mb-3 font-semibold">题目与达标要求</h2>
      <USelect v-model="mode"
        :items="[{ label: '从本域题库选题', value: 'items' }, { label: '从已引用题单创建', value: 'training' }]"
        aria-label="作业选题方式" />
      <template v-if="mode === 'training'">
        <div class="mt-4 flex gap-2">
          <UInput v-model="trainingLink" class="grow" placeholder="粘贴域内题单链接" aria-label="题单链接" />
          <UButton type="button" :loading="checking" @click="previewTraining">预览题单</UButton>
        </div>
        <p v-if="trainingTitle" class="mt-3 font-medium">{{ trainingTitle }}</p>
        <p v-if="trainingPreview.length" class="mt-2 text-sm">{{ trainingPreview.join('、') }}</p>
        <p class="mt-3 text-xs text-text-muted">发布时重新读取题单并固定题目集合；发布后题单增删不会改变作业。</p>
        <div class="mt-3 flex gap-3">
          <USelect v-model="trainingRequirement"
            :items="[{ label: '正式通过', value: 'accepted' }, { label: '最低分', value: 'min_score' }]"
            aria-label="题单达标要求" />
          <UInput v-if="trainingRequirement === 'min_score'" v-model="trainingScore" type="number" min="0" max="100"
            step="0.01" aria-label="题单最低分" />
        </div>
      </template>
      <template v-else>
        <div class="mt-4 flex flex-wrap gap-2">
          <UInput v-model="searchDraft" placeholder="按标题搜索题库" aria-label="题目标题搜索"
            @keyup.enter.prevent="keyword = searchDraft.trim()" />
          <UButton type="button" variant="outline" @click="keyword = searchDraft.trim()">搜索</UButton>
          <UInput v-model="reference" placeholder="题号，如 1001 或 main:1001" aria-label="精确题号" />
          <UButton type="button" variant="outline" :loading="adding" :disabled="!reference.trim()"
            @click="addReference">按题号添加</UButton>
        </div>
        <UAlert v-if="problems.error.value" class="mt-3" color="error"
          :title="extractApiError(problems.error.value).message" />
        <div class="mt-3 max-h-60 overflow-auto rounded border border-border">
          <div v-for="problem in problems.data.value?.items" :key="problem.binding_id"
            class="flex items-center justify-between gap-3 border-b border-border p-3 text-sm"><span>{{ problem.reference.display_ref }} · {{ problem.title }}</span><UButton type="button" size="sm" variant="ghost" :disabled="items.some(i => i.binding_id === problem.binding_id) || items.length >= 200" @click="add(problem)">添加</UButton></div>
        </div>
        <div
          class="mt-2 flex items-center gap-2"><UButton type="button" variant="ghost" :disabled="problemPage <= 1" @click="problemPage--">上一页题目</UButton><span class="text-xs tabular-nums">{{ problemPage }}</span><UButton type="button" variant="ghost" :disabled="problemPage * 50 >= (problems.data.value?.total ?? 0)" @click="problemPage++">下一页题目</UButton></div>
        <div v-for="(item, index) in items" :key="item.binding_id"
          class="mt-3 flex flex-wrap items-center gap-2 rounded border border-border p-3"><span class="mr-auto text-sm tabular-nums">{{ index + 1 }}. {{ item.reference }}</span><USelect v-model="item.requirement" :items="[{ label: '正式通过', value: 'accepted' }, { label: '最低分', value: 'min_score' }]" :aria-label="`${item.reference} 达标要求`" /><UInput v-if="item.requirement === 'min_score'" v-model="item.score" type="number" min="0" max="100" step="0.01" class="w-24" :aria-label="`${item.reference} 最低分`" /><UButton type="button" variant="ghost" icon="i-lucide-arrow-up" :disabled="index === 0" aria-label="上移题目" @click="move(index, -1)" /><UButton type="button" variant="ghost" icon="i-lucide-arrow-down" :disabled="index === items.length - 1" aria-label="下移题目" @click="move(index, 1)" /><UButton type="button" color="error" variant="ghost" icon="i-lucide-x" aria-label="移除题目" @click="items.splice(index, 1)" /></div>
      </template>
    </UCard>
    <p
      class="text-sm text-text-muted">先保存草稿，再预览并发布。发布后题目集合和达标要求固定，版本及成绩口径仍跟随本域题库。</p>
    <UButton type="submit" :loading="saving">{{ initial ? '保存草稿修改' : '创建作业草稿' }}</UButton>
  </form>
</template>
