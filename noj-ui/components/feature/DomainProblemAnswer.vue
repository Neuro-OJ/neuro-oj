<script setup lang="ts">
import { watch } from 'vue';
import type { DomainProblemDetail } from '~/utils/domain-problems';
import type { DomainSelfTest } from '~/composables/useDomainSelfTests';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
import type { UiFrameResult } from '~/utils/uiFrame';
import { extractApiError } from '~/utils/apiError';
import ProblemAnswerPanel, { type AnswerHandlers } from '~/components/problem/ProblemAnswerPanel.vue';

/**
 * 题库作答入口：把域题库 API 适配到共用作答面板。
 *
 * 面板负责作答 UI 与交互，本组件只负责「题库这一侧」的数据来源：使用域 API、
 * 题库有效版本、版本模板、代码自测与作业来源。比赛侧见 `DomainContestAnswer`，
 * 两者共用同一套作答 UI，避免字段与交互继续分叉。
 */
const props = defineProps<{
  slug: string;
  problem: DomainProblemDetail;
  assignmentOrigin?: AssignmentSubmissionOrigin;
}>();
const emit = defineEmits<{ refresh: [] }>();

const { isLoggedIn } = useAuth();
const { domain } = useWorkspace();
const scope = useWorkspaceActionScope();
const api = useDomainProblems();
const route = useRoute();

const panel = ref<InstanceType<typeof ProblemAnswerPanel> | null>(null);
const selfTestPanel = ref<{ run: () => Promise<void> } | null>(null);
const selfTestRecord = ref<DomainSelfTest | null>(null);
const uiResult = ref<UiFrameResult | null>(null);
const submissionId = ref('');

const isObjective = computed(() => props.problem.content.kind === 'objective');
const submissionMode = computed(() => props.problem.content.submission_mode ?? 'code');
const draftKey = computed(() => `${props.slug}:${props.problem.reference.problem_id}:${props.problem.version_id}`);
const guestKey = computed(() => `${props.slug}:guest:${props.problem.reference.problem_id}:${props.problem.version_id}`);
const writable = computed(() => isLoggedIn.value && domain.value?.status === 'active' && props.problem.can_practice !== false);

const handlers: AnswerHandlers = {
  submitCode: async (versionId, language, code) => {
    const operation = scope();
    const response = await api.code(
      operation.slug,
      props.problem.reference.display_ref,
      versionId,
      language,
      code,
      props.assignmentOrigin,
    );
    return { id: response.data.id };
  },
  submitFile: async (versionId, file) => {
    const operation = scope();
    const response = await api.artifact(
      operation.slug,
      props.problem.reference.display_ref,
      versionId,
      file,
      props.assignmentOrigin,
    );
    return { id: response.data.id };
  },
  submitObjective: async (versionId, answers) => {
    const operation = scope();
    const response = await api.objective(
      operation.slug,
      props.problem.reference.display_ref,
      versionId,
      answers,
      props.assignmentOrigin,
    );
    return response.data;
  },
  loadTemplate: async () => {
    const operation = scope();
    const response = await api.template(
      operation.slug,
      props.problem.reference.display_ref,
      props.problem.version_id,
    );
    return { version_id: response.data.version_id, content: response.data.template_content };
  },
};

const questions = computed(() =>
  (props.problem.content.questions ?? []).map((question) => ({
    key: question.key,
    type: question.type,
    prompt: question.prompt,
    options: question.options,
  }))
);

const isUi = computed(() => props.problem.content.submission_mode === 'ui');
/** 界面题 HTML 与客观题小题都由题库上下文读取，面板只负责渲染。 */
const uiFrame = useAsyncData(
  () => `${draftKey.value}:ui`,
  async () => {
    if (!isUi.value) return null;
    const operation = scope();
    const response = await api.ui(operation.slug, props.problem.reference.display_ref, props.problem.version_id);
    return response.data;
  },
);
const uiHtml = computed(() => (uiFrame.data.value as { html: string } | null)?.html ?? null);
const uiError = computed(() => uiFrame.error.value ? extractApiError(uiFrame.error.value).message : undefined);

async function runSelfTest() {
  await nextTick();
  await selfTestPanel.value?.run();
}

watch(uiResult, (value) => panel.value?.setUiResult(value));
watch(submissionId, (value) => panel.value?.setSubmissionId(value));
</script>

<template>
  <ProblemAnswerPanel
    ref="panel"
    context="library"
    :slug="slug"
    :is-objective="isObjective"
    :submission-mode="submissionMode"
    :supported-languages="problem.supported_languages ?? []"
    :artifact-max-size-mb="problem.content.artifact_max_size_mb ?? null"
    :version-id="problem.version_id"
    :version="problem.version"
    :questions="questions"
    :ui-html="uiHtml"
    :ui-error="uiError"
    :writable="writable"
    :draft-key="draftKey"
    :guest-key="guestKey"
    :login-redirect="route.fullPath"
    :handlers="handlers"
    @refresh="emit('refresh')"
    @ui-self-test="runSelfTest"
    @submitted="submissionId = $event"
  >
    <template #code-extras="{ code: currentCode, language: currentLanguage }">
      <DomainSelfTestPanel ref="selfTestPanel" :slug="slug" :problem="problem" :code="currentCode"
        :language="currentLanguage" :version-id="problem.version_id" :writable="writable"
        :assignment-origin="assignmentOrigin" @result="selfTestRecord = $event" @refresh="emit('refresh')" />
    </template>

    <template #ui-extras="{ code: currentCode }">
      <ClientOnly>
        <DomainSelfTestPanel ref="selfTestPanel" :slug="slug" :problem="problem" :code="currentCode" language="ui"
          :assignment-origin="assignmentOrigin" :version-id="problem.version_id" :writable="writable"
          @result="selfTestRecord = $event" @refresh="emit('refresh')" />
        <DomainUiRuns :slug="slug" :problem-id="problem.reference.problem_id"
          :reference="problem.reference.display_ref" :submission-id="submissionId" :self-test="selfTestRecord"
          :code="currentCode" :writable="writable" @restore="panel?.setCode($event)" @result="uiResult = $event" />
      </ClientOnly>
    </template>

    <template #submit-hint>
      <p class="text-xs text-text-muted">提交归属 {{ slug }}，来源题号 {{ problem.reference.display_ref }}。</p>
    </template>
  </ProblemAnswerPanel>
</template>
