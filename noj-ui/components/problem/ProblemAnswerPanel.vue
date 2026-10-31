<script setup lang="ts">
import type { SubmitResult } from '~/composables/useObjective';
import type { SubmissionMode } from '~/utils/problemView';
import { PREDICTION_FILE_ACCEPT, predictionHint } from '~/utils/problemView';
import { extractApiError } from '~/utils/apiError';
import { languageLabels } from '~/utils/submissionFormat';
import { parseValues, stableStringify, type UiFrameResult } from '~/utils/uiFrame';
import UiFrame from '~/components/uiproblem/UiFrame.vue';

/**
 * 统一的作答面板（题库与比赛共用）。
 *
 * 背景：题面展示在 #511 已经共用，但「作答」仍有两份实现（普通题库
 * `DomainProblemAnswer` 与比赛 `DomainContestAnswer`），字段、校验、提示与交互各自
 * 演化。本组件把作答 UI 收敛为一处，两个上下文只在**数据来源**与**门控**上分叉：
 *
 * - 题库：作答版本来自题库策略，可载入版本模板、可自测、支持游客草稿；
 * - 比赛：作答版本由比赛固定，受理窗口与报名关系决定能否提交，客观题一次交卷，
 *   且**不提供自测**（自测会把隐藏判定提前暴露给赛题）。
 *
 * 组件本身不感知具体 API：调用方注入 `handlers`。因此比赛仍然走独立提交入口
 * （`/domains/:slug/contests/:contestId/problems/:label/submissions`），
 * 不会退化成普通题库提交。
 */

/** 客观题小题；`key` 与 `id` 二选一（题库草稿用 key，比赛用稳定 id）。 */
export interface AnswerQuestion {
  id?: string;
  key?: string;
  type: 'single' | 'multiple' | 'judge';
  prompt: string;
  options: Array<{ key: string | boolean; text: string }>;
}

/** 提交与读取的具体实现，由调用方按上下文注入。 */
export interface AnswerHandlers {
  submitCode: (versionId: string, language: string, code: string) => Promise<{ id: string }>;
  submitFile: (versionId: string, file: File) => Promise<{ id: string }>;
  submitObjective: (versionId: string, answers: Record<string, (string | boolean)[]>) => Promise<SubmitResult>;
  loadTemplate: () => Promise<{ version_id: string; content: string | null }>;
}

interface AnswerTexts {
  title: string;
  template: string;
  templateConfirm: string;
  templateMissing: string;
  submit: string;
  objectiveSubmit: string;
  objectiveConfirm: string;
  objectiveConfirmTitle: string;
  versionChanged: string;
  versionSwitch: string;
  versionConfirm: string;
  submissionAccepted: string;
  submissionView: string;
  scorePending: string;
  scoreResult: (score: number) => string;
}

const props = withDefaults(defineProps<{
  /** `library`：题库详情；`contest`：比赛赛题。 */
  context: 'library' | 'contest';
  /** 当前使用域 slug（提交详情链接与登录跳转都用它，组件不自行解析 URL）。 */
  slug: string;
  isObjective: boolean;
  submissionMode: SubmissionMode;
  supportedLanguages?: string[];
  artifactMaxSizeMb?: number | null;
  /** 比赛固定版本 / 题库当前作答版本；提交必须原样回传。 */
  versionId: string;
  version: number;
  /** 客观题小题（由调用方按上下文读取）。 */
  questions?: AnswerQuestion[] | null;
  questionsError?: string;
  /** 界面题 HTML（由调用方按上下文读取）。 */
  uiHtml?: string | null;
  uiError?: string;
  /** 输入与提交是否可用（比赛为受理窗口 + 已报名）。 */
  writable: boolean;
  /** 比赛客观题是否已交卷（刷新页面后保持锁定）。 */
  objectiveSubmitted?: boolean;
  draftKey: string;
  guestKey?: string;
  /** 本地草稿是否要求登录：题库允许游客草稿（登录后认领），比赛要求登录。 */
  draftRequiresLogin?: boolean;
  /** 游客提示里的登录跳转目标（页面自己传 route.fullPath，组件不依赖路由）。 */
  loginRedirect?: string;
  handlers: AnswerHandlers;
  texts?: Partial<AnswerTexts>;
}>(), {
  supportedLanguages: () => [],
  artifactMaxSizeMb: null,
  questions: null,
  questionsError: undefined,
  uiHtml: null,
  uiError: undefined,
  objectiveSubmitted: false,
  guestKey: undefined,
  draftRequiresLogin: false,
  loginRedirect: '/',
  texts: () => ({}),
});

