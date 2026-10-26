import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, ref } from 'vue';
import DomainProblemAnswer from '~/components/feature/DomainProblemAnswer.vue';
import type { DomainProblemDetail } from '~/utils/domain-problems';
const api = { code: vi.fn(), objective: vi.fn(), artifact: vi.fn(), template: vi.fn(), ui: vi.fn() };
const confirm = vi.fn();
const detail: DomainProblemDetail = {
  reference: {
    problem_id: 'p',
    source_domain_id: 'main',
    source_domain_slug: 'main',
    number: 1001,
    qualified_ref: 'main:1001',
    display_ref: 'main:1001',
    is_shared: true,
  },
  binding_id: 'binding',
  policy_revision: 1,
  effective_version_mode: 'any',
  version_id: 'v1',
  version: 1,
  can_edit: false,
  supported_languages: ['python3'],
  content: { kind: 'ai', title: '共享题', description: '', samples: [], submission_mode: 'code' },
};
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UAlert: { props: ['title'], template: '<div>{{ title }}<slot name="actions" /></div>' },
  USelect: { template: '<select />' },
  ClientOnly: { template: '<div><slot /></div>' },
  DomainSelfTestPanel: true,
  UiFrame: {
    name: 'UiFrame',
    props: ['html', 'disabled', 'result'],
    emits: ['update:values', 'submit'],
    template:
      "<button :disabled=\"disabled\" @click=\"$emit('update:values', {prompt:'school work'}); $emit('submit')\">界面提交</button>",
  },
  DomainUiRuns: {
    emits: ['result'],
    template:
      "<button @click=\"$emit('result', {kind:'submit',status:'finished',label:'已评测',score:80})\">读取域汇总</button>",
  },
  UFileUpload: {
    props: ['accept', 'label'],
    emits: ['update:modelValue'],
    template:
      '<input type="file" :accept="accept" :aria-label="label" @change="$emit(\'update:modelValue\', $event.target.files[0])" />',
  },
  MonacoEditor: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, nextTick })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }), isLoggedIn: ref(true) }));
  vi.stubGlobal('useRoute', () => ({ fullPath: '/d/school/problems/main:1001' }));
  vi.stubGlobal('useWorkspace', () => ({ domain: ref({ status: 'active' }) }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDomainProblems', () => api);
  vi.stubGlobal('useAsyncData', (_key: unknown, handler: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref(null);
    handler().then((value) => {
      data.value = value;
    });
    return { data, error };
  });
  vi.stubGlobal(
    'useDomainAnswerDraft',
    () => ({ save: vi.fn(), state: ref('saved'), guestAvailable: ref(false), restoreGuest: vi.fn() }),
  );
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  confirm.mockResolvedValue(true);
  api.code.mockResolvedValue({ data: { id: 's1', status: 'pending' } });
  api.artifact.mockResolvedValue({ data: { id: 'upload1', status: 'pending' } });
  api.ui.mockResolvedValue({ data: { html: '<button>题包界面</button>' } });
  api.template.mockResolvedValue({ data: { version_id: 'v1', template_content: '# version template' } });
});
describe('域题作答', () => {
  it('游客模板按钮不可操作，不调用需要登录的权限上下文', async () => {
    const capture = vi.fn(() => {
      throw new Error('操作需要登录');
    });
    vi.stubGlobal('useAuth', () => ({ user: ref(null), isLoggedIn: ref(false) }));
    vi.stubGlobal('useWorkspaceActionScope', () => capture);
    const view = mount(DomainProblemAnswer, { props: { slug: 'school', problem: detail }, global: { stubs } });
    const button = view.findAll('button').find((button) => button.text() === '载入版本模板')!;
    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(capture).not.toHaveBeenCalled();
    expect(api.template).not.toHaveBeenCalled();
  });
  it('空模板不会清除已经输入的代码，并说明没有模板', async () => {
    api.template.mockResolvedValue({ data: { version_id: 'v1', template_content: '' } });
    const view = mount(DomainProblemAnswer, { props: { slug: 'school', problem: detail }, global: { stubs } });
    await view.find('textarea').setValue('keep my code');
    await view.findAll('button').find((button) => button.text() === '载入版本模板')!.trigger('click');
    await flushPromises();
    expect(view.find('textarea').element.value).toBe('keep my code');
    expect(view.text()).toContain('此版本没有代码模板，当前代码已保留');
  });
  it('界面题读取学校绑定版本，参数仍走同域普通提交及作业来源', async () => {
    const origin = { assignment_id: 'task', assignment_item_id: 'item' };
    const view = mount(DomainProblemAnswer, {
      props: {
        slug: 'school',
        problem: { ...detail, content: { ...detail.content, submission_mode: 'ui' } },
        assignmentOrigin: origin,
      },
      global: { stubs },
    });
    await flushPromises();
    expect(api.ui).toHaveBeenCalledWith('school', 'main:1001', 'v1');
    await view.findAll('button').find((button) => button.text() === '读取域汇总')!.trigger('click');
    expect(view.findComponent({ name: 'UiFrame' }).props('result')).toMatchObject({ score: 80 });
    await view.findAll('button').find((button) => button.text() === '界面提交')!.trigger('click');
    await flushPromises();
    expect(api.code).toHaveBeenCalledWith(
      'school',
      'main:1001',
      'v1',
      'ui',
      JSON.stringify({ prompt: 'school work' }, null, 2),
      origin,
    );
  });
  it('预测题显示单文件白名单并使用使用域上传，不走代码提交', async () => {
    const view = mount(DomainProblemAnswer, {
      props: { slug: 'school', problem: { ...detail, content: { ...detail.content, submission_mode: 'prediction' } } },
      global: { stubs },
    });
    const file = new File(['x,y'], 'prediction.csv');
    const input = view.get('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    expect(view.text()).toContain('已选择：prediction.csv');
    expect(input.attributes('accept')).toContain('.csv');
    expect(input.attributes('accept')).not.toContain('.zip');
    await view.findAll('button').find((button) => button.text() === '提交评测')!.trigger('click');
    await flushPromises();
    expect(api.artifact).toHaveBeenCalledWith('school', 'main:1001', 'v1', file, undefined);
    expect(api.code).not.toHaveBeenCalled();
  });
  it('载入模板使用使用域和当前版本，覆盖已有代码前确认', async () => {
    const view = mount(DomainProblemAnswer, { props: { slug: 'school', problem: detail }, global: { stubs } });
    await view.find('textarea').setValue('my work');
    confirm.mockResolvedValueOnce(false);
    await view.findAll('button').find((button) => button.text() === '载入版本模板')!.trigger('click');
    await flushPromises();
    expect(api.template).not.toHaveBeenCalled();
    expect(view.find('textarea').element.value).toBe('my work');
    await view.findAll('button').find((button) => button.text() === '载入版本模板')!.trigger('click');
    await flushPromises();
    expect(api.template).toHaveBeenCalledWith('school', 'main:1001', 'v1');
    expect(view.find('textarea').element.value).toBe('# version template');
  });
  it('引用公共题仍提交学校域、来源题号和所见版本', async () => {
    const view = mount(DomainProblemAnswer, { props: { slug: 'school', problem: detail }, global: { stubs } });
    await view.find('textarea').setValue('print(1)');
    await view.findAll('button').find((button) => button.text() === '提交评测')!.trigger('click');
    await flushPromises();
    expect(api.code).toHaveBeenCalledWith('school', 'main:1001', 'v1', 'python3', 'print(1)', undefined);
    expect(view.text()).toContain('已受理提交：s1');
  });
  it('版本刷新后先阻止提交，明确确认后保留代码使用新版本', async () => {
    const view = mount(DomainProblemAnswer, { props: { slug: 'school', problem: detail }, global: { stubs } });
    await view.find('textarea').setValue('my code');
    await view.setProps({ problem: { ...detail, version_id: 'v2', version: 2 } });
    expect(view.findAll('button').find((button) => button.text() === '提交评测')!.attributes('disabled')).toBeDefined();
    await view.findAll('button').find((button) => button.text() === '切换到 V2')!.trigger('click');
    await flushPromises();
    expect(view.find('textarea').element.value).toBe('my code');
    await view.findAll('button').find((button) => button.text() === '提交评测')!.trigger('click');
    await flushPromises();
    expect(api.code).toHaveBeenCalledWith('school', 'main:1001', 'v2', 'python3', 'my code', undefined);
  });
  it('作业进入后切换版本保留代码和来源，提交仍使用普通同域接口', async () => {
    const origin = { assignment_id: 'task', assignment_item_id: 'item' };
    const view = mount(DomainProblemAnswer, {
      props: { slug: 'school', problem: detail, assignmentOrigin: origin },
      global: { stubs },
    });
    await view.find('textarea').setValue('my work');
    await view.setProps({ problem: { ...detail, version_id: 'v2', version: 2 } });
    await view.findAll('button').find((button) => button.text() === '切换到 V2')!.trigger('click');
    await flushPromises();
    await view.findAll('button').find((button) => button.text() === '提交评测')!.trigger('click');
    await flushPromises();
    expect(api.code).toHaveBeenCalledWith('school', 'main:1001', 'v2', 'python3', 'my work', origin);
  });
});
