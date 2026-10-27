import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense, watch } from 'vue';
import SettingsPage from '~/pages/d/[slug]/classrooms/[classroomId]/settings.vue';
import AsyncContent from '~/components/ui/AsyncContent.vue';

const education = { classroom: vi.fn(), members: vi.fn(), updateClassroom: vi.fn() };
const classroom = {
  id: 'room-one',
  domain_id: 'school-id',
  name: '算法训练班',
  description: '每周练习',
  stage_tag: '提高组',
  status: 'active',
  revision: 3,
  manages_domain: true,
  membership: null,
  capabilities: [],
};
let roomStatus = 'success';
let roomData: { data: typeof classroom } | null;

beforeEach(() => {
  vi.clearAllMocks();
  roomData = { data: { ...classroom } };
  roomStatus = 'success';
  for (const [name, value] of Object.entries({ computed, reactive, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => ({ params: { classroomId: 'room-one' } }));
  vi.stubGlobal('useState', () => ref({ id: 'coach' }));
  vi.stubGlobal('useWorkspace', () => ({
    slug: ref('school'),
    domain: ref({ id: 'school-id', status: 'active', configuration: { features: { classroom: true } } }),
  }));
  vi.stubGlobal('useEducationApi', () => education);
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm: vi.fn() } }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, handler: () => Promise<unknown>) => {
    const data = ref(await handler());
    return {
      data,
      status: ref(roomStatus),
      error: ref(null),
      refresh: async () => {
        data.value = await handler();
      },
    };
  });
  education.classroom.mockImplementation(() => Promise.resolve(roomData));
  education.members.mockResolvedValue({ data: [] });
  education.updateClassroom.mockResolvedValue({ data: classroom });
});

async function view() {
  const Wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(SettingsPage) }) });
  const result = mount(Wrapper, {
    global: {
      components: { AsyncContent },
      stubs: {
        ClassroomNavigation: true,
        LibraryPageHeader: true,
        UIcon: true,
        UCard: { template: '<section><slot name="header" /><slot /></section>' },
        AdminFormField: { props: ['label'], template: '<div><span>{{ label }}</span><slot /></div>' },
        UAlert: { props: ['title'], template: '<p role="alert">{{ title }}</p>' },
        UButton: {
          props: ['disabled', 'type'],
          template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
        },
        UInput: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        UTextarea: { props: ['modelValue'], template: '<textarea :value="modelValue" />' },
        USelect: { props: ['disabled'], template: '<select :disabled="disabled" />' },
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
  });
  await flushPromises();
  return result;
}

describe('班级设置反馈', () => {
  it('保存后提供确认，再次编辑时清除旧成功提示', async () => {
    const result = await view();
    await result.find('[aria-label="班级名称"]').setValue('更新后的训练班');
    await result.find('form').trigger('submit');
    await flushPromises();
    expect(education.updateClassroom).toHaveBeenCalledWith('school', 'room-one', {
      name: '更新后的训练班',
      description: '每周练习',
      stage_tag: '提高组',
    }, 3);
    expect(result.text()).toContain('班级设置已保存');
    await result.find('[aria-label="班级名称"]').setValue('继续编辑');
    expect(result.text()).not.toContain('班级设置已保存');
    result.unmount();
  });

  it('保存冲突保留输入并显示服务端错误，不宣称已保存', async () => {
    education.updateClassroom.mockRejectedValue({ data: { error: '班级已由其他教练修改，请重新读取' }, status: 409 });
    const result = await view();
    await result.find('[aria-label="班级名称"]').setValue('保留我的修改');
    await result.find('form').trigger('submit');
    await flushPromises();
    expect((result.find('[aria-label="班级名称"]').element as HTMLInputElement).value).toBe('保留我的修改');
    expect(result.text()).toContain('班级已由其他教练修改');
    expect(result.text()).not.toContain('班级设置已保存');
    result.unmount();
  });

  it('教练管理归属域，不显示主教练交接表单', async () => {
    const result = await view();
    expect(result.find('select').exists()).toBe(false);
    expect(result.text()).not.toContain('接任');
    expect(result.find('form').exists()).toBe(true);
    result.unmount();
  });

  it('班级数据仍在加载时显示加载状态，不闪现无权修改提示', async () => {
    roomStatus = 'pending';
    roomData = null;
    const result = await view();
    expect(result.text()).toContain('加载中');
    expect(result.text()).not.toContain('无权修改');
    result.unmount();
  });
});
