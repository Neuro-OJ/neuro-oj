/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { domainSearchHref } from '../utils/domain-search.ts';
import type { SearchItem } from '../utils/search-types.ts';
Deno.test('域搜索：同号来源题始终在使用域引用上下文中定位', () => {
  const item: SearchItem = {
    entity_type: 'problem',
    entity_id: 'p',
    title: '源题',
    highlight: '',
    rank: 1,
    metadata: { number: 1001, display_id: 'P1001', reference: { display_ref: 'main:1001' } },
  };
  assertEquals(domainSearchHref('school', item), '/d/school/problems/main:1001');
});
Deno.test('域搜索：不以旧索引题号猜测目标域题号，比赛仍携带目标域', () => {
  assertEquals(
    domainSearchHref(
      'school',
      {
        entity_type: 'problem',
        entity_id: 'p',
        title: '旧索引题',
        highlight: '',
        rank: 1,
        metadata: { number: 1001, display_id: 'P1001' },
      },
    ),
    undefined,
  );
  assertEquals(
    domainSearchHref('school', {
      entity_type: 'contest',
      entity_id: 'c1',
      title: '域比赛',
      highlight: '',
      rank: 1,
      metadata: {},
    }),
    '/d/school/contests/c1',
  );
});

Deno.test('域公告搜索的阅读链接保留使用域，即使内容来自实例', () => {
  assertEquals(
    domainSearchHref('school', {
      entity_type: 'announcement',
      entity_id: 'notice',
      title: '通知',
      highlight: '',
      rank: 1,
      metadata: { public_id: 'n123' },
    }),
    '/d/school/announcements/n123',
  );
});
