// deno-lint-ignore no-import-prefix -- 复用仓库既有断言依赖，不引入新版本。
import { assertEquals } from 'jsr:@std/assert@^1';
import { DEFAULT_SITE_THEME, normalizeSiteTheme, SITE_THEMES } from '../utils/site-theme.ts';

Deno.test('site-theme：已知主题原样返回', () => {
  for (const theme of SITE_THEMES) assertEquals(normalizeSiteTheme(theme), theme);
});

Deno.test('site-theme：未知或非字符串值回退默认深色', () => {
  assertEquals(DEFAULT_SITE_THEME, 'dark');
  for (const value of [undefined, null, '', 'modern', 'DARK', 1, {}]) {
    assertEquals(normalizeSiteTheme(value), 'dark');
  }
});
