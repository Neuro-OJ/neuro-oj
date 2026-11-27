// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { translate } from '../../utils/i18n.ts';
import { resolvePageTitle } from '../../utils/page-title.ts';

Deno.test('resolvePageTitle：覆盖顶层路由与动态详情页', () => {
  assertEquals(resolvePageTitle('/', translate), '首页 - Neuro OJ');
  assertEquals(resolvePageTitle('/login', translate), '登录 - Neuro OJ');
  assertEquals(resolvePageTitle('/settings', translate), '账号设置 - Neuro OJ');
  assertEquals(resolvePageTitle('/users/alice', translate), '用户主页 - Neuro OJ');
  assertEquals(resolvePageTitle('/legal/privacy/', translate), '隐私政策 - Neuro OJ');
  assertEquals(resolvePageTitle('/unknown-path', translate), 'Neuro OJ');
});

Deno.test('resolvePageTitle：覆盖 /d/:slug 多域工作空间子路由', () => {
  assertEquals(resolvePageTitle('/d/main', translate), '首页 - Neuro OJ');
  assertEquals(resolvePageTitle('/d/main/problems/1001?tab=desc', translate), '题库 - Neuro OJ');
  assertEquals(resolvePageTitle('/d/class-a/assignments/42', translate), '作业 - Neuro OJ');
  assertEquals(resolvePageTitle('/d/class-a/classrooms/7/members', translate), '班级 - Neuro OJ');
  assertEquals(resolvePageTitle('/d/main/editor/P1001', translate), '题目编辑器 - Neuro OJ');
  assertEquals(resolvePageTitle('/d/main/settings/limits', translate), '设置 - Neuro OJ');
  assertEquals(resolvePageTitle('/d/main/unknown-section', translate), 'Neuro OJ');
});

Deno.test('resolvePageTitle：覆盖 /admin 管理后台子路由', () => {
  assertEquals(resolvePageTitle('/admin', translate), '管理后台 - Neuro OJ');
  assertEquals(resolvePageTitle('/admin/settings', translate), '系统设置 - 管理后台 - Neuro OJ');
  assertEquals(resolvePageTitle('/admin/instance/domains', translate), '实例治理 - 管理后台 - Neuro OJ');
  assertEquals(resolvePageTitle('/admin/users', translate), '用户管理 - 管理后台 - Neuro OJ');
});
