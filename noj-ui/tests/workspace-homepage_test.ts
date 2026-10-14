// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { workspaceHomepagePath } from '../utils/workspace-homepage.ts';
import type { WorkspaceDetail } from '../utils/workspace.ts';
const space: WorkspaceDetail = {
  id: 'school',
  slug: 'school',
  name: '学校',
  description: '',
  status: 'active',
  owner_id: 'owner',
  preset: 'education',
  revision: 3,
  actor_id: 'teacher',
  is_member: true,
  platform_admin: false,
  permissions: ['classroom:create'],
  configuration: {
    access: 'members',
    discoverable: false,
    join_policy: 'invite',
    features: { community: true, classroom: true, assignment: true, analytics: true },
    homepage: 'teaching',
  },
};
Deno.test('域首页：教学人员进入工作台，未授予教学能力的学生保留概览', () => {
  assertEquals(workspaceHomepagePath(space), '/d/school/teaching');
  assertEquals(workspaceHomepagePath({ ...space, permissions: [] }), null);
  assertEquals(workspaceHomepagePath({ ...space, actor_id: null, is_member: false, permissions: [] }), null);
});
Deno.test('域首页：公开社区和题单使用当前域，概览不重定向', () => {
  assertEquals(
    workspaceHomepagePath({ ...space, configuration: { ...space.configuration, homepage: 'community' } }),
    '/d/school/community',
  );
  assertEquals(
    workspaceHomepagePath({
      ...space,
      actor_id: null,
      is_member: false,
      configuration: { ...space.configuration, access: 'public', homepage: 'community' },
    }),
    '/d/school/community',
  );
  assertEquals(
    workspaceHomepagePath({ ...space, configuration: { ...space.configuration, homepage: 'training' } }),
    '/d/school/trainings',
  );
  assertEquals(
    workspaceHomepagePath({ ...space, configuration: { ...space.configuration, homepage: 'overview' } }),
    null,
  );
});
Deno.test('域首页：模块关闭不进入关闭入口，归档仅按已有授权导航，暂停留治理概览', () => {
  assertEquals(
    workspaceHomepagePath({
      ...space,
      configuration: { ...space.configuration, features: { ...space.configuration.features, assignment: false } },
    }),
    null,
  );
  assertEquals(workspaceHomepagePath({ ...space, status: 'archived' }), '/d/school/teaching');
  assertEquals(workspaceHomepagePath({ ...space, status: 'suspended', platform_admin: true }), null);
});
Deno.test('域首页：未加入的账号保留加入入口，不因公开首页丢失申请表单', () => {
  assertEquals(
    workspaceHomepagePath({
      ...space,
      is_member: false,
      configuration: { ...space.configuration, access: 'public', join_policy: 'open', homepage: 'community' },
    }),
    null,
  );
});
