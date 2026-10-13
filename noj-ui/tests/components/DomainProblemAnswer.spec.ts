import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, ref } from 'vue';
import DomainProblemAnswer from '~/components/feature/DomainProblemAnswer.vue';
import type { DomainProblemDetail } from '~/utils/domain-problems';
const api = { code: vi.fn(), objective: vi.fn(), artifact: vi.fn(), template: vi.fn() };
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
  vi.stubGlobal('useWorkspace', () => ({ domain: ref({ status: 'active' }) }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDomainProblems', () => api);
  vi.stubGlobal('useDomainAnswerDraft', () => ({ save: vi.fn() }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  confirm.mockResolvedValue(true);
  api.code.mockResolvedValue({ data: { id: 's1', status: 'pending' } });
  api.template.mockResolvedValue({ data: { version_id: 'v1', template_content: '# version template' } });
});
describe('域题作答', () => {
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
