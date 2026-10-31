<script setup lang="ts">
import { watch } from 'vue';
import type { ContestProblem } from '~/utils/contest-types';
import type { UiFrameResult } from '~/utils/uiFrame';
import ProblemAnswerPanel, { type AnswerHandlers, type AnswerQuestion } from '~/components/problem/ProblemAnswerPanel.vue';
import { extractApiError } from '~/utils/apiError';

/**
 * 比赛作答入口：把比赛独立提交入口适配到共用作答面板。
 *
 * 与题库共用同一套作答 UI，但保留比赛侧的全部不变量：
 * - 提交只走 `/domains/:slug/contests/:contestId/problems/:label/submissions`
 *   （`useDomainContestAnswers`），不进入普通题库提交；
 * - 作答版本是**比赛固定版本**，提交原样回传，不用题库策略或最新版本覆盖；
 * - 受理窗口与报名关系决定是否可提交（`active`），客观题一次交卷后锁定；
 * - 不加载 `DomainSelfTestPanel`：自测会把隐藏判定提前暴露给赛题。
 */
const props = defineProps<{
  slug: string;
  contestId: string;
  /** 比赛题（`version_id` 为比赛固定版本）。 */
  problem: ContestProblem & { version_id: string };
  /** 受理窗口内且已报名。 */
  active: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();

const { user } = useAuth();
const scope = useWorkspaceActionScope();
const api = useDomainContestAnswers();

const panel = ref<InstanceType<typeof ProblemAnswerPanel> | null>(null);
const uiResult = ref<UiFrameResult | null>(null);
const submissionId = ref('');

const isObjective = computed(() => props.problem.is_objective === true);
const submissionMode = computed(() => props.problem.submission_mode ?? 'code');
const draftKey = computed(() => `${props.slug}:contest:${props.contestId}:${props.problem.problem_id}:${props.problem.version_id}`);
const versionId = computed(() => props.problem.version_id);
const version = computed(() => props.problem.version ?? 1);

const handlers: AnswerHandlers = {
  submitCode: async (version, language, code) => {
    const operation = scope();
    const response = await api.code(operation.slug, props.contestId, props.problem.label, version, language, code);
    return { id: response.data.id };
  },
  submitFile: async (version, file) => {
    const operation = scope();
    const response = await api.artifact(operation.slug, props.contestId, props.problem.label, version, file);
    return { id: response.data.id };
  },
  submitObjective: async (version, answers) => {
    const operation = scope();
    const response = await api.objective(operation.slug, props.contestId, props.problem.label, version, answers);
    return response.data;
  },
  loadTemplate: async () => {
    const operation = scope();
    const response = await api.template(operation.slug, props.contestId, props.problem.label);
    return { version_id: response.version_id, content: response.data.content };
  },
};

const isUi = computed(() => submissionMode.value === 'ui');
/** 界面题 HTML 与客观题小题走比赛固定版本入口，由本组件读取后交给面板渲染。 */
const uiFrame = await useAsyncData(
  () => `${draftKey.value}:ui`,
  async () => {
    if (!isUi.value) return null;
    const operation = scope();
    const response = await api.ui(operation.slug, props.contestId, props.problem.label);
    return response.data;
  },
);
const uiHtml = computed(() => (uiFrame.data.value as { html: string } | null)?.html ?? null);
const uiError = computed(() => uiFrame.error.value ? extractApiError(uiFrame.error.value).message : undefined);

const questionSet = await useAsyncData(
  () => `${draftKey.value}:questions`,
  async () => {
    if (!isObjective.value) return null;
    const operation = scope();
    const response = await api.questions(operation.slug, props.contestId, props.problem.label);
    return response.data.map((question) => ({
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      options: question.options,
    }));
  },
);
const questions = computed(() => (questionSet.data.value as AnswerQuestion[] | null) ?? null);
const questionsError = computed(() => questionSet.error.value ? extractApiError(questionSet.error.value).message : undefined);

watch(uiResult, (value) => panel.value?.setUiResult(value));
watch(submissionId, (value) => panel.value?.setSubmissionId(value));
</script>

<template>
  <ProblemAnswerPanel
    ref="panel"
    context="contest"
    :slug="slug"
    :is-objective="isObjective"
    :submission-mode="submissionMode"
    :supported-languages="problem.supported_languages ?? []"
    :artifact-max-size-mb="problem.artifact_max_size_mb ?? null"
    :version-id="versionId"
    :version="version"
    :questions="questions"
    :questions-error="questionsError"
    :ui-html="uiHtml"
    :ui-error="uiError"
    :writable="active && !!user"
    :objective-submitted="isObjective && !!problem.user_status && problem.user_status !== 'untouched'"
    :draft-key="draftKey"
    :draft-requires-login="true"
    :handlers="handlers"
    @refresh="emit('refresh')"
    @submitted="submissionId = $event"
  >
    <template #ui-extras="{ code: currentCode }">
      <ClientOnly>
        <DomainUiRuns :slug="slug" :problem-id="problem.problem_id"
          :reference="problem.reference?.display_ref ?? problem.display_id" :contest-id="contestId"
          :submission-id="submissionId" :self-test="null" :code="currentCode"
          :writable="active && !!user" @restore="panel?.setCode($event)" @result="uiResult = $event" />
      </ClientOnly>
    </template>
    <template #submit-hint>
      <p class="text-xs text-text-muted">比赛提交只计入本场比赛，不影响题库成绩。</p>
    </template>
  </ProblemAnswerPanel>
</template>
