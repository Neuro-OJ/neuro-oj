import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref, watch } from 'vue';
import AssignmentActions from '~/components/education/AssignmentActions.vue';
import type { AssignmentDetail } from '~/utils/education';
const api = { publish: vi.fn(), schedule: vi.fn(), lifecycle: vi.fn() }, confirm = vi.fn();
let current = true;
beforeEach(() => {
  vi.clearAllMocks();
  current = true;
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => current }));
});
const task = () => reactive({ id: 'task', state: 'draft', revision: 7 } as AssignmentDetail);
const stubs = {
  UButton: { template: '<button><slot /></button>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  UModal: { template: '<div />' },
};
describe('作业发布确认', () => {
  it('确认期间切换域或账号时不发送旧发布请求', async () => {
    const view = mount(AssignmentActions, {
      props: { slug: 'school', task: task(), writable: true },
      global: { stubs },
    });
    let resolve!: (value: boolean) => void;
    confirm.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await view.findAll('button').find((b) => b.text() === '发布作业')!.trigger('click');
    current = false;
    resolve(true);
    await flushPromises();
    expect(api.publish).not.toHaveBeenCalled();
    view.unmount();
  });
  it('确认期间版本变化仍使用原发布依据，冲突不伪装成已发布', async () => {
    const model = task(),
      view = mount(AssignmentActions, { props: { slug: 'school', task: model, writable: true }, global: { stubs } });
    let resolve!: (value: boolean) => void;
    confirm.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    api.publish.mockRejectedValue({ statusCode: 409, data: { error: '作业已变化', code: 'REVISION_CONFLICT' } });
    await view.findAll('button').find((b) => b.text() === '发布作业')!.trigger('click');
    model.revision = 8;
    resolve(true);
    await flushPromises();
    expect(api.publish).toHaveBeenCalledWith('school', 'task', 7, 'publish:task:7');
    expect(view.emitted('changed')).toBeUndefined();
    expect(view.text()).toContain('作业已变化');
    view.unmount();
  });
});
