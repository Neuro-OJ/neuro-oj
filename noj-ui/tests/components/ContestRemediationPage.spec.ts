import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense } from 'vue';
import Page from '~/pages/d/[slug]/classrooms/[classroomId]/contest-remediation.vue';
import type { ClassroomDetail, TeachingCapability } from '~/utils/education';
let capabilities: TeachingCapability[] = [];
beforeEach(() => {
  capabilities = [];
  for (const [name, value] of Object.entries({ computed, ref })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useState', () => ref({ id: 'assistant' }));
  vi.stubGlobal('useRoute', () => ({ params: { classroomId: 'class-one' } }));
  vi.stubGlobal(
    'useWorkspace',
    () => ({
      slug: ref('school'),
      domain: ref({ status: 'active', configuration: { features: { assignment: true, classroom: true } } }),
    }),
  );
  vi.stubGlobal(
    'useEducationApi',
    () => ({
      classroom: () =>
        Promise.resolve({
          data: {
            id: 'class-one',
            status: 'active',
            name: '班级',
            manages_domain: false,
            membership: { role: 'assistant', status: 'active' },
            capabilities,
          } as ClassroomDetail,
        }),
    }),
  );
  vi.stubGlobal(
    'useAsyncData',
    async (_key: unknown, loader: () => Promise<unknown>) => ({ data: ref(await loader()), error: ref(null) }),
  );
});
async function view() {
  const Wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Page) }) });
  const result = mount(Wrapper, {
    global: {
      stubs: {
        UButton: true,
        AdminPageHeader: true,
        UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
        ClientOnly: { template: '<div><slot /></div>' },
        ContestRemediationBuilder: { template: '<p>比赛候选管理</p>' },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('比赛补题页面能力', () => {
  it('只有作业管理助教不能读取班级成绩候选', async () => {
    capabilities = ['assignments:manage'];
    const result = await view();
    expect(result.text()).not.toContain('比赛候选管理');
    expect(result.text()).toContain('当前不能创建班级补题任务');
  });
  it('作业管理和学情读取齐备后显示候选管理；比赛读取仍由服务端授权', async () => {
    capabilities = ['assignments:manage', 'progress:read'];
    expect((await view()).text()).toContain('比赛候选管理');
  });
});
