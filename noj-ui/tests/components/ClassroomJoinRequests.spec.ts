import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import ClassroomJoinRequests from '~/components/education/ClassroomJoinRequests.vue';

const mockDialog = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const mockEducation = vi.hoisted(() => ({
  joinRequests: vi.fn(),
  reviewJoin: vi.fn(),
}));

vi.mock('~/composables/useDialog', () => ({ useDialog: () => ({ dialog: mockDialog }) }));

const stubs = {
  UIcon: { template: '<span class="icon" />' },
  UBadge: { template: '<span><slot /></span>' },
  UAlert: { props: ['title'], template: '<div class="alert">{{ title }}</div>' },
  AdminFormField: { props: ['label'], template: '<div><label>{{ label }}</label><slot /></div>' },
  USelect: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="it in items" :key="it.value" :value="it.value">{{ it.label }}</option></select>',
  },
  UCheckbox: {
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
  UButton: {
    props: ['disabled', 'loading'],
    template: '<button :disabled="disabled || loading"><slot /></button>',
  },
  AsyncContent: {
    props: ['status'],
    template: '<div><slot /></div>',
  },
};

const fakeRequestsData = {
  data: {
    total: 2,
    data: [
      {
        id: 'req-1',
        user_id: 'u-1',
        username: 'alice',
        reason: '想参加 NOIP 训练',
        status: 'pending',
        created_at: '2026-10-17T08:00:00Z',
      },
      {
        id: 'req-2',
        user_id: 'u-2',
        username: 'bob',
        reason: '算法基础良好',
        status: 'pending',
        created_at: '2026-10-17T08:30:00Z',
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useState', () => ref({ id: 'coach-1' }));
  vi.stubGlobal('useDialog', () => ({ dialog: mockDialog }));
  vi.stubGlobal('useEducationApi', () => mockEducation);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({
    slug: 'edu-domain',
    isCurrent: () => true,
  }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, handler: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await handler();
        error.value = null;
      } catch (e) {
        error.value = e;
      }
    };
    await refresh();
    return { data, error, status: ref('success'), refresh };
  });

  mockEducation.joinRequests.mockResolvedValue(fakeRequestsData);
  mockEducation.reviewJoin.mockResolvedValue({ id: 'ok' });
});

describe('components/education/ClassroomJoinRequests.vue', () => {
  it('正确展示待审核申请，并向父级触发 pendingCount 事件', async () => {
    let emittedPending = -1;
    const Wrapper = defineComponent({
      setup: () => () =>
        h(Suspense, null, {
          default: () =>
            h(ClassroomJoinRequests, {
              slug: 'edu-domain',
              classroomId: 'room-1',
              revision: 3,
              writable: true,
              onPendingCount: (c: number) => {
                emittedPending = c;
              },
            }),
        }),
    });

    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();

    expect(view.text()).toContain('入班申请管理');
    expect(view.text()).toContain('alice');
    expect(view.text()).toContain('想参加 NOIP 训练');
    expect(view.text()).toContain('bob');
    expect(emittedPending).toBe(2);

    view.unmount();
  });

  it('支持一键全部批准当前页，并调用 reviewJoin 审核所有待审核申请', async () => {
    let changedTriggered = false;
    const Wrapper = defineComponent({
      setup: () => () =>
        h(Suspense, null, {
          default: () =>
            h(ClassroomJoinRequests, {
              slug: 'edu-domain',
              classroomId: 'room-1',
              revision: 5,
              writable: true,
              onChanged: () => {
                changedTriggered = true;
              },
            }),
        }),
    });

    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();

    // 找到 "一键全部批准当前页 (2)" 按钮
    const allApproveBtn = view.findAll('button').find((b) => b.text().includes('一键全部批准当前页'));
    expect(allApproveBtn).toBeDefined();

    await allApproveBtn!.trigger('click');
    await flushPromises();

    expect(mockEducation.reviewJoin).toHaveBeenCalledTimes(2);
    expect(mockEducation.reviewJoin).toHaveBeenCalledWith(
      'edu-domain',
      'room-1',
      'req-1',
      'approve',
      5,
      expect.stringContaining('review:req-1:approve'),
    );
    expect(mockEducation.reviewJoin).toHaveBeenCalledWith(
      'edu-domain',
      'room-1',
      'req-2',
      'approve',
      5,
      expect.stringContaining('review:req-2:approve'),
    );
    expect(changedTriggered).toBe(true);

    view.unmount();
  });

  it('支持单条批准申请', async () => {
    const Wrapper = defineComponent({
      setup: () => () =>
        h(Suspense, null, {
          default: () =>
            h(ClassroomJoinRequests, {
              slug: 'edu-domain',
              classroomId: 'room-1',
              revision: 2,
              writable: true,
            }),
        }),
    });

    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();

    const singleApproveBtns = view.findAll('button').filter((b) => b.text() === '批准为学生');
    expect(singleApproveBtns.length).toBe(2);

    await singleApproveBtns[0].trigger('click');
    await flushPromises();

    expect(mockEducation.reviewJoin).toHaveBeenCalledTimes(1);
    expect(mockEducation.reviewJoin).toHaveBeenCalledWith(
      'edu-domain',
      'room-1',
      'req-1',
      'approve',
      2,
      expect.stringContaining('review:req-1:approve:2'),
    );

    view.unmount();
  });
});
