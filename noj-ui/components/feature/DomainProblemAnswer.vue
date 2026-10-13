<script setup lang="ts">
import type { DomainProblemDetail } from '~/utils/domain-problems';
import { domainAnswerKey } from '~/utils/domain-problems';
import { extractApiError } from '~/utils/apiError';
import type { SubmitResult } from '~/composables/useObjective';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
import UiFrame from '~/components/uiproblem/UiFrame.vue';
import { parseValues, stableStringify, type UiFrameResult } from '~/utils/uiFrame';
import type { DomainSelfTest } from '~/composables/useDomainSelfTests';
import { PREDICTION_FILE_ACCEPT, predictionHint } from '~/utils/problemView';
const props = defineProps<{ slug: string; problem: DomainProblemDetail; assignmentOrigin?: AssignmentSubmissionOrigin }>();
const emit = defineEmits<{ refresh: [] }>();
const { user, isLoggedIn } = useAuth();
const { domain } = useWorkspace();
const scope = useWorkspaceActionScope();
const api = useDomainProblems();
const { dialog } = useDialog();
const code = ref('');
const isUi = computed(() => props.problem.content.submission_mode === 'ui');
const isPrediction = computed(() => props.problem.content.submission_mode === 'prediction');
const isFile = computed(() => ['artifact', 'prediction'].includes(props.problem.content.submission_mode ?? ''));
const language = ref(isUi.value ? 'ui' : props.problem.supported_languages?.[0] ?? 'python3');
const answerVersion = ref(props.problem.version_id);
const answerVersionNumber = ref(props.problem.version);
const file = ref<File | null>(null);
const answers = ref<Record<string, (string | boolean)[]>>({});
const result = ref<SubmitResult | null>(null);
const submissionId = ref('');
const submitting = ref(false);
const failure = ref('');
const loadingTemplate = ref(false);
const changed = computed(() => answerVersion.value !== props.problem.version_id);
const languages = computed(() =>
  props.problem.supported_languages ?? (props.problem.content.kind === 'oi' ? [] : ['python3'])
);
const writable = computed(() => isLoggedIn.value && domain.value?.status === 'active' && !changed.value);
const key = computed(() =>
  domainAnswerKey(
    user.value?.id ?? 'anonymous',
    props.slug,
    props.problem.reference.problem_id,
    answerVersion.value,
    language.value,
  )
);
const enabled = computed(() => isLoggedIn.value);
const draft = useDomainAnswerDraft(key, code, answers, enabled);
const uiSelfTest = ref<{ run: () => Promise<void> } | null>(null);
const uiResult = ref<UiFrameResult | null>(null), uiSelfTestRecord = ref<DomainSelfTest | null>(null);
async function runUiSelfTest() {
  await nextTick();
  await uiSelfTest.value?.run();
}
const uiValues = computed(() => parseValues(code.value));
const ui = useAsyncData(
  () => `${key.value}:ui`,
  () => isUi.value ? api.ui(props.slug, props.problem.reference.display_ref, answerVersion.value) : Promise.resolve(null),
);

async function loadTemplate() {
  if (loadingTemplate.value || changed.value) return;
  if (code.value.trim() && !await dialog.confirm('用本版本模板替换当前代码？', { title: '载入模板' })) return;
  const operation = scope();
  const version = answerVersion.value;
  loadingTemplate.value = true;
  failure.value = '';
  try {
    const response = await api.template(operation.slug, props.problem.reference.display_ref, version);
    if (operation.isCurrent() && answerVersion.value === version) {
      if (response.data.template_content == null) failure.value = '此版本没有代码模板';
      else code.value = response.data.template_content;
    }
  } catch (error) {
    if (operation.isCurrent()) {
      failure.value = extractApiError(error).message;
      if (extractApiError(error).status === 409) emit('refresh');
    }
  } finally {
    if (operation.isCurrent()) loadingTemplate.value = false;
  }
}

