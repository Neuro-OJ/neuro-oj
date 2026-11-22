import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
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
  it('复制来源目录使用 /copy-sources 并携带分页与过滤参数', async () => {
    const get = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 20, total: 0 });
    vi.stubGlobal('useApi', () => ({ api: { get } }));
    const resources = resourcesApi();
    await resources.copySources('school', 'training', 2, 'main', 'dp');
    expect(get).toHaveBeenCalledWith('/api/v1/domains/school/copy-sources', {
      query: { kind: 'training', page: 2, limit: 20, source_slug: 'main', keyword: 'dp' },
      silent: true,
    });
    // 旧共享接口已删除：组合式函数不再暴露 sharing/share。
    expect('sharing' in resources).toBe(false);
    expect('share' in resources).toBe(false);
  });
  it('编辑题单保留发布状态、本域题号及原revision，冲突保留题单输入', async () => {
    api.save.mockRejectedValue({ statusCode: 409, data: { error: '题单已变化' } });
    const initial = {
      id: 't1',
      revision: 3,
      title: '原题单',
      description: '说明',
      visibility: 'private',
      state: 'published',
      items: [{ display_ref: 'main:1001' }],
    } as DomainTrainingDetail;
    const view = mount(DomainTrainingEditor, { props: { slug: 'school', initial }, global: { stubs } });
    await view.find('input').setValue('修改题单');
    await view.find('form').trigger('submit');
    await flushPromises();
    expect(api.save).toHaveBeenCalledWith('school', {
      title: '修改题单',
      description: '说明',
      visibility: 'private',
      state: 'published',
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
