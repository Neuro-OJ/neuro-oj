import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import DomainOiFiles from '~/components/editor/DomainOiFiles.vue';
import { newDomainEditorContent } from '~/utils/domain-problem-editor';
const api = { oiFiles: vi.fn(), oiFile: vi.fn(), oiSave: vi.fn() }, refresh = vi.fn();
const stubs = {
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UCard: { template: '<div><slot /></div>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'editor' }) }));
  vi.stubGlobal('useDomainProblemEditor', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal(
    'useAsyncData',
    () => ({ data: ref({ data: { draft_revision: 3, files: [] } }), error: ref(null), refresh }),
  );
  api.oiSave.mockResolvedValue({ data: { draft_revision: 4, files_changed: true } });
});
async function files() {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(DomainOiFiles, {
            slug: 'school',
            reference: '1001',
            content: newDomainEditorContent('oi'),
            revision: 3,
            writable: true,
            dirty: false,
          }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
async function upload(view: Awaited<ReturnType<typeof files>>) {
  const input = view.find('input[type="file"]');
  Object.defineProperty(input.element, 'files', { value: [new File(['1'], '1.in')] });
  await input.trigger('change');
}
describe('域 OI 文件草稿', () => {
  it('上传立即显示并按指定路径和草稿 revision 保存，不隐式发布', async () => {
    const view = await files();
    await upload(view);
    expect(view.text()).toContain('1.in');
    await view.find('input:not([type="file"])').setValue('testdata/custom.in');
    await view.findAll('button').find((button) => button.text() === '保存数据文件修改')!.trigger('click');
    await flushPromises();
    expect(api.oiSave).toHaveBeenCalledWith('school', '1001', 3, expect.any(FormData));
    const body = api.oiSave.mock.calls[0]![3] as FormData;
    expect(JSON.parse(String(body.get('metadata'))).upload_paths).toEqual(['testdata/custom.in']);
    expect(body.getAll('data_files')).toHaveLength(1);
    expect(view.findComponent(DomainOiFiles).emitted('saved')![0]![0]).toBe(4);
    expect(view.text()).not.toContain('1.in');
    expect(refresh).toHaveBeenCalled();
  });
  it('保存冲突保留所选文件及目标路径，可重新处理', async () => {
    api.oiSave.mockRejectedValue({ statusCode: 409, data: { error: '草稿已变化' } });
    const view = await files();
    await upload(view);
    await view.findAll('button').find((button) => button.text() === '保存数据文件修改')!.trigger('click');
    await flushPromises();
    expect(view.text()).toContain('本地文件修改保留');
    expect(view.text()).toContain('1.in');
    expect(view.findComponent(DomainOiFiles).emitted('saved')).toBeUndefined();
  });
});
