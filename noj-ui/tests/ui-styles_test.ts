// deno-lint-ignore no-import-prefix -- 复用仓库既有断言依赖，不引入新版本。
import { assertEquals } from 'jsr:@std/assert@^1';
import { DEFAULT_UI_STYLE, normalizeUiStyle, UI_STYLES } from '../utils/ui-styles.ts';

Deno.test('normalizeUiStyle: 已知风格原样返回', () => {
  for (const style of UI_STYLES) assertEquals(normalizeUiStyle(style.value), style.value);
});

Deno.test('normalizeUiStyle: 未知值与非字符串回退默认深色终端', () => {
  assertEquals(DEFAULT_UI_STYLE, 'terminal');
  assertEquals(normalizeUiStyle('"><script>'), 'terminal');
  assertEquals(normalizeUiStyle(undefined), 'terminal');
  assertEquals(normalizeUiStyle(42), 'terminal');
});
