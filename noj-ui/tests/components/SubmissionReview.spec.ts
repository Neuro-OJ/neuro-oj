import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import SubmissionReview from '~/components/education/SubmissionReview.vue';
const api = { files: vi.fn(), annotations: vi.fn(), text: vi.fn(), updateAnnotation: vi.fn() };
const confirm = vi.fn(), refresh = vi.fn();
const stubs = {
  AsyncContent: { template: '<div><slot /></div>' },
  USelect: { template: '<select />' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  UButton: { props: ['type', 'disabled'], template: '<button :type="type" :disabled="disabled"><slot /></button>' },
  UTextarea: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useState', () => ref({ id: 'teacher' }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => ({
    data: ref(await load()),
    error: ref(null),
    status: ref('success'),
    refresh,
  }));
  api.files.mockResolvedValue({
    data: { submission_id: 'submission', files: [{ file_name: 'main.py', size_bytes: 10 }] },
  });
  api.annotations.mockResolvedValue({
    data: {
      data: [{
        id: 'note',
        submission_id: 'submission',
        file_name: 'main.py',
        source_hash: 'hash',
        author_id: 'teacher',
        author_name: '教练',
        body: '旧反馈',
        revision: 7,
        start_line: 1,
        end_line: 2,
      }],
      total: 1,
    },
  });
  api.updateAnnotation.mockResolvedValue({ data: {} });
});
async function review() {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(SubmissionReview, { slug: 'school', classroomId: 'room', submissionId: 'submission', canAnnotate: true }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
describe('行批注修改及撤回', () => {
  it('修改绑定原域、班级、提交及服务器 revision', async () => {
    const view = await review();
    await view.findAll('button').find((button) => button.text() === '修改')!.trigger('click');
    await view.find('textarea').setValue('修改反馈');
    await view.find('form').trigger('submit');
    await flushPromises();
    expect(api.updateAnnotation).toHaveBeenCalledWith('school', 'room', 'submission', 'note', 7, { body: '修改反馈' });
    expect(refresh).toHaveBeenCalled();
  });
  it('取消撤回不写入，明确确认后才提交撤回', async () => {
    const view = await review();
    confirm.mockResolvedValueOnce(false);
    const button = view.findAll('button').find((entry) => entry.text() === '撤回')!;
    await button.trigger('click');
    await flushPromises();
    expect(api.updateAnnotation).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    await button.trigger('click');
    await flushPromises();
    expect(api.updateAnnotation).toHaveBeenCalledWith('school', 'room', 'submission', 'note', 7, { withdraw: true });
  });
});
