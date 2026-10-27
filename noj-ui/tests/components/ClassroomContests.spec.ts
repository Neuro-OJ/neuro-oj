import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import ClassroomContests from '~/components/education/ClassroomContests.vue';
const list = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainContests', () => ({ list }));
  vi.stubGlobal('useAsyncData', async (key: { value: string }, read: () => Promise<unknown>) => {
    const data = ref(await read());
    watch(key, async () => data.value = await read());
    return { data, error: ref(null), status: ref('success'), refresh: vi.fn() };
  });
  list.mockResolvedValue({
    data: [{
      id: 'contest',
      title: '班级热身赛',
      status: 'running',
      start_time: '2026-10-27T00:00:00Z',
      end_time: '2026-10-28T00:00:00Z',
      classrooms: [{ id: 'room', name: '一班' }],
      problem_count: 1,
      participant_count: 2,
    }],
    pagination: { total: 21, total_pages: 2 },
  });
});
async function view(classroomId?: string) {
  const wrapper = mount(
    defineComponent({
      setup: () => () => h(Suspense, null, { default: () => h(ClassroomContests, { slug: 'school', classroomId }) }),
    }),
    {
      global: {
        stubs: {
          AsyncContent: { template: '<div><slot /></div>' },
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
          UButton: { template: '<button><slot /></button>' },
          UBadge: { template: '<span><slot /></span>' },
          UIcon: true,
          PaginationNav: {
            emits: ['page-change'],
            template: '<button @click="$emit(\'page-change\', 2)">下一页</button>',
          },
        },
      },
    },
  );
  await flushPromises();
  return wrapper;
}
describe('班级关联竞赛入口', () => {
  it('我的学习汇总本人班级，提供可进入的竞赛链接和独立分页', async () => {
    const wrapper = await view();
    expect(list).toHaveBeenCalledWith('school', 1, { classroom_id: undefined, my_classrooms: true });
    expect(wrapper.text()).toContain('进行中');
    expect(wrapper.text()).toContain('一班');
    expect(wrapper.get('a').attributes('href')).toBe('/d/school/contests/contest');
    await wrapper.findAll('button').find((b) => b.text() === '下一页')!.trigger('click');
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith('school', 2, { classroom_id: undefined, my_classrooms: true });
    wrapper.unmount();
  });
  it('班级概览仅查询当前班级，不误用本人学生身份筛选教师视角', async () => {
    const wrapper = await view('room');
    expect(list).toHaveBeenCalledWith('school', 1, { classroom_id: 'room', my_classrooms: false });
    expect(wrapper.text()).toContain('班级热身赛');
    wrapper.unmount();
  });
});
