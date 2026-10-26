import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref, watch } from 'vue';
import ClassroomImport from '~/components/education/ClassroomImport.vue';
import type { ClassroomImportPreview } from '~/utils/education-enrollment';
const api = { previewImport: vi.fn(), executeImport: vi.fn() };
let current = true;
const preview: ClassroomImportPreview = {
  revision: 7,
  preview_hash: 'facts-hash',
  summary: { total: 2, join: 0, invite: 1, skipped: 0, errors: 1 },
  rows: [{
    row: 2,
    email: 'student@example.com',
    username: '',
    matched_username: null,
    user_id: null,
    action: 'invite',
    invitation_ids: [],
  }, {
    row: 3,
    email: 'invalid',
    username: '',
    matched_username: null,
    user_id: null,
    action: 'error',
    error: '邮箱格式错误',
    invitation_ids: [],
  }],
};
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UAlert: { props: ['title', 'description'], template: '<p>{{ title }} {{ description }}</p>' },
  UInput: { template: '<input />' },
  UTextarea: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UCheckbox: { template: '<input type="checkbox" />' },
  UButton: { props: ['loading', 'disabled'], template: '<button :disabled="loading || disabled"><slot /></button>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  current = true;
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('useState', () => ref({ id: 'teacher' }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => current }));
  api.previewImport.mockResolvedValue({ data: preview });
});
const button = (view: ReturnType<typeof mount>, label: string) =>
  view.findAll('button').find((b) => b.text() === label)!;
describe('CSV 预览与执行', () => {
  it('先显示逐行错误，执行和网络重试保留同一预览事实、版本及幂等键', async () => {
    const view = mount(ClassroomImport, {
      props: { slug: 'school', classroomId: 'class', writable: true },
      global: { stubs },
    });
    const csv = 'email\nstudent@example.com\ninvalid';
    await view.get('textarea').setValue(csv);
    await button(view, '预览导入').trigger('click');
    await flushPromises();
    expect(view.text()).toContain('邮箱格式错误');
    expect(view.text()).toContain('错误行不会执行');
    api.executeImport.mockRejectedValueOnce(new Error('网络中断'));
    await button(view, '执行已预览的有效行').trigger('click');
    await flushPromises();
    api.executeImport.mockResolvedValue({ data: { rows: preview.rows, summary: preview.summary, replayed: true } });
    await button(view, '执行已预览的有效行').trigger('click');
    await flushPromises();
    expect(api.executeImport.mock.calls[0]).toEqual(api.executeImport.mock.calls[1]);
    expect(api.executeImport.mock.calls[0]?.slice(0, 4)).toEqual(['school', 'class', {
      csv,
      replace_pending: false,
      preview_hash: 'facts-hash',
    }, 7]);
    expect(view.text()).toContain('邀请令牌只在首次响应提供');
    view.unmount();
  });
  it('修改 CSV 后丢弃旧预览，不允许继续执行旧匹配', async () => {
    const view = mount(ClassroomImport, {
      props: { slug: 'school', classroomId: 'class', writable: true },
      global: { stubs },
    });
    await view.get('textarea').setValue('email\nstudent@example.com');
    await button(view, '预览导入').trigger('click');
    await flushPromises();
    expect(view.findAll('button').some((b) => b.text() === '执行已预览的有效行')).toBe(true);
    await view.get('textarea').setValue('email\nother@example.com');
    expect(view.findAll('button').some((b) => b.text() === '执行已预览的有效行')).toBe(false);
    expect(api.executeImport).not.toHaveBeenCalled();
    view.unmount();
  });
  it('预览响应期间切换身份，不把旧空间的匹配结果应用到页面', async () => {
    const view = mount(ClassroomImport, {
      props: { slug: 'school', classroomId: 'class', writable: true },
      global: { stubs },
    });
    let resolve!: (value: unknown) => void;
    api.previewImport.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await view.get('textarea').setValue('email\nstudent@example.com');
    await button(view, '预览导入').trigger('click');
    current = false;
    resolve({ data: preview });
    await flushPromises();
    expect(view.find('table').exists()).toBe(false);
    expect(api.executeImport).not.toHaveBeenCalled();
    view.unmount();
  });
});
