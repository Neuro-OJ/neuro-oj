import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, ref } from 'vue';
import ProblemAnswerPanel from '~/components/problem/ProblemAnswerPanel.vue';

/**
 * 共用作答面板：题库与比赛两种上下文的行为差异。
 *
 * 面板是「作答」的唯一实现（题库 `DomainProblemAnswer` 与比赛
 * `DomainContestAnswer` 都只是注入了不同 handlers 的适配层）。因此这里同时锁定
 * 两种上下文：同样的交互、同样的版本回传，只在门控与文案上分叉。
 */

const handlers = {
  submitCode: vi.fn(),
  submitFile: vi.fn(),
  submitObjective: vi.fn(),
  loadTemplate: vi.fn(),
  loadUi: vi.fn(),
  loadQuestions: vi.fn(),
};
const confirm = vi.fn();
let draftState: ReturnType<typeof useDraftStub>;

function useDraftStub() {
  const state = ref<'idle' | 'saved' | 'error'>('idle');
  return {
    state,
    savedAt: ref<Date | null>(null),
    guestAvailable: ref(false),
    save: vi.fn(() => true),
    restoreGuest: vi.fn(),
  };
}

const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UButton: { props: ['disabled', 'loading'], template: '<button :disabled="disabled"><slot /></button>' },
  UAlert: { props: ['title'], template: '<p role="alert">{{ title }}<slot name="actions" /></p>' },
  USelect: { template: '<select />' },
  UFileUpload: {
    props: ['accept', 'label'],
    emits: ['update:modelValue'],
    template:
      '<input type="file" :accept="accept" :aria-label="label" @change="$emit(\'update:modelValue\', $event.target.files[0])" />',
  },
  UCheckbox: {
    props: ['label', 'modelValue'],
    emits: ['update:modelValue'],
    template: '<button :data-label="label" @click="$emit(\'update:modelValue\', label)">{{ label }}</button>',
  },
  MarkdownRenderer: { props: ['content'], template: '<p>{{ content }}</p>' },
  ClientOnly: { template: '<div><slot /></div>' },
  MonacoEditor: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UiFrame: { template: '<div>题包界面</div>' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ProblemAnswerPanel, {
    props: {
      context: 'library',
      slug: 'school',
      isObjective: false,
      submissionMode: 'code',
      supportedLanguages: ['python3'],
      versionId: 'v1',
      version: 1,
      writable: true,
      draftKey: 'draft',
      handlers,
      ...overrides,
    },
    global: { stubs },
  });
}

const submitButton = (view: ReturnType<typeof mountPanel>) =>
  view.findAll('button').find((button) => ['提交评测', '提交比赛评测'].includes(button.text()));

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, nextTick })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }), isLoggedIn: ref(true) }));
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school') }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  // 面板不 await useAsyncData（无 Suspense 边界）：这里给同步 ref 即可。
  vi.stubGlobal('useAsyncData', (_key: unknown, load: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null), status = ref('pending');
    void load().then((value) => {
      data.value = value;
      status.value = 'success';
    }).catch((cause) => error.value = cause);
    return { data, error, status, refresh: vi.fn() };
  });
  draftState = useDraftStub();
  vi.stubGlobal('useDomainAnswerDraft', () => draftState);
  confirm.mockResolvedValue(true);
  handlers.submitCode.mockResolvedValue({ id: 'submission-1' });
  handlers.submitObjective.mockResolvedValue({ score: null });
  handlers.loadTemplate.mockResolvedValue({ version_id: 'v1', content: '# template' });
});