const emit = defineEmits<{ refresh: []; 'ui-self-test': []; submitted: [id: string] }>();

const labels = computed<AnswerTexts>(() => ({
  title: props.context === 'contest' ? '比赛作答' : '作答',
  template: props.context === 'contest' ? '载入比赛模板' : '载入版本模板',
  templateConfirm: props.context === 'contest' ? '用比赛固定版本模板替换当前代码？' : '用本版本模板替换当前代码？',
  templateMissing: props.context === 'contest' ? '此比赛版本没有模板，当前代码已保留' : '此版本没有代码模板，当前代码已保留',
  submit: props.context === 'contest' ? '提交比赛评测' : '提交评测',
  objectiveSubmit: props.context === 'contest' ? '一次正式交卷' : '交卷',
  objectiveConfirm: props.context === 'contest'
    ? '比赛客观题仅允许一次正式交卷。确认提交当前答案？'
    : '按当前作答提交这份客观题。',
  objectiveConfirmTitle: props.context === 'contest' ? '正式交卷' : '确认交卷',
  versionChanged: props.context === 'contest' ? '比赛固定版本已变化，当前输入保留' : '题库作答版本已变化，当前输入已保留',
  versionSwitch: props.context === 'contest' ? '确认新版本' : `切换到 V${props.version}`,
  versionConfirm: props.context === 'contest'
    ? '固定作答版本已变化，保留代码与答案后切换。请重新核对新题面。'
    : `将作答切换到 V${props.version}，保留当前代码和答案。请根据新题面重新确认。`,
  submissionAccepted: props.context === 'contest' ? '比赛提交已受理' : '',
  submissionView: props.context === 'contest' ? '查看允许公开的结果' : '查看评测',
  scorePending: props.context === 'contest' ? '正式交卷已受理，成绩暂未公开' : '已交卷，成绩暂未公开',
  scoreResult: (score: number) => props.context === 'contest' ? `本次原始总分：${score} 分` : `本次成绩：${score} 分`,
  ...props.texts,
}));

const { dialog } = useDialog();
const { user, isLoggedIn } = useAuth();
const loggedIn = computed(() => !!isLoggedIn?.value);
const scope = useWorkspaceActionScope();

const isPrediction = computed(() => props.submissionMode === 'prediction');
const isFile = computed(() => ['artifact', 'prediction'].includes(props.submissionMode));
const isUi = computed(() => props.submissionMode === 'ui');
const languages = computed(() => props.supportedLanguages ?? []);
const language = ref(isUi.value ? 'ui' : languages.value[0] ?? 'python3');

const version = ref(props.versionId);
const versionNumber = ref(props.version);
const changed = computed(() => version.value !== props.versionId);

const code = ref('');
const answers = ref<Record<string, (string | boolean)[]>>({});
const file = ref<File | null>(null);
const submitting = ref(false);
const failure = ref('');
const submissionId = ref('');
const result = ref<SubmitResult | null>(null);
const uiResult = ref<UiFrameResult | null>(null);
const loadingTemplate = ref(false);

const draft = useDomainAnswerDraft(
  computed(() => props.draftKey),
  code,
  answers,
  computed(() => !props.draftRequiresLogin || !!user.value),
  props.guestKey ? computed(() => props.guestKey!) : undefined,
);

// 面板不取数：小题与界面题 HTML 由调用方（题库/比赛适配层）按各自入口读取后传入。
const questions = computed<AnswerQuestion[]>(() => props.questions ?? []);
const uiValues = computed(() => parseValues(code.value));

/** 比赛客观题一次交卷后按钮必须真正不可用，避免赛题被反复提交。 */
const objectiveLocked = computed(() => props.context === 'contest' && (props.objectiveSubmitted || result.value !== null));
const canWrite = computed(() => props.writable && !objectiveLocked.value);
const canSubmit = computed(() => {
  if (!canWrite.value || submitting.value || changed.value) return false;
  if (props.isObjective) return questions.value.length > 0;
  if (isFile.value) return !!file.value;
  if (isUi.value) return !!code.value.trim();
  return !!code.value.trim() && languages.value.length > 0;
});

function questionKey(question: AnswerQuestion) {
  return question.key ?? question.id ?? '';
}
function questionLabel(type: AnswerQuestion['type']) {
  return { single: '单选', multiple: '多选', judge: '判断' }[type];
}
const questionOptions = (question: AnswerQuestion) =>
  question.type === 'judge'
    ? [{ key: true as const, text: '正确' }, { key: false as const, text: '错误' }]
    : question.options;
