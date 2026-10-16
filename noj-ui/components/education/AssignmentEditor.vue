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
  <form class="space-y-6" @submit.prevent="save">
    <UAlert v-if="error" color="error" :title="error" />
    <UAlert
      v-if="initial?.publish_error"
      color="warning"
      title="上次定时发布失败"
      :description="initial.publish_error"
    />

    <!-- 卡片 1：基本信息 -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-file-text" class="size-5 text-primary" />
          <h2 class="font-semibold text-text">基本信息</h2>
        </div>
      </template>

      <div class="space-y-4">
        <AdminFormField label="作业标题" required>
          <UInput
            v-model="title"
            class="w-full"
            :maxlength="200"
            required
            aria-label="作业标题"
            placeholder="例如：第二周算法进阶训练（动态规划专题）"
          />
        </AdminFormField>

        <AdminFormField label="作业说明">
          <MarkdownEditor v-model="description" height="220px" :maxlength="30000" placeholder="说明本次作业要求、训练目标或提示信息" />
        </AdminFormField>

        <div class="grid gap-4 sm:grid-cols-2 pt-2 border-t border-border">
          <AdminFormField label="截止时间" hint="按当地时间填写。留空表示无截止；截止后仍可练习。">
            <UInput v-model="deadline" type="datetime-local" aria-label="作业截止时间" class="w-full" />
          </AdminFormField>
          <div class="flex flex-col justify-end pb-2">
            <UCheckbox v-model="previous" label="允许符合条件的发布前提交计入有效成绩" />
          </div>
        </div>
      </div>
    </UCard>

    <!-- 卡片 2：目标学生 -->
    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-users" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">目标学生范围</h2>
          </div>
          <UBadge v-if="target === 'selected'" color="primary" variant="subtle" size="sm" class="tabular-nums">
            已选择 {{ selectedStudents.length }} 人
          </UBadge>
        </div>
      </template>

      <div class="space-y-3">
        <USelect
          v-model="target"
          :items="[{ label: '全班学生（包含后续新入班学生）', value: 'all' }, { label: '指定学生名单', value: 'selected' }]"
          aria-label="作业目标范围"
          class="w-full sm:w-80"
        />

        <p v-if="target === 'all'" class="text-sm text-text-muted">
          发布时将绑定班级当前有效学生，并在截止前自动包含新批准加入的学生。
        </p>

        <template v-else>
          <UAlert
            v-if="roster.error.value"
            color="error"
            :title="extractApiError(roster.error.value).message"
          />
          <div class="rounded-lg border border-border bg-bg-sunken/40 p-3 max-h-60 overflow-auto">
            <div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              <div
                v-for="student in students"
                :key="student.user_id"
                class="flex items-center gap-2 rounded px-2.5 py-1.5 hover:bg-white dark:hover:bg-bg-panel transition-colors"
              >
                <UCheckbox
                  :model-value="selectedStudents.includes(student.user_id)"
                  :label="student.username"
                  @update:model-value="v => selectedStudents = v ? [...selectedStudents, student.user_id] : selectedStudents.filter(id => id !== student.user_id)"
                />
              </div>
            </div>
            <p v-if="!students.length" class="text-xs text-text-muted text-center py-4">班级暂无有效学生成员</p>
          </div>
        </template>
      </div>
    </UCard>

    <!-- 卡片 3：题目与达标规则 -->
    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-list-checks" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">题目与达标规则</h2>
          </div>
          <UBadge v-if="mode === 'items'" color="neutral" variant="subtle" size="sm" class="tabular-nums">
            已选 {{ items.length }} 道题
          </UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm font-medium text-text-secondary">选题模式：</span>
          <USelect
            v-model="mode"
            :items="[{ label: '从本域题库逐道选题', value: 'items' }, { label: '从已引用题单整单导入', value: 'training' }]"
            aria-label="作业选题方式"
            class="w-64"
          />
        </div>

        <!-- 题单整单模式 -->
        <template v-if="mode === 'training'">
          <div class="rounded-lg border border-border bg-bg-sunken/30 p-4 space-y-3">
            <div class="flex gap-2">
              <UInput
                v-model="trainingLink"
                class="grow"
                placeholder="粘贴域内题单链接或编号"
                aria-label="题单链接"
              />
              <UButton type="button" color="primary" variant="outline" :loading="checking" @click="previewTraining">
                预览题单
              </UButton>
            </div>
            <p v-if="trainingTitle" class="font-medium text-text">{{ trainingTitle }}</p>
            <p v-if="trainingPreview.length" class="text-sm text-text-secondary leading-relaxed">
              包含题目：{{ trainingPreview.join('、') }}
            </p>
            <p class="text-xs text-text-muted">
              发布时重新读取题单并固定题目集合；发布后题单后续增删不会改变本作业。
            </p>
            <div class="flex items-center gap-3 pt-2">
              <span class="text-sm text-text-secondary">题单统一达标规则：</span>
              <USelect
                v-model="trainingRequirement"
                :items="[{ label: '正式通过 (AC)', value: 'accepted' }, { label: '最低分 (百分制)', value: 'min_score' }]"
                aria-label="题单达标要求"
                class="w-48"
              />
              <UInput
                v-if="trainingRequirement === 'min_score'"
                v-model="trainingScore"
                type="number"
                min="0"
                max="100"
                step="0.01"
                aria-label="题单最低分"
                class="w-24 tabular-nums"
              />
            </div>
          </div>
        </template>

        <!-- 题库选题模式 -->
        <template v-else>
          <!-- 搜索与题号快捷添加 -->
          <div class="flex flex-wrap items-center gap-2">
            <UInput
              v-model="searchDraft"
              placeholder="按标题搜索域内题库"
              aria-label="题目标题搜索"
              class="grow max-w-sm"
              @keyup.enter.prevent="keyword = searchDraft.trim()"
            />
            <UButton type="button" variant="outline" color="neutral" @click="keyword = searchDraft.trim()">
              搜索
            </UButton>
            <span class="text-text-muted text-xs mx-1">或</span>
            <UInput
              v-model="reference"
              placeholder="题号，如 1001"
              aria-label="精确题号"
              class="w-36"
            />
            <UButton
              type="button"
              variant="outline"
              color="primary"
              :loading="adding"
              :disabled="!reference.trim()"
              @click="addReference"
            >
              按题号添加
            </UButton>
          </div>

          <UAlert
            v-if="problems.error.value"
            color="error"
            :title="extractApiError(problems.error.value).message"
          />

          <!-- 可选题目预览列表 -->
          <div class="rounded-lg border border-border bg-white dark:bg-bg-panel max-h-56 overflow-auto divide-y divide-border">
            <div
              v-for="problem in problems.data.value?.items"
              :key="problem.binding_id"
              class="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm hover:bg-bg-sunken/50 transition-colors"
            >
              <div class="flex items-center gap-2 truncate">
                <span class="font-mono text-xs text-primary font-medium shrink-0">{{ problem.reference.display_ref }}</span>
                <span class="truncate text-text">{{ problem.title }}</span>
              </div>
              <UButton
                type="button"
                size="xs"
                variant="outline"
                color="primary"
                :disabled="items.some(i => i.binding_id === problem.binding_id) || items.length >= 200"
                @click="add(problem)"
              >
                {{ items.some(i => i.binding_id === problem.binding_id) ? '已添加' : '添加' }}
              </UButton>
            </div>
            <div v-if="!problems.data.value?.items?.length" class="text-xs text-text-muted text-center py-4">
              未搜索到匹配题目
            </div>
          </div>

          <!-- 题目搜索分页 -->
          <div class="flex items-center justify-between text-xs text-text-muted px-1">
            <div class="flex items-center gap-2">
              <UButton type="button" variant="ghost" size="xs" color="neutral" :disabled="problemPage <= 1" @click="problemPage--">
                上一页
              </UButton>
              <span class="tabular-nums">第 {{ problemPage }} 页</span>
              <UButton type="button" variant="ghost" size="xs" color="neutral" :disabled="problemPage * 50 >= (problems.data.value?.total ?? 0)" @click="problemPage++">
                下一页
              </UButton>
            </div>
            <span class="tabular-nums">共 {{ problems.data.value?.total ?? 0 }} 道题</span>
          </div>

          <!-- 已添加题目列表 -->
          <div class="pt-2 border-t border-border space-y-2">
            <h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider">
              已选作业题目（{{ items.length }} / 200）
            </h3>

            <div
              v-for="(item, index) in items"
              :key="item.binding_id"
              class="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white dark:bg-bg-panel px-3.5 py-2.5 shadow-card"
            >
              <span class="w-6 text-xs text-text-muted tabular-nums font-mono">{{ index + 1 }}.</span>
              <span class="font-mono text-sm font-semibold text-primary mr-auto">{{ item.reference }}</span>

              <div class="flex items-center gap-2">
                <USelect
                  v-model="item.requirement"
                  :items="[{ label: '正式通过 (AC)', value: 'accepted' }, { label: '最低分', value: 'min_score' }]"
                  :aria-label="`${item.reference} 达标要求`"
                  class="w-36"
                />
                <UInput
                  v-if="item.requirement === 'min_score'"
                  v-model="item.score"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  class="w-20 tabular-nums"
                  :aria-label="`${item.reference} 最低分`"
                />
              </div>

              <div class="flex items-center gap-1">
                <UButton
                  type="button"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  icon="i-lucide-arrow-up"
                  :disabled="index === 0"
                  aria-label="上移题目"
                  @click="move(index, -1)"
                />
                <UButton
                  type="button"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  icon="i-lucide-arrow-down"
                  :disabled="index === items.length - 1"
                  aria-label="下移题目"
                  @click="move(index, 1)"
                />
                <UButton
                  type="button"
                  color="error"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-trash-2"
                  aria-label="移除题目"
                  @click="items.splice(index, 1)"
                />
              </div>
            </div>

            <div v-if="!items.length" class="rounded-lg border border-dashed border-border py-6 text-center text-xs text-text-muted">
              请从上方搜索题库或按题号添加到本作业
            </div>
          </div>
        </template>
      </div>
    </UCard>

    <!-- 底部操作底栏 -->
    <div class="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-lg border border-border bg-white dark:bg-bg-panel p-4 shadow-card">
      <div class="flex items-center gap-2 text-xs text-text-muted">
        <UIcon name="i-lucide-info" class="size-4 shrink-0 text-primary" />
        <span>先保存草稿，再预览并发布。发布后题目集合和达标要求固定，版本及成绩口径仍跟随本域题库。</span>
      </div>
      <UButton type="submit" color="primary" size="lg" :loading="saving" class="shrink-0">
        {{ initial ? '保存草稿修改' : '创建作业草稿' }}
      </UButton>
    </div>
  </form>
</template>
