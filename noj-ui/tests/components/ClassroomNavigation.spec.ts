import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, reactive, ref } from 'vue';
import ClassroomNavigation from '~/components/education/ClassroomNavigation.vue';
import type { ClassroomDetail, TeachingCapability } from '~/utils/domain/education/education';

const route = reactive({ path: '/d/school/classrooms/class-one' });
const knowledgeDisabled = ref(false);
beforeEach(() => {
  knowledgeDisabled.value = false;
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useKnowledge', () => ({ disabled: knowledgeDisabled }));
  route.path = '/d/school/classrooms/class-one';
});

function view(role: 'educator' | 'student', capabilities: TeachingCapability[] = []) {
  return mount(ClassroomNavigation, {
    props: {
      slug: 'school',
      classroomId: 'class-one',
      classroom: {
        id: 'class-one',
        manages_domain: role === 'educator',
        membership: role === 'student' ? { role, status: 'active' } : null,
        capabilities,
      } as ClassroomDetail,
    },
    global: {
      stubs: {
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        UIcon: true,
      },
    },
  });
}

describe('班级页面导航', () => {
  it('学生可查看同班名单，不展示教学管理入口', () => {
    const result = view('student');
    expect(result.findAll('a').map((link) => link.text())).toEqual(['我的班级', '班级概览', '班级成员']);
    expect(result.find('[aria-current="page"]').attributes('href')).toBe('/d/school/classrooms/class-one');
    result.unmount();
  });

  it('域教练无需班级成员关系即可查看全部教学入口，并高亮合并后的班级成员页', async () => {
    const result = view('educator');
    expect(result.findAll('a').map((link) => link.text())).toEqual([
      '我的班级',
      '班级概览',
      '班级成员',
      '知识点掌握',
      '班级设置',
    ]);
    route.path = '/d/school/classrooms/class-one/students/student-one';
    await result.vm.$nextTick();
    expect(result.find('[aria-current="location"]').attributes('href')).toBe('/d/school/classrooms/class-one/members');
    expect(result.find('[aria-current="page"]').exists()).toBe(false);
    result.unmount();
  });

  it('教练的导航保持域上下文，所有入口均为实际页面', () => {
    const result = view('educator');
    expect(result.findAll('a').map((link) => link.text())).toEqual([
      '我的班级',
      '班级概览',
      '班级成员',
      '知识点掌握',
      '班级设置',
    ]);
    for (const link of result.findAll('a')) {
      expect(link.attributes('href')).toMatch(
        /^\/d\/school\/classrooms(?:\/class-one(?:\/(?:members|knowledge|settings))?)?$/,
      );
    }
    result.unmount();
  });

  it('知识点掌握入口仅教练可见（学生不展示）', () => {
    const result = view('student');
    expect(result.findAll('a').map((link) => link.text())).not.toContain('知识点掌握');
    result.unmount();
  });

  it('知识追踪开关关闭时对教练也隐藏知识点掌握入口', () => {
    knowledgeDisabled.value = true;
    const result = view('educator');
    expect(result.findAll('a').map((link) => link.text())).not.toContain('知识点掌握');
    result.unmount();
  });

  it('班级权限尚未加载时不短暂展示管理入口', async () => {
    const result = view('educator');
    await result.setProps({ classroom: undefined });
    expect(result.findAll('a').map((link) => link.text())).toEqual(['我的班级', '班级概览']);
    result.unmount();
  });
});