describe('共用作答面板：题库上下文', () => {
  it('提交携带当前作答版本、语言与代码', async () => {
    const view = mountPanel();
    await view.find('textarea').setValue('print(1)');
    await submitButton(view)!.trigger('click');
    await flushPromises();
    expect(handlers.submitCode).toHaveBeenCalledWith('v1', 'python3', 'print(1)');
    expect(view.text()).toContain('已受理提交：submission-1');
  });

  it('载入版本模板前先确认，空模板不清空已有代码', async () => {
    handlers.loadTemplate.mockResolvedValue({ version_id: 'v1', content: '' });
    const view = mountPanel();
    await view.find('textarea').setValue('my work');
    confirm.mockResolvedValueOnce(false);
    await view.findAll('button').find((button) => button.text() === '载入版本模板')!.trigger('click');
    await flushPromises();
    expect(handlers.loadTemplate).not.toHaveBeenCalled();
    await view.findAll('button').find((button) => button.text() === '载入版本模板')!.trigger('click');
    await flushPromises();
    expect(handlers.loadTemplate).toHaveBeenCalledTimes(1);
    expect((view.find('textarea').element as HTMLTextAreaElement).value).toBe('my work');
    expect(view.text()).toContain('此版本没有代码模板，当前代码已保留');
  });

  it('版本变化先阻止提交，确认后保留输入并回传新版本', async () => {
    const view = mountPanel();
    await view.find('textarea').setValue('my code');
    await view.setProps({ versionId: 'v2', version: 2 });
    expect(submitButton(view)!.attributes('disabled')).toBeDefined();
    await view.findAll('button').find((button) => button.text() === '切换到 V2')!.trigger('click');
    await flushPromises();
    expect((view.find('textarea').element as HTMLTextAreaElement).value).toBe('my code');
    await submitButton(view)!.trigger('click');
    await flushPromises();
    expect(handlers.submitCode).toHaveBeenCalledWith('v2', 'python3', 'my code');
  });

  it('游客不可提交，但仍可编辑并看到登录引导', () => {
    vi.stubGlobal('useAuth', () => ({ user: ref(null), isLoggedIn: ref(false) }));
    const view = mountPanel({ writable: false });
    expect(submitButton(view)!.attributes('disabled')).toBeDefined();
    expect(view.text()).toContain('登录后提交作答');
  });
});

describe('共用作答面板：比赛上下文', () => {
  const contestText = {
    title: '比赛作答',
    submit: '提交比赛评测',
    objectiveSubmit: '一次正式交卷',
  };

  it('未报名/未开赛时说明原因且按钮禁用，但保留已写输入', async () => {
    const view = mountPanel({ context: 'contest', writable: false, texts: contestText });
    expect(view.text()).toContain('仅在比赛受理时间内且已报名时可提交');
    await view.find('textarea').setValue('draft code');
    expect(submitButton(view)!.attributes('disabled')).toBeDefined();
    expect(handlers.submitCode).not.toHaveBeenCalled();
  });

  it('客观题一次交卷后不会重复提交，也不把隐藏分数显示成 0', async () => {
    const view = mountPanel({
      context: 'contest',
      isObjective: true,
      submissionMode: 'code',
      questions: [{
        id: 'q1',
        type: 'single',
        prompt: '1 + 1 = 2?',
        options: [{ key: 'A', text: '正确' }],
      }],
      texts: contestText,
    });
    await flushPromises();
    await view.findAll('button').find((button) => button.attributes('data-label') === 'A. 正确')!.trigger('click');
    await view.findAll('button').find((button) => button.text() === '一次正式交卷')!.trigger('click');
    await flushPromises();
    expect(handlers.submitObjective).toHaveBeenCalledWith('v1', { q1: ['A'] });
    expect(view.text()).toContain('正式交卷已受理，成绩暂未公开');
    expect(view.text()).not.toContain('0 分');
    const submit = view.findAll('button').find((button) => button.text() === '一次正式交卷')!;
    expect(submit.attributes('disabled')).toBeDefined();
  });

  it('比赛不渲染代码自测：面板只提供模板与提交', () => {
    const view = mountPanel({ context: 'contest', texts: contestText });
    expect(view.text()).not.toContain('代码自测');
    expect(view.findAll('button').some((button) => button.text() === '载入比赛模板')).toBe(true);
  });
});
