/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from 'jsr:@std/assert@^1';
import type { WorkspaceDetail } from '../utils/workspace.ts';
import { workspaceNavigation } from '../utils/workspace-navigation.ts';
import { workspaceSettingsNavigation } from '../utils/workspace-settings.ts';
const base = {
  slug: 'school',
  actor_id: 'same-user',
  permissions: [],
  configuration: { features: { classroom: true, assignment: true, community: false, analytics: true } },
} as unknown as WorkspaceDetail;
Deno.test('空间导航：相同用户不同域角色只显示该域能力，所有入口保留目标域', () => {
  const student = workspaceNavigation(base);
  assert(student.some((item) => item.section === 'classrooms'));
  assert(!student.some((item) => item.section === 'llm'));
  const teacher = workspaceNavigation({
    ...base,
    slug: 'other-school',
    permissions: ['classroom:create', 'llm:manage'],
  });
  assert(teacher.some((item) => item.section === 'classrooms'));
  assert(!teacher.some((item) => item.section === 'llm'));
  assertEquals(
    workspaceSettingsNavigation({ ...base, slug: 'other-school', permissions: ['llm:manage'] }).map((item) => item.to),
    ['/d/other-school/settings/llm', '/d/other-school/settings/llm/quotas', '/d/other-school/settings/llm/usage'],
  );
  assert(teacher.every((item) => item.to.startsWith('/d/other-school')));
});

Deno.test('域设置导航：默认域与其他域共用管理入口，成员无设置入口', () => {
  assertEquals(workspaceSettingsNavigation(base), []);
  for (const slug of ['main', 'school']) {
    const entries = workspaceSettingsNavigation({
      ...base,
      slug,
      permissions: ['domain:settings', 'domain:members', 'domain:limits'],
    });
    assert(entries.some((item) => item.to === `/d/${slug}/settings/carousel`));
    assert(entries.some((item) => item.to === `/d/${slug}/settings/announcements`));
    assert(entries.every((item) => item.to.startsWith(`/d/${slug}/`)));
  }
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
  assertEquals(disabled.find((item) => item.section === 'submissions')?.label, '提交');
  assert(disabled.some((item) => item.section === 'queue'));
  assertEquals(disabled.find((item) => item.section === 'queue')?.to, '/d/school/queue');
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
