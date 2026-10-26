import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import DomainSharingForm from '~/components/feature/DomainSharingForm.vue';
import DomainTrainingEditor from '~/components/feature/DomainTrainingEditor.vue';
import type { DomainTrainingDetail } from '~/composables/useDomainTrainings';
import { useDomainResources as resourcesApi } from '~/composables/useDomainResources';
const api = { share: vi.fn(), save: vi.fn() };
const input = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  AdminFormField: { template: '<div><slot /></div>' },
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UInput: input,
  UTextarea: input,
  USelect: { props: ['modelValue'], template: '<select />' },
  UCheckbox: { template: '<div />' },
  MarkdownEditor: { template: '<div />' },
  DomainProblemChooser: { template: '<div />' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useDomainResources', () => api);
  vi.stubGlobal('useDomainTrainings', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true) } }));
  vi.stubGlobal('onBeforeRouteLeave', vi.fn());
  api.share.mockResolvedValue({ data: { revision: 8 } });
  api.save.mockResolvedValue({ data: { id: 't1', revision: 4 } });
});
describe('域资源配置', () => {
  it('限定共享发送目标slug并独立使用共享revision，冲突保留当前配置', async () => {
    api.share.mockRejectedValue({ statusCode: 409, data: { error: '共享政策已变化' } });
    const view = mount(DomainSharingForm, {
      props: {
        slug: 'school',
        kind: 'problem',
        reference: '1001',
        writable: true,
        initial: {
          enabled: true,
          scope: 'selected',
          target_domains: [{ id: 'target', slug: 'school-two', name: '学校二' }],
          revision: 7,
        },
      },
      global: { stubs },
    });
    await view.find('input').setValue('school-three');
    await view.findAll('button').find((button) => button.text() === '添加目标域')!.trigger('click');
    await view.findAll('button').find((button) => button.text() === '保存共享政策')!.trigger('click');
    await flushPromises();
    expect(api.share).toHaveBeenCalledWith('school', 'problem', '1001', {
      enabled: true,
      scope: 'selected',
      target_domain_slugs: ['school-two', 'school-three'],
    }, 7);
    expect(view.text()).toContain('当前共享配置保留');
    expect(view.text()).toContain('school-three');
  });
  it('编辑题单保留展示范围、来源题号及原revision，冲突保留题单输入', async () => {
    api.save.mockRejectedValue({ statusCode: 409, data: { error: '题单已变化' } });
    const initial = {
      id: 't1',
      revision: 3,
      title: '原题单',
      description: '说明',
      visibility: 'unlisted',
      items: [{ display_ref: 'main:1001' }],
    } as DomainTrainingDetail;
    const view = mount(DomainTrainingEditor, { props: { slug: 'school', initial }, global: { stubs } });
    await view.find('input').setValue('修改题单');
    await view.find('form').trigger('submit');
    await flushPromises();
    expect(api.save).toHaveBeenCalledWith('school', {
      title: '修改题单',
      description: '说明',
      visibility: 'unlisted',
      problems: ['main:1001'],
    }, { id: 't1', revision: 3 });
    expect(view.find('input').element.value).toBe('修改题单');
    expect(view.text()).toContain('当前编辑内容保留');
  });
  it('策略和上下架调用在使用域路径携带各自原If-Match', async () => {
    const put = vi.fn(), post = vi.fn();
    vi.stubGlobal('useApi', () => ({ api: { put, post } }));
    const resources = resourcesApi();
    await resources.policy('school', 'main:1001', 5, { mode: 'exact', version_id: 'source-v1' }, '统一教学版本');
    await resources.state('school', 'main:1001', 6, { disabled: true, visibility: 'members', reason: '暂停练习' });
    expect(put).toHaveBeenCalledWith('/api/v1/domains/school/problems/main%3A1001/policy', {
      policy: { mode: 'exact', version_id: 'source-v1' },
      reason: '统一教学版本',
    }, { headers: { 'If-Match': '5' } });
    expect(post).toHaveBeenCalledWith(
      '/api/v1/domains/school/problems/main%3A1001/state',
      expect.objectContaining({ disabled: true }),
      { headers: { 'If-Match': '6' } },
    );
  });
});
