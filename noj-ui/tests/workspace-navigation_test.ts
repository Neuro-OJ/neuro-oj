/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from 'jsr:@std/assert@^1';
import type { WorkspaceDetail } from '../utils/workspace.ts';
import { workspaceNavigation } from '../utils/workspace-navigation.ts';
const base = {
  slug: 'school',
  actor_id: 'same-user',
  permissions: [],
  configuration: { features: { classroom: true, assignment: true, community: false, analytics: true } },
} as unknown as WorkspaceDetail;
Deno.test('空间导航：相同用户不同域角色只显示该域能力，所有入口保留目标域', () => {
  const student = workspaceNavigation(base);
  assert(student.some((item) => item.section === 'my-learning'));
  assert(!student.some((item) => item.section === 'llm'));
  const teacher = workspaceNavigation({
    ...base,
    slug: 'other-school',
    permissions: ['classroom:create', 'llm:manage'],
  });
  assert(teacher.some((item) => item.section === 'teaching'));
  assert(teacher.some((item) => item.section === 'llm'));
  assert(teacher.every((item) => item.to.startsWith('/d/other-school')));
});
Deno.test('空间导航：匿名仅公开入口，关闭教学模块不显示新增教学入口', () => {
  assertEquals(workspaceNavigation({ ...base, actor_id: null }).map((item) => item.section), [
    '',
    'problems',
    'trainings',
    'contests',
    'rankings',
    'search',
  ]);
  const disabled = workspaceNavigation({
    ...base,
    configuration: {
      ...base.configuration,
      features: { ...base.configuration.features, classroom: false, assignment: false, analytics: false },
    },
  });
  assert(!disabled.some((item) => ['classrooms', 'my-learning', 'teaching'].includes(item.section)));
  assert(disabled.some((item) => item.section === 'submissions'));
  assert(!disabled.some((item) => item.section === 'rankings'));
});
Deno.test('社区导航由当前域开关决定，入口保留当前域', () => {
  assert(!workspaceNavigation(base).some((item) => item.section === 'community'));
  const enabled = workspaceNavigation({
    ...base,
    configuration: {
      ...base.configuration,
      features: { ...base.configuration.features, community: true },
    },
  });
  assertEquals(enabled.find((item) => item.section === 'community')?.to, '/d/school/community');
});
