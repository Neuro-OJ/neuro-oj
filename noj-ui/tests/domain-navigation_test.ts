// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { domainIdentityLabel, initialDomainSlug } from '../utils/domain-navigation.ts';
import type { WorkspaceSummary } from '../utils/workspace.ts';
const school = { slug: 'school' } as WorkspaceSummary;
Deno.test('根入口：公开实例进入指定默认域，私有单域实例进入成员域', () => {
  assertEquals(initialDomainSlug({ access: 'public', default_domain_slug: 'main' }, [school]), 'main');
  assertEquals(initialDomainSlug({ access: 'authenticated', default_domain_slug: 'main' }, [school]), 'school');
  assertEquals(initialDomainSlug({ access: 'authenticated', default_domain_slug: 'school' }, []), 'school');
  assertEquals(
    initialDomainSlug({ access: 'authenticated', default_domain_slug: 'main' }, [
      school,
      { slug: 'team' } as WorkspaceSummary,
    ]),
    'main',
  );
});
Deno.test('账号显示使用当前域 slug，不使用域展示名称', () => {
  assertEquals(domainIdentityLabel('sakura_madoromi', 'main'), 'sakura_madoromi@main');
  assertEquals(domainIdentityLabel('sakura_madoromi', 'school'), 'sakura_madoromi@school');
});