function optionLabel(option: { key: string | boolean; text: string }) {
  if (typeof option.key !== 'string') return option.text;
  return option.text.startsWith(`${option.key}.`) ? option.text : `${option.key}. ${option.text}`;
}

function toggle(question: AnswerQuestion, value: string | boolean) {
  const key = questionKey(question);
  const selected = answers.value[key] ?? [];
  answers.value[key] = question.type === 'multiple'
    ? selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]
    : [value];
}
function pickedFile(value: unknown) {
  file.value = value instanceof File ? value : null;
}
function setUiValues(value: Record<string, unknown>) {
  code.value = stableStringify(value);
}

/** 恢复登录前草稿前需确认，避免覆盖账号内已有输入。 */
async function restoreGuestDraft() {
  if (!await dialog.confirm('用登录前的草稿替换当前输入？', { title: '恢复登录前草稿' })) return;
  draft.restoreGuest();
}

/** 版本变化不清空输入：用户明确确认后才切换作答版本。 */
async function switchVersion() {
  if (!await dialog.confirm(labels.value.versionConfirm, {
    title: props.context === 'contest' ? '确认比赛版本' : '作答版本已变化',
  })) return;
  const savedCode = code.value;
  const savedAnswers = { ...answers.value };
  version.value = props.versionId;
  versionNumber.value = props.version;
  await nextTick();
  code.value = savedCode;
  answers.value = savedAnswers;
  draft.save();
  result.value = null;
  submissionId.value = '';
}

async function loadTemplate() {
  if (!canWrite.value || loadingTemplate.value || changed.value) return;
  if (code.value.trim() && !await dialog.confirm(labels.value.templateConfirm, { title: labels.value.template })) return;
  const operation = scope();
  loadingTemplate.value = true;
  failure.value = '';
  try {
    const response = await props.handlers.loadTemplate();
    if (!operation.isCurrent()) return;
    if (response.version_id !== version.value) {
      emit('refresh');
      return;
    }
    if (!response.content?.trim()) failure.value = labels.value.templateMissing;
    else code.value = response.content;
  } catch (error) {
    if (!operation.isCurrent()) return;
    failure.value = extractApiError(error).message;
    if (extractApiError(error).status === 409) emit('refresh');
  } finally {
    loadingTemplate.value = false;
  }
}

async function submit() {
  if (!canSubmit.value) return;
  if (props.isObjective && !await dialog.confirm(labels.value.objectiveConfirm, {
    title: labels.value.objectiveConfirmTitle,
  })) return;
  const operation = scope();
  submitting.value = true;
  failure.value = '';
  try {
    if (props.isObjective) {
      const response = await props.handlers.submitObjective(version.value, answers.value);
      if (operation.isCurrent()) result.value = response;
    } else {
      const response = isFile.value
        ? await props.handlers.submitFile(version.value, file.value!)
        : await props.handlers.submitCode(version.value, language.value, code.value);
      if (operation.isCurrent()) {
        submissionId.value = response.id;
        emit('submitted', response.id);
      }
    }
  } catch (error) {
    if (!operation.isCurrent()) return;
    failure.value = extractApiError(error).message;
    if (extractApiError(error).status === 409) emit('refresh');
  } finally {
    if (operation.isCurrent()) submitting.value = false;
  }
}

defineExpose({
  setUiResult: (value: UiFrameResult | null) => {
    uiResult.value = value;
  },
  setSubmissionId: (value: string) => {
    submissionId.value = value;
  },
  /** 界面题运行记录回滚时外部需要写回参数。 */
  setCode: (value: string) => {
    code.value = value;
  },
});
</script>

