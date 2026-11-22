import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense, watch } from 'vue';
import AssignmentEditor from '~/components/education/AssignmentEditor.vue';
import type { AssignmentDetail } from '~/utils/education';

const api = {
  members: vi.fn(),
  problems: vi.fn(),
  saveAssignment: vi.fn(),
  createAssignment: vi.fn(),
  problem: vi.fn(),
  training: vi.fn(),
};
const disabled = ref(false);
const graph = ref<Record<string, unknown> | null>({
  pack: { id: 'p', version: '1' },
  areas: [{ id: 'ml', name: '机器学习基础', sort: 1 }],
  nodes: [{ id: 'ml.lr', area: 'ml', name: '线性回归', summary: null, requires: [] }],
});
const loadGraph = vi.fn(() => Promise.resolve(graph.value));
const loadClassroomPick = vi.fn();

const initial = (): AssignmentDetail => ({
  id: 'task',
  classroom_id: 'class',
  title: '基础任务',
  description: '',
  state: 'draft',
  revision: 7,
  publish_at: null,
  published_at: null,
  deadline_at: null,
  ended_at: null,
  archived_at: null,
  publish_error: null,
  include_previous_submissions: false,
  target_student_ids: null,
  source_training_id: null,
  source_training_rule: null,
  items: [{
    id: 'item',
    binding_id: 'binding',
    reference: { display_ref: '1001', qualified_ref: 'school:1001' },
    requirement: 'accepted',
    minimum_score: null,
    answer_version_id: null,
    policy_revision: null,
  }],
});

const input = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const button = {
  props: ['disabled', 'loading'],
  emits: ['click'],
  template: '<button type="button" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
};
const stubs = {
  UAlert: { props: ['title'], template: '<p class="alert">{{ title }}</p>' },
  UCard: { template: '<div><slot /></div>' },
  AdminFormField: { template: '<div><slot /></div>' },
  UInput: input,
  MarkdownEditor: {
    ...input,
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  USelect: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select>',
  },
  UCheckbox: {
    props: ['modelValue', 'label'],
    emits: ['update:modelValue'],
    template:
      '<label>{{ label }}<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /></label>',
  },
  UButton: button,
  UBadge: { template: '<span class="badge"><slot /></span>' },
  UIcon: true,
  UFormField: { template: '<div><slot /></div>' },
  KnowledgePicker: {
    props: ['modelValue', 'graph'],
    emits: ['update:modelValue'],
    template:
      '<div data-testid="knowledge-picker-stub"><span>{{ (graph?.nodes ?? []).length }} 个知识点</span><button type="button" class="pick" @click="$emit(\'update:modelValue\', { primary: \'ml.lr\', secondary: [] })">选线性回归</button></div>',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  disabled.value = false;
  for (const [name, value] of Object.entries({ ref, reactive, computed, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  vi.stubGlobal('useState', () => ref({ id: 'teacher' }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useKnowledge', () => ({
    disabled,
    graph,
    loadGraph,
    loadClassroomPick,
  }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => ({
    data: ref(await load()),
    error: ref(null),
    status: ref('success'),
    refresh: vi.fn(),
  }));
  api.members.mockResolvedValue({ data: [] });
  api.problems.mockResolvedValue({ items: [], total: 0 });
  api.problem.mockResolvedValue({
    binding_id: 'binding-1002',
    version: 1,
    reference: { display_ref: '1002', qualified_ref: 'school:1002' },
    content: { title: '多元回归', kind: 'code' },
  });
  loadClassroomPick.mockResolvedValue({
    node_id: 'ml.lr',
    node_name: '线性回归',
    items: [
      { problem_id: 'p1', number: 1001, display_ref: '1001', title: '简单回归', difficulty: 20, tier: 'easy' },
      { problem_id: 'p2', number: 1002, display_ref: '1002', title: '多元回归', difficulty: 50, tier: 'medium' },
    ],
  });
});

async function editor() {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () => h(AssignmentEditor, { slug: 'school', classroomId: 'class', initial: initial() }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}

describe('作业编辑器按知识点添加', () => {
  it('预览题目并追加入作业（跳过已在作业中的题目）', async () => {
    const view = await editor();
    const panel = view.get('[data-testid="assignment-knowledge-picker"]');
    expect(panel.text()).toContain('按知识点添加');
    expect(panel.text()).toContain('1 个知识点');
    await panel.get('button.pick').trigger('click');
    const previewButton = panel.findAll('button').find((b) => b.text() === '预览题目')!;
    await previewButton.trigger('click');
    await flushPromises();
    expect(loadClassroomPick).toHaveBeenCalledWith('school', 'class', 'ml.lr', 5);
    const preview = view.findAll('[data-testid="knowledge-pick-item"]');
    expect(preview.map((item) => item.text())).toEqual([
      '1001简单回归简单已在作业中',
      '1002多元回归中等',
    ]);
    // 1001 已在作业中，只追加 1002
    await panel.findAll('button').find((b) => b.text() === '加入作业')!.trigger('click');
    await flushPromises();
    // 与按题号添加同一解析接口取得本域绑定；已在作业中的 1001 不再解析
    expect(api.problem).toHaveBeenCalledTimes(1);
    expect(api.problem).toHaveBeenCalledWith('school', '1002');
    expect(view.text()).toContain('已选作业题目（2 / 200）');
    expect(view.text()).toContain('多元回归');
    // 保存时提交解析得到的绑定（不能是空 binding_id）
    api.saveAssignment.mockResolvedValue({ data: { id: 'task' } });
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(api.saveAssignment.mock.calls[0]?.[2].items).toEqual([
      { binding_id: 'binding', requirement: 'accepted', minimum_score: null },
      { binding_id: 'binding-1002', requirement: 'accepted', minimum_score: null },
    ]);
    view.unmount();
  });

  it('换知识点后旧预览失效，题数越界给出提示且不能预览', async () => {
    const view = await editor();
    const panel = view.get('[data-testid="assignment-knowledge-picker"]');
    await panel.get('button.pick').trigger('click');
    await panel.findAll('button').find((b) => b.text() === '预览题目')!.trigger('click');
    await flushPromises();
    expect(view.findAll('[data-testid="knowledge-pick-item"]')).toHaveLength(2);
    await panel.get('input[aria-label="按知识点挑题数量"]').setValue('21');
    expect(view.text()).toContain('题目数量需为 1–20 的整数');
    view.unmount();
  });

  it('知识图谱关闭时不渲染该区块', async () => {
    disabled.value = true;
    const view = await editor();
    expect(view.find('[data-testid="assignment-knowledge-picker"]').exists()).toBe(false);
    expect(loadGraph).not.toHaveBeenCalled();
    view.unmount();
  });
});
