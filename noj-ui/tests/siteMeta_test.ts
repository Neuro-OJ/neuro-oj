/**
 * 页脚备案展示逻辑测试。
 *
 * 对应 PIPL/运营合规设计：未配置备案不渲染；配置后按类型生成链接，
 * 缺省链接回退到官方查询页。
 */
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { buildFilingLinks, buildThirdPartyList, EMPTY_SITE_META } from '../utils/siteMeta.ts';

Deno.test('siteMeta: 未配置备案时不生成任何链接', () => {
  assertEquals(buildFilingLinks(EMPTY_SITE_META), []);
});

Deno.test('siteMeta: 仅 ICP 时只生成 ICP 链接（缺省官方查询页）', () => {
  const links = buildFilingLinks({
    ...EMPTY_SITE_META,
    icp_number: '京ICP备00000000号',
  });
  assertEquals(links.length, 1);
  assertEquals(links[0].label, '京ICP备00000000号');
  assertEquals(links[0].url, 'https://beian.miit.gov.cn/');
});

Deno.test('siteMeta: ICP + 公安备案时两个链接且用自定义 url', () => {
  const links = buildFilingLinks({
    ...EMPTY_SITE_META,
    icp_number: '京ICP备00000000号',
    icp_url: 'https://custom.icp/',
    police_number: '京公网安备11000000000000号',
    police_url: 'https://custom.police/',
  });
  assertEquals(links.length, 2);
  assertEquals(links[0].url, 'https://custom.icp/');
  assertEquals(links[1].url, 'https://custom.police/');
});

Deno.test('siteMeta: 第三方清单解析合法 JSON', () => {
  const list = buildThirdPartyList(
    JSON.stringify([
      { name: 'LLM Provider', purpose: '评测', data: 'prompt' },
      { name: '内容审核', purpose: '合规' },
    ]),
  );
  assertEquals(list.length, 2);
  assertEquals(list[0].name, 'LLM Provider');
  assertEquals(list[0].purpose, '评测');
  assertEquals(list[1].name, '内容审核');
});

Deno.test('siteMeta: 第三方清单为空/非法/非数组时返回空数组', () => {
  assertEquals(buildThirdPartyList(''), []);
  assertEquals(buildThirdPartyList('   '), []);
  assertEquals(buildThirdPartyList('not-json'), []);
  assertEquals(buildThirdPartyList('{"a":1}'), []);
  // 缺 name 的条目被过滤
  assertEquals(buildThirdPartyList(JSON.stringify([{ purpose: 'x' }])), []);
});
