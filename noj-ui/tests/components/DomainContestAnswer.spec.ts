import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, ref, Suspense } from 'vue';
import DomainContestAnswer from '~/components/feature/DomainContestAnswer.vue';
import type { ContestProblem } from '~/composables/useContests';
const api = { questions: vi.fn(), code: vi.fn(), artifact: vi.fn(), objective: vi.fn(), template: vi.fn() };
const confirm = vi.fn();
const problem = {
  problem_id: 'p',
  label: 'A',
  version_id: 'fixed-v1',
  version: 1,
  supported_languages: ['python3'],
  submission_mode: 'code',
  is_objective: false,
} as ContestProblem & { version_id: string };
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}<slot name="actions" /></p>' },
  USelect: { template: '<select />' },
  UCheckbox: {
    props: ['label'],
    emits: ['update:modelValue'],
    template: '<button @click="$emit(\'update:modelValue\', true)">{{ label }}</button>',
  },
  MarkdownRenderer: { props: ['content'], template: '<p>{{ content }}</p>' },
  ClientOnly: { template: '<div><slot /></div>' },
  MonacoEditor: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, nextTick })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainContestAnswers', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDomainAnswerDraft', () => ({ save: vi.fn() }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  vi.stubGlobal(
    'useAsyncData',
    async (_key: unknown, load: () => Promise<unknown>) => ({
      data: ref(await load()),
      error: ref(null),
      status: ref('success'),
    }),
  );
  confirm.mockResolvedValue(true);
  api.code.mockResolvedValue({ data: { id: 'receipt', status: 'pending' } });
  api.questions.mockResolvedValue({
    data: [{ id: 'question-stable-id', type: 'single', prompt: '选择', options: [{ key: 'A', text: '选项 A' }] }],
    version_id: 'fixed-v1',
    version: 1,
  });
  api.objective.mockResolvedValue({ data: { score: null, details: {} } });
});
async function answer(objective = false) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(DomainContestAnswer, {
            slug: 'school',
            contestId: 'contest',
            active: true,
            problem: { ...problem, is_objective: objective },
          }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
describe('域比赛独立作答入口', () => {
  it('代码以使用域、比赛标号和固定版本提交，不进入普通题库', async () => {
    const view = await answer();
    await view.find('textarea').setValue('print(1)');
    await view.findAll('button').find((button) => button.text() === '提交比赛评测')!.trigger('click');
    await flushPromises();
    expect(api.code).toHaveBeenCalledWith('school', 'contest', 'A', 'fixed-v1', 'python3', 'print(1)');
    expect(view.text()).toContain('比赛提交已受理');
  });
  it('客观题使用稳定小题 ID，一次交卷后不再提交且不将隐藏分数显示为零', async () => {
    const view = await answer(true);
    await view.findAll('button').find((button) => button.text() === 'A. 选项 A')!.trigger('click');
    await view.findAll('button').find((button) => button.text() === '一次正式交卷')!.trigger('click');
    await flushPromises();
    expect(api.objective).toHaveBeenCalledWith('school', 'contest', 'A', 'fixed-v1', { 'question-stable-id': ['A'] });
    expect(view.text()).toContain('成绩暂未公开');
    expect(view.text()).not.toContain('0 分');
    expect(view.findAll('button').find((button) => button.text() === '一次正式交卷')!.attributes('disabled'))
      .toBeDefined();
  });
});
