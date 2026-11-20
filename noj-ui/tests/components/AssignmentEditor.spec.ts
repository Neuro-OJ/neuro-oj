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
let current = true;
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
    reference: { display_ref: 'main:1001', qualified_ref: 'main:1001' },
    requirement: 'min_score',
    minimum_score: 6000,
    answer_version_id: null,
    policy_revision: null,
  }],
});
const input = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const stubs = {
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
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
  UButton: { props: ['disabled', 'loading'], template: '<button :disabled="disabled || loading"><slot /></button>' },
};
beforeEach(() => {
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  vi.clearAllMocks();
  current = true;
  api.members.mockResolvedValue({
    data: [{ user_id: 'student', username: '学生甲', role: 'student', effective_active: true }],
  });
  api.problems.mockResolvedValue({ items: [], total: 0 });
  for (const [name, value] of Object.entries({ ref, reactive, computed, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useState', () => ref({ id: 'teacher' }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => current }));
  vi.stubGlobal(
    'useAsyncData',
    async (_key: unknown, load: () => Promise<unknown>) => ({
      data: ref(await load()),
      error: ref(null),
      status: ref('success'),
      refresh: vi.fn(),
    }),
  );
});
async function editor(task = initial()) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () => h(AssignmentEditor, { slug: 'school', classroomId: 'class', initial: task }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
describe('作业草稿编辑', () => {
  it('保存冲突保留修改与原 revision，不把草稿默默改绑到外部新版本', async () => {
    const task = reactive(initial()), view = await editor(task);
    await view.get('input[aria-label="作业标题"]').setValue('尚未保存的标题');
    task.revision = 8;
    api.saveAssignment.mockRejectedValue({ statusCode: 409, data: { error: '作业已变化', code: 'REVISION_CONFLICT' } });
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(api.saveAssignment).toHaveBeenCalledWith(
      'school',
      'task',
      expect.objectContaining({
        title: '尚未保存的标题',
        items: [{ binding_id: 'binding', requirement: 'min_score', minimum_score: 6000 }],
      }),
      7,
    );
    expect((view.get('input[aria-label="作业标题"]').element as HTMLInputElement).value).toBe('尚未保存的标题');
    expect(view.text()).toContain('作业已变化');
    view.unmount();
  });
  it('按学生姓名选择部分目标，不把展示名称作为后端身份', async () => {
    const view = await editor();
    api.saveAssignment.mockResolvedValue({ data: { id: 'task' } });
    await view.get('select[aria-label="作业目标范围"]').setValue('selected');
    await view.findAll('input[type="checkbox"]').find((e) => e.element.parentElement?.textContent?.includes('学生甲'))!
      .setValue(true);
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(api.saveAssignment.mock.calls[0]?.[2].target_student_ids).toEqual(['student']);
    view.unmount();
  });
  it('请求期间切换身份不把旧保存结果应用到新页面', async () => {
    const view = await editor();
    let resolve!: (value: unknown) => void;
    api.saveAssignment.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await view.get('form').trigger('submit');
    current = false;
    resolve({ data: { id: 'task' } });
    await flushPromises();
    expect(view.findComponent(AssignmentEditor).emitted('saved')).toBeUndefined();
    view.unmount();
  });
});
