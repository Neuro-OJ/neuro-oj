import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, ref, watch } from 'vue';
import AnnotationPanel from '~/components/annotation/AnnotationPanel.vue';
import type { AnnotationDetail, AnnotationSource } from '~/utils/annotations';

const actor = ref({ id: 'teacher' });
const api = { detail: vi.fn(), read: vi.fn(), edit: vi.fn(), source: vi.fn(), create: vi.fn(), original: vi.fn() };
const source: AnnotationSource = {
  target: { kind: 'submission', submission_id: 'submission', file_name: 'main.py' },
  content_hash: 'hash',
  blocks: [{ id: 'file', text: 'print(1)', start_line: 1 }],
  href: '/d/school/submissions/submission',
};
const detail = {
  id: 'note',
  owner_id: 'teacher',
  visibility: 'private',
  revision: 7,
  target: source.target,
  author: { id: 'teacher', username: '教练' },
  anchor: { block_id: 'file', start: 0, end: 8, quote: 'print(1)', before: '', after: '', start_line: 1, end_line: 1 },
  content_hash: 'hash',
  href: source.href,
  source_changed: false,
  can_reply: false,
  page: 1,
  per_page: 50,
  total: 1,
  messages: [{
    id: 'message',
    author_id: 'teacher',
    author: { id: 'teacher', username: '教练' },
    body: '旧反馈',
    revision: 7,
    withdrawn_at: null,
    created_at: '2026-10-19T00:00:00Z',
  }],
} as AnnotationDetail;
const stubs = {
  USlideover: { props: ['open'], template: '<section v-if="open"><slot name="body" /></section>' },
  UButton: {
    props: ['type', 'disabled'],
    template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
  },
  UTextarea: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  USelect: { props: ['modelValue'], template: '<select :value="modelValue" />' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  UBadge: { template: '<span><slot /></span>' },
  UserIdentity: { props: ['user'], template: '<span>{{ user.username }}</span>' },
  MarkdownRenderer: { props: ['content'], template: '<p>{{ content }}</p>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  actor.value = { id: 'teacher' };
  for (const [name, value] of Object.entries({ computed, ref, watch, nextTick })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: actor }));
  vi.stubGlobal('useAnnotationsApi', () => api);
  vi.stubGlobal(
    'useOptionalWorkspace',
    () => ({ domain: ref({ status: 'active', preset: 'education', role: 'coach' }) }),
  );
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true) } }));
  vi.stubGlobal('usePolling', vi.fn());
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  api.detail.mockImplementation(() =>
    actor.value.id === 'teacher'
      ? Promise.resolve({ data: detail })
      : Promise.reject({ statusCode: 404, data: { error: '无权读取' } })
  );
  api.edit.mockResolvedValue({ data: detail });
  api.create.mockResolvedValue({ data: detail });
  api.source.mockResolvedValue({ data: source });
});
function panel(threadId?: string) {
  return mount(AnnotationPanel, {
    props: { open: true, slug: 'school', threadId, target: source.target, selectedText: 'print(1)' },
    global: { stubs },
  });
}
describe('统一批注面板', () => {
  it('同一账号重新打开后已收到撤权响应，更早的成功请求也不能恢复原文', async () => {
    let resolve!: (value: { data: AnnotationSource }) => void;
    api.source.mockReturnValueOnce(new Promise(value => { resolve = value; }));
    const view = panel(); await flushPromises();
    await view.setProps({ open: false });
    api.source.mockRejectedValueOnce({ statusCode: 404, data: { error: '原文已撤权' } });
    await view.setProps({ open: true }); await flushPromises();
    resolve({ data: { ...source, blocks: [{ id: 'file', text: '失权前的私密原文', start_line: 1 }] } });
    await flushPromises();
    expect(view.text()).not.toContain('失权前的私密原文');
    expect(view.find('textarea').exists()).toBe(false);
    view.unmount();
  });
  it('原文有重复句子时不替用户选择首个位置，明确确认后才允许保存', async () => {
    const target = { kind: 'problem' as const, reference: '1001', field: 'description' };
    api.source.mockResolvedValue({ data: { ...source, target, blocks: [
      { id: 'block:0', text: '重复句子。', start_line: 1 },
      { id: 'block:1', text: '重复句子。', start_line: 3 },
    ] } });
    const view = mount(AnnotationPanel, { props: { open: true, slug: 'school', target, selectedText: '重复句子。' }, global: { stubs } });
    await flushPromises();
    await view.find('textarea').setValue('需要确认具体位置');
    expect(view.find('button[type="submit"]').attributes('disabled')).toBeDefined();
    await view.findAll('button').find(button => button.text() === '按整段批注')!.trigger('click');
    expect(view.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
    view.unmount();
  });
  it('同一账号资料刷新保留编辑，换账号立即清空上一账号的草稿和正文', async () => {
    const view = panel('note');
    await flushPromises();
    await view.findAll('button').find((button) => button.text() === '修改')!.trigger('click');
    await view.find('textarea').setValue('尚未保存的批注');
    actor.value = { id: 'teacher' };
    await flushPromises();
    expect(view.find('textarea').element.value).toBe('尚未保存的批注');
    actor.value = { id: 'another-teacher' };
    await flushPromises();
    expect(view.find('textarea').exists()).toBe(false);
    expect(view.text()).not.toContain('旧反馈');
    view.unmount();
  });
  it('修改绑定明确域、原会话、消息及服务器 revision', async () => {
    const view = panel('note');
    await flushPromises();
    await view.findAll('button').find((button) => button.text() === '修改')!.trigger('click');
    await view.find('textarea').setValue('修改反馈');
    await view.find('form').trigger('submit');
    await flushPromises();
    expect(api.edit).toHaveBeenCalledWith('school', 'note', 'message', 7, '修改反馈');
    expect(view.emitted('changed')).toHaveLength(1);
    view.unmount();
  });
  it('教学域内新建也默认私密，不自动发送给学生或教师组', async () => {
    const view = panel();
    await flushPromises();
    await view.find('textarea').setValue('私人教学备忘');
    await view.find('form').trigger('submit');
    await flushPromises();
    expect(api.create).toHaveBeenCalledWith(
      'school',
      expect.objectContaining({
        visibility: 'private',
        body: '私人教学备忘',
        content_hash: 'hash',
        anchor: { block_id: 'file', start: 0, end: 8 },
      }),
      expect.any(String),
    );
    view.unmount();
  });
  it('完整原文请求晚于账号切换返回时，不展示旧账号快照', async () => {
    let resolve!: (value: { data: AnnotationSource }) => void;
    api.original.mockReturnValue(
      new Promise((value) => {
        resolve = value;
      }),
    );
    const view = panel('note');
    await flushPromises();
    await view.findAll('button').find((button) => button.text() === '查看完整原文')!.trigger('click');
    actor.value = { id: 'another-teacher' };
    await flushPromises();
    resolve({
      data: {
        ...source,
        content: '上一账号私密快照',
        blocks: [{ id: 'file', text: '上一账号私密快照', start_line: 1 }],
      },
    });
    await flushPromises();
    expect(view.text()).not.toContain('上一账号私密快照');
    expect(view.text()).not.toContain('旧反馈');
    view.unmount();
  });
});
