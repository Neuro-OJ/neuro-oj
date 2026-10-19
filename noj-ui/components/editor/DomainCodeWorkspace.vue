<script setup lang="ts">
import type { DomainCodeProblem } from '~/utils/domain-problems';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
import { domainAnswerKey } from '~/utils/domain-problems';
import { workspaceCacheKey } from '~/utils/workspace';
import { getEditorLanguages } from '~/utils/editorLanguages';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{
  slug: string;
  problem: DomainCodeProblem;
  backUrl: string;
  assignmentOrigin?: AssignmentSubmissionOrigin;
  contest?: { id: string; label: string; title: string; active: boolean };
}>();
const emit = defineEmits<{ refresh: [] }>();
const { user, isLoggedIn } = useAuth(), { domain } = useWorkspace(), capture = useWorkspaceActionScope();
const api = useDomainProblems(), contestApi = useDomainContestAnswers(), submissionsApi = useDomainSubmissions();
const { dialog } = useDialog();
const route = useRoute();
const { theme, set: setTheme } = useEditorTheme();
const code = ref(''), answers = ref<Record<string, (string | boolean)[]>>({}), draftEnabled = ref(true);
const version = ref(props.problem.version_id), versionNumber = ref(props.problem.version);
const languages = computed(() =>
  getEditorLanguages({
    judge_type: props.problem.content.kind === 'oi' ? 'oi' : 'dual',
    supported_languages: props.problem.supported_languages,
  })
);
const language = ref(languages.value[0]?.value ?? '');
const changed = computed(() => version.value !== props.problem.version_id);
const writable = computed(() =>
  isLoggedIn.value && domain.value?.status === 'active' && !changed.value && (!props.contest || props.contest.active)
);
const draftProblem = computed(() =>
  props.contest
    ? `contest:${props.contest.id}:${props.problem.reference.problem_id}`
    : props.problem.reference.problem_id
);
const key = computed(() =>
  domainAnswerKey(user.value?.id ?? 'anonymous', props.slug, draftProblem.value, version.value, language.value)
);
const guestKey = computed(() =>
  domainAnswerKey('anonymous', props.slug, draftProblem.value, version.value, language.value)
);
const draft = useDomainAnswerDraft(key, code, answers, draftEnabled, guestKey);
useUnsavedChanges(() => !!code.value.trim() && (!draftEnabled.value || draft.state.value === 'error'));
const tab = ref<'description' | 'history' | 'settings' | 'self-test'>('description');
const sidebarVisible = ref(true);
onMounted(() => {
  sidebarVisible.value = window.matchMedia('(min-width:640px)').matches;
});
const { width: sidebarWidth } = useResizableSplitter('editor:sidebar:width', 320, 240, 480);
const cursor = ref({ line: 1, col: 1 });
const submitting = ref(false), templateLoading = ref(false), failure = ref('');
const selfTestPanel = ref<{ run: () => Promise<void> } | null>(null);
const sidebarProblem = computed(() => ({
  id: props.problem.reference.problem_id,
  display_id: props.problem.reference.display_ref,
  title: props.problem.content.title,
  description: props.problem.content.description,
  difficulty: props.problem.difficulty ?? '',
  tags: [],
  runtime_config: props.problem.limits
    ? {
      evaluator: {
        time_limit_ms: props.problem.limits.time_limit_ms,
        memory_limit_mb: props.problem.limits.memory_limit_mb,
      },
    }
    : null,
}));
const history = await useAsyncData(
  () => workspaceCacheKey(props.slug, user.value?.id ?? null, 'code-history', draftProblem.value),
  () =>
    isLoggedIn.value
      ? submissionsApi.list(props.slug, 1, {
        problem_id: props.problem.reference.problem_id,
        contest_id: props.contest?.id,
      })
      : Promise.resolve(null),
);
const activeId = ref('');
const active = await useAsyncData(
  () => `${key.value}:result:${activeId.value}`,
  () => activeId.value ? submissionsApi.detail(props.slug, activeId.value) : Promise.resolve(null),
);
const polling = computed(() =>
  !!activeId.value && !active.error.value &&
  (!active.data.value || ['pending', 'judging'].includes(active.data.value.data.status ?? ''))
);
async function refreshResult() {
  await Promise.all([active.refresh(), history.refresh()]);
}
useEventSource({
  url: computed(() => activeId.value ? `/api/v1/domains/${props.slug}/submissions/${activeId.value}/events` : ''),
  scopeKey: key,
  enabled: polling,
  onEvent: {
    'submission:updated': () => {
      void refreshResult();
    },
  },
  fetchFn: refreshResult,
  fallbackIntervalMs: 1500,
});
async function submit() {
  if (!writable.value || submitting.value || !code.value.trim() || !language.value) return;
  const action = capture();
  submitting.value = true;
  failure.value = '';
  try {
    const response = props.contest
      ? await contestApi.code(
        action.slug,
        props.contest.id,
        props.contest.label,
        version.value,
        language.value,
        code.value,
      )
      : await api.code(
        action.slug,
        props.problem.reference.display_ref,
        version.value,
        language.value,
        code.value,
        props.assignmentOrigin,
      );
    if (!action.isCurrent()) return;
    activeId.value = response.data.id;
    tab.value = 'history';
    sidebarVisible.value = true;
    await history.refresh();
  } catch (cause) {
    failure.value = extractApiError(cause).message;
    if (extractApiError(cause).status === 409) emit('refresh');
  } finally {
    submitting.value = false;
  }
}
async function loadTemplate(automatic = false) {
  if (templateLoading.value || changed.value) return;
  const action = capture();
  if (
    !automatic && code.value.trim() && !await dialog.confirm('用当前作答版本的模板替换代码？', { title: '重置为模板' })
  ) return;
  if (!action.isCurrent()) return;
  templateLoading.value = true;
  failure.value = '';
  try {
    let template: string | null;
    if (props.contest) {
      const response = await contestApi.template(action.slug, props.contest.id, props.contest.label);
      if (response.version_id !== version.value) {
        emit('refresh');
        return;
      }
      template = response.data.content;
    } else {
      template =
        (await api.template(action.slug, props.problem.reference.display_ref, version.value)).data.template_content;
    }
    if (action.isCurrent() && (!automatic || !code.value.trim())) {
      if (template != null) code.value = template;
      else if (!automatic) failure.value = '此版本没有代码模板，当前代码已保留';
    }
  } catch (cause) {
    if (!automatic || extractApiError(cause).status !== 404) failure.value = extractApiError(cause).message;
    if (extractApiError(cause).status === 409) emit('refresh');
  } finally {
    templateLoading.value = false;
  }
}
onMounted(async () => {
  await nextTick();
  if (isLoggedIn.value && props.problem.content.kind === 'ai' && !code.value.trim()) await loadTemplate(true);
});
async function confirmVersion() {
  if (
    !await dialog.confirm(`切换到 V${props.problem.version} 并保留当前代码。请重新核对新题面。`, {
      title: '确认作答版本',
    })
  ) return;
  const saved = code.value;
  draft.save();
  version.value = props.problem.version_id;
  versionNumber.value = props.problem.version;
  if (!languages.value.some((item) => item.value === language.value)) language.value = languages.value[0]?.value ?? '';
  await nextTick();
  code.value = saved;
  draft.save();
  activeId.value = '';
}
async function clearCode() {
  if (await dialog.confirm('清空当前代码和本地草稿内容？', { title: '清空代码', danger: true })) {
    code.value = '';
    draft.save();
  }
}
async function restoreGuest() {
  if (code.value.trim() && !await dialog.confirm('用登录前的草稿替换当前代码？', { title: '恢复登录前草稿' })) return;
  draft.restoreGuest();
}
async function selfTest() {
  tab.value = 'self-test';
  sidebarVisible.value = true;
  await nextTick();
  await selfTestPanel.value?.run();
}
</script>
<template>
  <div class="flex h-dvh flex-col overflow-hidden bg-bg-page" :class="{'editor-dark':theme==='dark'}">
    <EditorToolbar :problem="sidebarProblem" :language="language" :languages="languages" :theme-mode="theme"
      :can-submit="writable && !!code.trim() && !!language" :submitting="submitting"
      :can-self-test="!contest && writable && !!code.trim()" :self-testing="false"
      :can-reset-template="isLoggedIn && problem.content.kind==='ai' && !changed" :template-loading="templateLoading"
      :sidebar-visible="sidebarVisible" :draft-state="draftEnabled ? draft.state.value : 'idle'"
      :draft-saved-at="draftEnabled ? draft.savedAt.value : null"
      :badge="contest?.label" :subtitle="`${contest?.title ?? slug} · V${versionNumber}`"
      @update:language="language=$event" @update:theme-mode="setTheme($event)"
      @toggle-sidebar="sidebarVisible=!sidebarVisible"
      @open-settings="tab='settings';sidebarVisible=true" @submit="submit" @self-test="selfTest"
      @reset-template="loadTemplate()" @back="navigateTo(backUrl)">
      <template #actions>
        <UButton variant="ghost" color="neutral" size="xs" icon="i-lucide-refresh-cw" aria-label="检查版本"
          title="检查版本" @click="emit('refresh')" />
        <UButton v-if="assignmentOrigin" :to="`/d/${slug}/assignments/${assignmentOrigin.assignment_id}`"
          variant="ghost" color="neutral" size="xs" icon="i-lucide-graduation-cap" aria-label="返回作业"
          title="返回作业" />
      </template>
    </EditorToolbar>
    <UAlert v-if="changed" color="warning" title="作答版本已变化，当前代码已保留" class="shrink-0 rounded-none">
      <template #actions>
        <UButton :disabled="submitting || templateLoading"
          @click="confirmVersion">切换到 V{{ problem.version }}</UButton>
      </template>
    </UAlert>
    <UAlert v-if="!isLoggedIn" color="info" title="当前草稿保存在此设备，登录后可以提交" class="shrink-0 rounded-none">
      <template #actions>
        <UButton :to="{path:'/login',query:{redirect:route.fullPath}}">登录并继续作答</UButton>
      </template>
    </UAlert>
    <UAlert v-else-if="contest && !contest.active" color="info" title="仅在比赛受理时间内且已报名时可提交"
      class="shrink-0 rounded-none" />
    <UAlert v-if="draft.guestAvailable.value" color="info" title="发现登录前的本题草稿" class="shrink-0 rounded-none">
      <template #actions>
        <UButton @click="restoreGuest">恢复登录前草稿</UButton>
      </template>
    </UAlert>
    <UAlert v-if="failure || draft.state.value==='error'" color="error"
      :title="failure || '本地草稿保存失败，请复制代码后再离开'" class="shrink-0 rounded-none" />
    <div class="relative flex min-h-0 flex-1">
      <ActivityBar :active="tab" :show-self-test="!contest" @select="value=>{tab=value;sidebarVisible=true;}" />
      <aside v-show="sidebarVisible" :style="{'--sidebar-width':sidebarWidth+'px'}"
        class="absolute inset-y-0 left-12 z-20 flex w-[calc(100%_-_3rem)] shrink-0 flex-col bg-bg-panel sm:static sm:z-auto sm:w-(--sidebar-width)">
        <UButton class="w-full rounded-none sm:hidden" color="neutral" variant="outline" icon="i-lucide-code-2"
          @click="sidebarVisible=false">返回代码</UButton>
        <EditorSidebar class="min-h-0 flex-1" :active="tab" :problem="sidebarProblem" :show-self-test="!contest"
          :annotation="{ slug, target: { kind: 'problem', reference: problem.reference.qualified_ref, version_id: problem.version_id, contest_id: contest?.id, field: 'description' } }"
          :theme-mode="theme" :draft-enabled="draftEnabled"
          @update:theme-mode="setTheme($event)" @update:draft-enabled="draftEnabled=$event" @clear-draft="clearCode">
          <template #after-description>
            <ProblemSamples :samples="problem.content.samples" :annotation="{ slug, reference: problem.reference.qualified_ref, version_id: problem.version_id, contest_id: contest?.id }" />
          </template>
          <template #history>
            <h3 class="text-sm font-semibold">提交记录</h3>
            <UAlert v-if="history.error.value" color="error" :title="extractApiError(history.error.value).message" />
            <UAlert v-if="active.error.value" color="error" :title="extractApiError(active.error.value).message" />
            <DomainSubmissionResult v-if="active.data.value && !active.error.value"
              :submission="active.data.value.data" />
            <UButton v-if="activeId" :to="`/d/${slug}/submissions/${activeId}`" variant="outline"
              size="sm">查看评测</UButton>
            <button v-for="item in history.data.value?.data" :key="item.id"
              class="mb-2 block w-full rounded border border-border p-3 text-left text-xs hover:border-primary"
              @click="activeId=item.id">
              <span class="font-mono">{{ item.id.slice(0, 8) }}</span>
              <span
                class="float-right tabular-nums">{{ item.result_visibility==='hidden' ? '已受理' : item.result?.score!=null ? (item.result.score/100)+' 分' : '等待正式结果' }}</span>
              <span class="mt-1 block text-text-muted">{{ new Date(item.created_at).toLocaleString() }}</span>
            </button>
            <p v-if="history.data.value?.data.length===0" class="text-xs text-text-muted">暂无提交记录</p>
            <UButton
              :to="{path:`/d/${slug}/submissions`,query:{problem_id:problem.reference.problem_id,contest_id:contest?.id}}"
              variant="ghost" size="sm">查看全部提交</UButton>
          </template>
          <template #oi-self-test>
            <DomainSelfTestPanel ref="selfTestPanel" :slug="slug" :problem="problem" :code="code" :language="language"
              :version-id="version" :writable="writable && !submitting" :assignment-origin="assignmentOrigin" expanded
              @refresh="emit('refresh')" />
          </template>
        </EditorSidebar>
      </aside>
      <ResizableSplitter v-if="sidebarVisible" v-model="sidebarWidth" class="hidden sm:block" :min="240" :max="480"
        side="right" />
      <main class="flex min-h-0 min-w-0 flex-1 flex-col">
        <ClientOnly>
          <MonacoEditor v-model="code" :language="language" :theme="theme==='dark'?'vs-dark':'vs'"
            :disabled="submitting" :min-height="240" @cursor-change="cursor=$event" />
        </ClientOnly>
        <EditorStatusBar :language="language" :cursor="cursor" :total-lines="code.split('\n').length"
          :total-chars="code.length" />
      </main>
    </div>
  </div>
</template>
