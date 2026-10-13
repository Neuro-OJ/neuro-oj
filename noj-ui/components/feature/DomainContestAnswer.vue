<script setup lang="ts">
import type { ContestProblem } from '~/composables/useContests';
import type { SubmitResult } from '~/composables/useObjective';
import { domainAnswerKey } from '~/utils/domain-problems';
import { extractApiError } from '~/utils/apiError';
import UiFrame from '~/components/uiproblem/UiFrame.vue';
import { parseValues, stableStringify, type UiFrameResult } from '~/utils/uiFrame';
import { PREDICTION_FILE_ACCEPT } from '~/utils/problemView';
const props = defineProps<
  { slug: string; contestId: string; problem: ContestProblem & { version_id: string }; active: boolean }
>();
const emit = defineEmits<{ refresh: [] }>();
const api = useDomainContestAnswers(),
  scope = useWorkspaceActionScope(),
  { dialog } = useDialog(),
  { user } = useAuth();
const version = ref(props.problem.version_id), versionNumber = ref(props.problem.version);
const code = ref(''), answers = ref<Record<string, (string | boolean)[]>>({}), file = ref<File | null>(null);
const isUi = computed(() => props.problem.submission_mode === 'ui');
const isPrediction = computed(() => props.problem.submission_mode === 'prediction');
const isFile = computed(() => ['artifact', 'prediction'].includes(props.problem.submission_mode ?? ''));
const language = ref(isUi.value ? 'ui' : props.problem.supported_languages?.[0] ?? 'python3');
const submitting = ref(false), templateLoading = ref(false), failure = ref(''), submissionId = ref('');
const result = ref<SubmitResult | null>(null);
const uiResult = ref<UiFrameResult | null>(null);
const changed = computed(() => version.value !== props.problem.version_id);
const writable = computed(() =>
  props.active && !changed.value && !submitting.value && (!props.problem.is_objective || !result.value)
);
const key = computed(() =>
  domainAnswerKey(
    user.value?.id ?? '',
    props.slug,
    `contest:${props.contestId}:${props.problem.problem_id}`,
    version.value,
    language.value,
  )
);
const enabled = computed(() => !!user.value);
const draft = useDomainAnswerDraft(key, code, answers, enabled);
const uiValues = computed(() => parseValues(code.value));
const ui = await useAsyncData(
  () => `${key.value}:ui`,
  () => isUi.value ? api.ui(props.slug, props.contestId, props.problem.label) : Promise.resolve(null),
);
const questions = await useAsyncData(
  () => `${key.value}:questions`,
  () =>
    props.problem.is_objective
      ? api.questions(props.slug, props.contestId, props.problem.label)
      : Promise.resolve(null),
);
async function changeVersion() {
  if (
    !await dialog.confirm('固定作答版本已变化，保留代码与答案后切换。请重新核对新题面。', { title: '确认比赛版本' })
  ) return;
  const saved = code.value, savedAnswers = { ...answers.value };
  version.value = props.problem.version_id;
  versionNumber.value = props.problem.version;
  await nextTick();
  code.value = saved;
  answers.value = savedAnswers;
  draft.save();
}
function option(id: string, value: string | boolean, multiple: boolean) {
  const current = answers.value[id] ?? [];
  answers.value[id] = multiple
    ? current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    : [value];
}
function pickedFile(value: unknown) {
  file.value = value instanceof File ? value : null;
}
async function template() {
  if (templateLoading.value || !writable.value) return;
  if (code.value.trim() && !await dialog.confirm('用比赛固定版本模板替换当前代码？', { title: '载入比赛模板' })) return;
  const operation = scope();
  templateLoading.value = true;
  try {
    const response = await api.template(operation.slug, props.contestId, props.problem.label);
    if (!operation.isCurrent()) return;
    if (response.version_id !== version.value) {
      emit('refresh');
      return;
    }
    if (response.data.content == null) failure.value = '此比赛版本没有模板';
    else code.value = response.data.content;
  } catch (error) {
    if (operation.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (operation.isCurrent()) templateLoading.value = false;
  }
}
async function submit() {
  if (!writable.value) return;
  const operation = scope(), contest = props.contestId, label = props.problem.label;
  if (
    props.problem.is_objective &&
    !await dialog.confirm('比赛客观题仅允许一次正式交卷。确认提交当前答案？', { title: '正式交卷' })
  ) return;
  if (!operation.isCurrent()) return;
  submitting.value = true;
  failure.value = '';
  try {
    if (props.problem.is_objective) {
      const response = await api.objective(operation.slug, contest, label, version.value, answers.value);
      if (operation.isCurrent()) result.value = response.data;
    } else {
      const response = isFile.value
        ? await api.artifact(operation.slug, contest, label, version.value, file.value!)
        : await api.code(operation.slug, contest, label, version.value, language.value, code.value);
      if (operation.isCurrent()) submissionId.value = response.data.id;
    }
  } catch (error) {
    if (operation.isCurrent()) {
      failure.value = extractApiError(error).message;
      if (extractApiError(error).status === 409) emit('refresh');
    }
  } finally {
    if (operation.isCurrent()) submitting.value = false;
  }
}
</script>
<template>
  <UCard class="space-y-4">
    <h3 class="font-semibold">比赛作答 · V{{ versionNumber }}</h3>
    <UAlert v-if="!active" color="info" title="仅在比赛受理时间内且已报名时可提交" />
    <UAlert v-if="changed" color="warning" title="比赛固定版本已变化，当前输入保留">
      <template #actions>
        <UButton @click="changeVersion">确认新版本</UButton>
      </template>
    </UAlert>
    <template v-if="problem.is_objective">
      <UAlert v-if="questions.error.value" color="error" :title="extractApiError(questions.error.value).message" />
      <div v-for="(question, index) in questions.data.value?.data" :key="question.id"
        class="border-b border-border py-4">
        <p
          class="mb-2 text-xs text-text-muted">第 {{ index + 1 }} 题 · {{ { single: '单选', multiple: '多选', judge: '判断' }[question.type] }}</p>
        <MarkdownRenderer :content="question.prompt" />
        <div class="mt-3 flex flex-col gap-2">
          <UCheckbox
            v-for="item in question.type === 'judge' ? [{ key: true, text: '正确' }, { key: false, text: '错误' }] : question.options"
            :key="String(item.key)" :label="item.text" :model-value="(answers[question.id] ?? []).includes(item.key)"
            :disabled="!writable" @update:model-value="option(question.id, item.key, question.type === 'multiple')" />
        </div>
      </div>
      <p class="text-xs text-text-muted">一次正式交卷；赛中不返回标准答案和逐题正确性。</p>
    </template>
    <UFileUpload v-else-if="isFile" :model-value="file" :accept="isPrediction ? PREDICTION_FILE_ACCEPT : '.zip'"
      :label="isPrediction ? '比赛预测结果文件' : '比赛产物 ZIP'" :disabled="!writable"
      @update:model-value="pickedFile" />
    <template v-else-if="isUi">
      <UAlert v-if="ui.error.value" color="error" :title="extractApiError(ui.error.value).message" />
      <UiFrame v-if="ui.data.value" :html="ui.data.value.data.html" :values="uiValues" :result="uiResult" :title="problem.title"
        :disabled="!writable" class="h-[560px] w-full"
        @update:values="value => code = stableStringify(value)" @submit="submit" />
      <ClientOnly>
        <DomainUiRuns :slug="slug" :problem-id="problem.problem_id" :reference="problem.reference!.display_ref"
          :contest-id="contestId" :submission-id="submissionId" :self-test="null" :code="code" :writable="writable"
          @restore="code = $event" @result="uiResult = $event" />
      </ClientOnly>
    </template>
    <template v-else>
      <div class="flex gap-3">
        <USelect v-model="language" :items="problem.supported_languages ?? ['python3']" aria-label="比赛提交语言"
          :disabled="!writable" />
        <UButton variant="outline" :disabled="!writable" :loading="templateLoading"
          @click="template">载入比赛模板</UButton>
      </div>
      <ClientOnly>
        <MonacoEditor v-model="code" :language="language" :min-height="360" :disabled="submitting" />
      </ClientOnly>
    </template>
    <UAlert v-if="failure" color="error" :title="failure" />
    <UAlert v-if="submissionId" color="success" title="比赛提交已受理">
      <template #actions>
        <UButton :to="`/d/${slug}/submissions/${submissionId}`">查看允许公开的结果</UButton>
      </template>
    </UAlert>
    <UAlert v-if="result" color="success"
      :title="result.score == null ? '正式交卷已受理，成绩暂未公开' : `本次原始总分：${result.score} 分`" />
    <UButton :loading="submitting"
      :disabled="!writable || (problem.is_objective ? !questions.data.value : isFile ? !file : !code.trim())"
      @click="submit">{{ problem.is_objective ? '一次正式交卷' : '提交比赛评测' }}</UButton>
  </UCard>
</template>
