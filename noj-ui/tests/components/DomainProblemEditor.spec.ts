import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, shallowRef, watch } from 'vue';
import DomainProblemEditor from '~/components/editor/DomainProblemEditor.vue';
import type { ProblemDraftView } from '~/composables/useProblemVersions';
import { useDomainProblemEditor as authorApi } from '~/composables/useDomainProblemEditor';
import { newDomainEditorContent } from '~/utils/domain-problem-editor';
import type { DomainAiRuntime } from '~/utils/domain-problem-editor';
const api = { save: vi.fn(), preflight: vi.fn(), publish: vi.fn(), importBundle: vi.fn() };
const draft = {
  problem_id: 'p',
  revision: 3,
  base_version_id: null,
  content: { kind: 'objective', title: '原题目', description: '题面', samples: [], questions: [] },
  updated_by: 'teacher',
  updated_at: null,
  synthesized: false,
} as ProblemDraftView;
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UTextarea: { template: '<textarea />' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  AdminFormField: { template: '<div><slot /></div>' },
  MarkdownEditor: { template: '<div />' },
  ProblemSampleEditor: { template: '<div />' },
  DomainObjectiveQuestions: { template: '<div />' },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, shallowRef, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useDomainProblemEditor', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true) } }));
  vi.stubGlobal('onBeforeRouteLeave', vi.fn());
  api.save.mockResolvedValue({ ...draft, revision: 4 });
  api.preflight.mockResolvedValue({ ready: true, revision: 4, files: [], errors: [], warnings: [] });
  api.publish.mockResolvedValue({ version: 1, draft_revision: 5, unchanged: false });
  api.importBundle.mockResolvedValue({ data: { problem_id: 'p', draft_revision: 4 } });
});
function editor() {
  return mount(DomainProblemEditor, {
    props: { slug: 'school', reference: '1001', draft, writable: true, canPublish: true },
    global: { stubs },
  });
}
describe('域共享草稿与发布', () => {
  it('旧 OI 配置补齐计分默认值后不误报修改，允许直接预检与离开', async () => {
    const guard = vi.fn();
    vi.stubGlobal('onBeforeRouteLeave', guard);
    const view = mount(DomainProblemEditor, {
      props: {
        slug: 'school',
        reference: '1001',
        writable: true,
        canPublish: true,
        draft: {
          ...draft,
          content: {
            kind: 'oi',
            title: 'A+B',
            description: '',
            samples: [],
            runtime_config: {
              backend: 'native',
              languages: ['cc'],
              time_limit_ms: 1000,
              memory_limit_mb: 256,
              checker: { type: 'default' },
              subtasks: [{ id: 'all', score: 100, cases: [{ id: 'sample', input: '1.in', output: '1.out' }] }],
            },
          },
        },
      },
      global: { stubs: { ...stubs, DomainOiRuntime: true, DomainOiFiles: true } },
    });
    expect(view.text()).toContain('草稿已保存');
    expect(view.text()).not.toContain('有未保存修改');
    const preflight = view.findAll('button').find((button) => button.text() === '发布预检')!;
    expect(preflight.attributes('disabled')).toBeUndefined();
    await preflight.trigger('click');
    await flushPromises();
    expect(api.preflight).toHaveBeenCalledWith('school', '1001', 3);
    expect(await guard.mock.calls[0]![0]()).toBe(true);
  });
  it('AI 创建请求携带完整初始 runtime，不发送题库分类或模型', async () => {
    const post = vi.fn().mockResolvedValue({ problem_id: 'p', number: 1001, draft_revision: 1 });
    vi.stubGlobal('useApi', () => ({ api: { post } }));
    const content = newDomainEditorContent('ai');
    const runtime = content.runtime_config as DomainAiRuntime;
    runtime.evaluator.image = 'approved/evaluator';
    runtime.solution.image = 'approved/solution';
    await authorApi().create('school', content, 'private');
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/api/v1/domains/school/problems');
    expect(body.runtime_config).toEqual(runtime);
    expect(body.runtime_config.evaluator.command).toBe('python3 /workspace/evaluate.py');
    expect(body.runtime_config.evaluator.network.enabled).toBe(false);
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('provider_id');
    expect(body).not.toHaveProperty('model');
  });
  it('修改后必须先保存，预检和发布使用新的草稿 revision', async () => {
    const view = editor();
    await view.find('input:not([type="file"])').setValue('更新题目');
    expect(view.findAll('button').find((button) => button.text() === '发布预检')!.attributes('disabled')).toBeDefined();
    await view.findAll('button').find((button) => button.text() === '保存草稿')!.trigger('click');
    await flushPromises();
    expect(api.save).toHaveBeenCalledWith(
      'school',
      '1001',
      expect.objectContaining({ title: '更新题目', kind: 'objective' }),
      3,
    );
    await view.findAll('button').find((button) => button.text() === '发布预检')!.trigger('click');
    await flushPromises();
    expect(api.preflight).toHaveBeenCalledWith('school', '1001', 4);
    await view.findAll('button').find((button) => button.text() === '发布版本')!.trigger('click');
    await flushPromises();
    expect(api.publish).toHaveBeenCalledWith('school', '1001', 4, '');
    expect(view.text()).toContain('已发布 V1');
  });
  it('revision 冲突保留输入，不自动读取或覆盖另一份草稿', async () => {
    api.save.mockRejectedValue({ statusCode: 409, data: { error: '草稿已被其他编辑更新' } });
    const view = editor();
    await view.find('input:not([type="file"])').setValue('保留的输入');
    await view.findAll('button').find((button) => button.text() === '保存草稿')!.trigger('click');
    await flushPromises();
    expect((view.find('input:not([type="file"])').element as HTMLInputElement).value).toBe('保留的输入');
    expect(view.text()).toContain('当前输入已保留');
    expect(api.publish).not.toHaveBeenCalled();
  });
  it('导入只写当前域草稿，成功后重新读取且不隐式发布', async () => {
    const view = editor(), file = new File(['zip'], 'problem.zip', { type: 'application/zip' });
    Object.defineProperty(view.find('input[type="file"]').element, 'files', { value: [file] });
    await view.find('input[type="file"]').trigger('change');
    await view.findAll('button').find((button) => button.text() === '导入到草稿')!.trigger('click');
    await flushPromises();
    expect(api.importBundle).toHaveBeenCalledWith('school', '1001', 3, expect.any(FormData));
    expect(api.importBundle.mock.calls[0]![3].get('file').name).toBe('problem.zip');
    expect(view.emitted('reload')).toHaveLength(1);
    expect(api.publish).not.toHaveBeenCalled();
  });
});
