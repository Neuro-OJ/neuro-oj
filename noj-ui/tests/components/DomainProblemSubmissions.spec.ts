import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense } from 'vue';
import Submissions from '~/components/problem/DomainProblemSubmissions.vue';

const list = vi.fn();
let actor: ReturnType<typeof ref<{ id: string; username: string } | null>>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('computed', computed);
  actor = ref({ id: 'student-id', username: 'student' });
  vi.stubGlobal('useAuth', () => ({ user: actor }));
  vi.stubGlobal('useDomainSubmissions', () => ({ list }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, read: () => Promise<unknown>) => ({
    data: ref(await read()),
    status: ref('success'),
    error: ref(null),
    refresh: vi.fn(),
  }));
});

async function render() {
  const view = mount(
    defineComponent({
      setup: () => () =>
        h(Suspense, null, { default: () => h(Submissions, { slug: 'school', problemId: 'source-problem' }) }),
    }),
    {
      global: {
        stubs: {
          NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' },
          UButton: { template: '<button><slot /></button>' },
        },
      },
    },
  );
  await flushPromises();
  return view;
}

describe('题目详情的本人提交摘要', () => {
  it('仅查询当前域本人记录，保密结果即使带分数也不展示', async () => {
    list.mockResolvedValue({
      data: [{
        id: 'submission',
        kind: 'submission',
        result_visibility: 'hidden',
        result: { status: 'finished', score: 9600 },
        created_at: '2026-10-17T00:00:00Z',
      }],
    });
    const view = await render();
    expect(list).toHaveBeenCalledWith('school', 1, { problem_id: 'source-problem', username: 'student', per_page: 5 });
    expect(view.text()).toContain('结果暂不公开');
    expect(view.text()).not.toContain('96.0');
    expect(view.findAll('a').map((a) => a.attributes('href'))).toContain('/d/school/submissions/submission');
    view.unmount();
  });
  it('游客不查询提交，不显示伪造的空作答记录', async () => {
    actor.value = null;
    const view = await render();
    expect(list).not.toHaveBeenCalled();
    expect(view.text()).toContain('登录后查看本题的提交记录');
    view.unmount();
  });
});