// 策略变动不清空已输入代码；学生明确确认后才切换作答版本。
async function changeVersion() {
  if (
    !await dialog.confirm(
      `将作答切换到 V${props.problem.version}，保留当前代码和答案。请根据新题面重新确认。`,
      { title: '作答版本已变化' },
    )
  ) return;
  const saved = code.value;
  const savedAnswers = { ...answers.value };
  answerVersion.value = props.problem.version_id;
  answerVersionNumber.value = props.problem.version;
  await nextTick();
  code.value = saved;
  answers.value = savedAnswers;
  draft.save();
  result.value = null;
  submissionId.value = '';
}
function setOption(question: string, option: string | boolean, multiple: boolean) {
  const selected = answers.value[question] ?? [];
  answers.value[question] = multiple
    ? selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option]
    : [option];
}
function pickedFile(value: unknown) {
  file.value = value instanceof File ? value : null;
}
async function submit() {
  if (!writable.value || submitting.value) return;
  const operation = scope();
  if (
    props.problem.content.kind === 'objective' &&
    !await dialog.confirm('按当前作答提交这份客观题。', { title: '确认交卷' })
  ) {
    return;
  }
  if (!operation.isCurrent()) return;
  submitting.value = true;
  failure.value = '';
  try {
    const reference = props.problem.reference.display_ref;
    if (props.problem.content.kind === 'objective') {
      const response = await api.objective(operation.slug, reference, answerVersion.value, answers.value, props.assignmentOrigin);
      if (operation.isCurrent()) result.value = response.data;
    } else {
      const response = isFile.value
        ? await api.artifact(operation.slug, reference, answerVersion.value, file.value!, props.assignmentOrigin)
        : await api.code(operation.slug, reference, answerVersion.value, language.value, code.value, props.assignmentOrigin);
      if (operation.isCurrent()) submissionId.value = response.data.id;
    }
  } catch (error) {
    if (!operation.isCurrent()) return;
    failure.value = extractApiError(error).message;
    if (extractApiError(error).status === 409) emit('refresh');
  } finally {
    if (operation.isCurrent()) submitting.value = false;
  }
}
</script>
<template>
  <UCard>
    <div class="mb-4 flex items-center justify-between gap-3">
      <h3
        class="font-semibold">作答 <span class="text-sm font-normal tabular-nums text-text-muted">V{{ answerVersionNumber }}</span></h3>
      <UButton variant="ghost" color="neutral" icon="i-lucide-refresh-cw" @click="emit('refresh')">检查版本</UButton>
    </div>
    <UAlert v-if="changed" color="warning" title="题库作答版本已变化，当前输入已保留" class="mb-4">
      <template #actions>
        <UButton @click="changeVersion">切换到 V{{ problem.version }}</UButton>
      </template>
    </UAlert>
    <UAlert v-if="!isLoggedIn" title="登录后提交作答" color="info" class="mb-4" />
    <template v-if="problem.content.kind === 'objective'">
      <div v-for="(question, index) in problem.content.questions" :key="question.key"
        class="mb-5 border-b border-border pb-5">
        <p
          class="mb-2 text-xs text-text-muted">第 {{ index + 1 }} 题 · {{ { single: '单选', multiple: '多选', judge: '判断' }[question.type] }}</p>
        <MarkdownRenderer :content="question.prompt" />
        <div class="mt-3 flex flex-col gap-2">
          <UCheckbox
            v-for="option in question.type === 'judge' ? [{ key: true, text: '正确' }, { key: false, text: '错误' }] : question.options"
            :key="String(option.key)"
            :label="option.text" :model-value="(answers[question.key] ?? []).includes(option.key)"
            :disabled="!writable || submitting"
            @update:model-value="setOption(question.key, option.key, question.type === 'multiple')" />
        </div>
      </div>
    </template>
    <template v-else-if="isFile">
      <p v-if="isPrediction" class="mb-3 text-sm text-text-secondary">{{ predictionHint() }}</p>
      <p
        class="mb-3 text-sm text-text-secondary">{{ isPrediction ? '上传单个预测结果文件' : '上传产物 ZIP' }}{{ problem.content.artifact_max_size_mb ? `，最大 ${problem.content.artifact_max_size_mb} MiB` : '' }}。</p>
      <UFileUpload :model-value="file" :accept="isPrediction ? PREDICTION_FILE_ACCEPT : '.zip'" :label="isPrediction ? '选择预测结果文件' : '选择产物文件'" :disabled="!writable || submitting"
        @update:model-value="pickedFile" />
    </template>
    <template v-else-if="isUi">
      <UAlert v-if="ui.error.value" color="error" :title="extractApiError(ui.error.value).message" />
      <UiFrame v-if="ui.data.value" :html="ui.data.value.data.html" :values="uiValues" :result="uiResult" :title="problem.content.title"
        :disabled="!writable || submitting" class="h-[560px] w-full"
        @update:values="value => code = stableStringify(value)" @submit="submit" @self-test="runUiSelfTest" />
      <ClientOnly>
        <DomainSelfTestPanel ref="uiSelfTest" :slug="slug" :problem="problem" :code="code" language="ui"
          :assignment-origin="assignmentOrigin" :version-id="answerVersion" :writable="writable && !submitting"
          @result="uiSelfTestRecord = $event"
          @refresh="emit('refresh')" />
        <DomainUiRuns :slug="slug" :problem-id="problem.reference.problem_id" :reference="problem.reference.display_ref"
          :submission-id="submissionId" :self-test="uiSelfTestRecord" :code="code" :writable="writable && !submitting"
          @restore="code = $event" @result="uiResult = $event" />
      </ClientOnly>
    </template>
    <template v-else>
      <div class="mb-3 flex flex-wrap gap-3">
        <USelect v-model="language" :items="languages" aria-label="提交语言" class="min-w-40"
          :disabled="submitting || changed" />
        <UButton variant="outline" :loading="loadingTemplate" :disabled="submitting || changed"
          @click="loadTemplate">载入版本模板</UButton>
      </div>
      <UAlert v-if="languages.length === 0" color="warning" title="题目尚未提供可提交语言，请联系管理员" class="mb-3" />
      <ClientOnly>
        <MonacoEditor v-model="code" :language="language" :min-height="360" :disabled="submitting" />
        <DomainSelfTestPanel :slug="slug" :problem="problem" :code="code" :language="language"
          :assignment-origin="assignmentOrigin"
          :version-id="answerVersion" :writable="writable && !submitting && languages.length > 0"
          @refresh="emit('refresh')" />
      </ClientOnly>
    </template>
    <UAlert v-if="failure" color="error" :title="failure" class="mt-4" />
    <UAlert v-if="submissionId" color="success" :title="`已受理提交：${submissionId}`" class="mt-4">
      <template #actions>
        <UButton :to="`/d/${slug}/submissions/${submissionId}`">查看评测</UButton>
      </template>
    </UAlert>
    <UAlert v-if="result" color="success"
      :title="result.score === null ? '已交卷，成绩暂未公开' : `本次成绩：${result.score} 分`" class="mt-4" />
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <UButton :loading="submitting"
        :disabled="!writable || (problem.content.kind !== 'objective' && (isFile ? !file : !code.trim() || !isUi && !languages.length))"
        @click="submit">
        {{ problem.content.kind === 'objective' ? '交卷' : '提交评测' }}
      </UButton>
      <p class="text-xs text-text-muted">提交归属 {{ slug }}，来源题号 {{ problem.reference.display_ref }}。</p>
    </div>
  </UCard>
</template>