<template>
  <UCard class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h3 class="font-semibold">
          {{ labels.title }}
          <span class="text-sm font-normal tabular-nums text-text-muted">V{{ versionNumber }}</span>
        </h3>
      </div>
      <div class="flex items-center gap-2">
        <slot name="header-actions" />
        <UButton v-if="context === 'library'" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" @click="emit('refresh')">
          检查版本
        </UButton>
      </div>
    </div>

    <UAlert v-if="context === 'contest' && !writable" color="info" title="仅在比赛受理时间内且已报名时可提交" />
    <UAlert v-if="changed" color="warning" :title="labels.versionChanged">
      <template #actions>
        <UButton @click="switchVersion">{{ labels.versionSwitch }}</UButton>
      </template>
    </UAlert>
    <UAlert v-if="draft?.state?.value === 'error'" color="warning" title="无法保存本地草稿，请先复制代码或答案" />
    <UAlert v-if="context === 'library' && !loggedIn" color="info" title="登录后提交作答，当前代码会保留在此设备">
      <template #actions>
        <UButton :to="{ path: '/login', query: { redirect: loginRedirect } }">登录并继续作答</UButton>
      </template>
    </UAlert>
    <UAlert v-if="context === 'library' && draft?.guestAvailable?.value" color="info"
      title="发现登录前的本题草稿，你的账号草稿仍保留">
      <template #actions>
        <UButton variant="outline" @click="restoreGuestDraft">恢复登录前草稿</UButton>
      </template>
    </UAlert>
    <slot name="notices" />

    <template v-if="isObjective">
      <UAlert v-if="questionsError" color="error" :title="questionsError" />
      <div v-for="(question, index) in questions" :key="questionKey(question)"
        class="mb-5 border-b border-border pb-5 last:mb-0 last:border-b-0 last:pb-0">
        <p class="mb-2 text-xs text-text-muted">第 {{ index + 1 }} 题 · {{ questionLabel(question.type) }}</p>
        <MarkdownRenderer :content="question.prompt" />
        <div class="mt-3 flex flex-col gap-2">
          <UCheckbox v-for="option in questionOptions(question)" :key="String(option.key)" :label="optionLabel(option)"
            :model-value="(answers[questionKey(question)] ?? []).includes(option.key)" :disabled="!canWrite || submitting"
            @update:model-value="toggle(question, option.key)" />
        </div>
      </div>
      <p v-if="context === 'contest'" class="text-xs text-text-muted">一次正式交卷；赛中不返回标准答案和逐题正确性。</p>
    </template>

    <template v-else-if="isFile">
      <p v-if="isPrediction" class="mb-3 text-sm text-text-secondary">{{ predictionHint() }}</p>
      <p class="mb-3 text-sm text-text-secondary">
        {{ isPrediction ? '上传单个预测结果文件' : '上传产物 ZIP' }}<template v-if="artifactMaxSizeMb">，最大 {{ artifactMaxSizeMb }} MiB</template>。
      </p>
      <UFileUpload :model-value="file" :accept="isPrediction ? PREDICTION_FILE_ACCEPT : '.zip'"
        :label="isPrediction ? '选择预测结果文件' : '选择产物文件'" :disabled="!canWrite || submitting"
        @update:model-value="pickedFile" />
      <p v-if="file" class="mt-2 break-all text-sm text-text-secondary">已选择：{{ file.name }}</p>
    </template>

    <template v-else-if="isUi">
      <UAlert v-if="uiError" color="error" :title="uiError" />
      <UiFrame v-if="uiHtml" :html="uiHtml" :values="uiValues"
        :result="uiResult" :title="`V${versionNumber}`" :disabled="!canWrite || submitting" class="h-[560px] w-full"
        @update:values="setUiValues" @submit="submit" @self-test="emit('ui-self-test')" />
      <slot name="ui-extras" :code="code" />
    </template>

    <template v-else>
      <div class="mb-3 flex flex-wrap gap-3">
        <USelect v-model="language" :items="languages.map(value => ({ value, label: languageLabels[value] ?? value }))"
          aria-label="提交语言" class="min-w-40" :disabled="submitting || changed" />
        <UButton variant="outline" :loading="loadingTemplate" :disabled="!canWrite || submitting || changed"
          @click="loadTemplate">{{ labels.template }}</UButton>
      </div>
      <UAlert v-if="languages.length === 0" color="warning" title="题目尚未提供可提交语言，请联系管理员" class="mb-3" />
      <ClientOnly>
        <MonacoEditor v-model="code" :language="language" :min-height="360" :disabled="submitting" />
        <slot name="code-extras" :code="code" :language="language" />
      </ClientOnly>
    </template>

    <UAlert v-if="failure" color="error" :title="failure" class="mt-4" />
    <UAlert v-if="submissionId" color="success"
      :title="labels.submissionAccepted || `已受理提交：${submissionId}`" class="mt-4">
      <template #actions>
        <UButton :to="`/d/${slug}/submissions/${submissionId}`">{{ labels.submissionView }}</UButton>
      </template>
    </UAlert>
    <UAlert v-if="result" color="success"
      :title="result.score === null || result.score === undefined ? labels.scorePending : labels.scoreResult(result.score)"
      class="mt-4" />
    <UAlert v-else-if="objectiveLocked" color="info" title="本题已完成一次正式交卷，不可重复提交" class="mt-4" />
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <UButton :loading="submitting" :disabled="!canSubmit" @click="submit">
        {{ isObjective ? labels.objectiveSubmit : labels.submit }}
      </UButton>
      <slot name="submit-hint" />
    </div>
  </UCard>
</template>
