/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@^1';
import { matchBreadcrumbRoute, resolveBreadcrumb } from '../utils/breadcrumb.ts';

Deno.test('breadcrumb: 未匹配的路径返回空层级（管理后台与认证页不参与）', () => {
  assertEquals(resolveBreadcrumb('/admin/problems'), []);
  assertEquals(resolveBreadcrumb('/login'), []);
  assertEquals(resolveBreadcrumb('/forgot-password'), []);
  assertEquals(resolveBreadcrumb('/nonexistent/path/here'), []);
});

Deno.test('breadcrumb: 一级内容页只有当前层且不可点击', () => {
  const items = resolveBreadcrumb('/problems');
  assertEquals(items.length, 1);
  assertEquals(items[0].label, '题库');
  assertEquals(items[0].to, undefined);
});

Deno.test('breadcrumb: 三层路径逐层可回跳，末层不可点击', () => {
  const items = resolveBreadcrumb('/contests/c1/problems/A');
  assertEquals(items.length, 3);
  assertEquals(items[0].label, '竞赛');
  assertEquals(items[0].to, '/contests');
  assertEquals(items[1].to, '/contests/c1');
  assertEquals(items[2].to, undefined);
});

Deno.test('breadcrumb: 动态段用参数占位而非裸 UUID 标签', () => {
  const items = resolveBreadcrumb('/problems/1001');
  assertEquals(items[1].label, '1001');
  const edit = resolveBreadcrumb('/problems/1001/edit');
  assertEquals(edit.length, 3);
  assertEquals(edit[2].label, '编辑');
  assertEquals(edit[2].to, undefined);
});

Deno.test('breadcrumb: 除末层外每层都有可点击目标', () => {
  for (const path of ['/problems/1001/edit', '/contests/c1/ranking', '/trainings/t1', '/community/reports/r1']) {
    const items = resolveBreadcrumb(path);
    assertNotEquals(items.length, 0, path);
    for (const item of items.slice(0, -1)) {
      assertNotEquals(item.to, undefined, `${path} -> ${item.label}`);
      assertNotEquals(item.to, '', `${path} -> ${item.label}`);
    }
  }
});

Deno.test('breadcrumb: 英文语言输出英文层级', () => {
  const items = resolveBreadcrumb('/problems/1001', 'en-US');
  assertEquals(items[0].label, 'Problems');
  assertEquals(resolveBreadcrumb('/contests', 'en-US')[0].label, 'Contests');
});

Deno.test('breadcrumb: 忽略查询串与尾斜杠', () => {
  assertEquals(resolveBreadcrumb('/problems/1001?tab=x').length, 2);
  assertEquals(resolveBreadcrumb('/problems/').length, 1);
  assertEquals(resolveBreadcrumb('/submissions/s1').length, 2);
});

Deno.test('breadcrumb: 匹配结果携带路由模式与参数，供页面精化文案', () => {
  const match = matchBreadcrumbRoute('/contests/c1/problems/A');
  assertNotEquals(match, null);
  assertEquals(match?.pattern, '/contests/:contestId/problems/:label');
  assertEquals(match?.params.contestId, 'c1');
  assertEquals(match?.params.label, 'A');
});

Deno.test('breadcrumb: 静态段优先于动态段匹配', () => {
  // /trainings/mine 必须命中静态注册，而不是 /trainings/:id
  const items = resolveBreadcrumb('/trainings/mine');
  assertEquals(items.length, 2);
  assertEquals(items[1].label, '我的题单');
  assertEquals(matchBreadcrumbRoute('/trainings/mine')?.pattern, '/trainings/mine');
});
