/**
 * 轮播渐变预设测试。
 *
 * 未知/空 key 回退默认渐变，避免空 class 或崩溃。
 */
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { CAROUSEL_GRADIENTS, DEFAULT_GRADIENT, gradientClass } from '../utils/carouselGradient.ts';

Deno.test('carouselGradient: 已知 key 返回对应渐变', () => {
  assertEquals(gradientClass('blue'), CAROUSEL_GRADIENTS.blue);
  assertEquals(gradientClass('green'), CAROUSEL_GRADIENTS.green);
});

Deno.test('carouselGradient: 空/未知 key 回退默认', () => {
  assertEquals(gradientClass(null), DEFAULT_GRADIENT);
  assertEquals(gradientClass(undefined), DEFAULT_GRADIENT);
  assertEquals(gradientClass(''), DEFAULT_GRADIENT);
  assertEquals(gradientClass('bogus'), DEFAULT_GRADIENT);
});
