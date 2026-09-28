/** utils/contestRanking.ts 单元测试（VULN-09：封榜期只返回本人一行时的展示语义）。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  FROZEN_LOGIN_HINT,
  FROZEN_SELF_ONLY_HINT,
  frozenAccessHint,
  isFrozenSelfOnly,
} from '../utils/contestRanking.ts';

Deno.test('isFrozenSelfOnly: 仅"封榜 + 非管理员实时榜"判定为只显示本人', () => {
  assertEquals(isFrozenSelfOnly('frozen', false), true);
  // admin_live 为缺省/undefined 时同样按"仅本人"处理（即便后端是旧版本）
  assertEquals(isFrozenSelfOnly('frozen', undefined), true);
  // 管理员实时完整榜不属于"仅本人"
  assertEquals(isFrozenSelfOnly('frozen', true), false);
  // 非封榜期：live 是完整榜（或按权限可见的榜），official 是正式成绩版本
  assertEquals(isFrozenSelfOnly('live', false), false);
  assertEquals(isFrozenSelfOnly('official', false), false);
  assertEquals(isFrozenSelfOnly(undefined, false), false);
  assertEquals(isFrozenSelfOnly(null, false), false);
});

Deno.test('frozenAccessHint: 401/403 降级为引导文案，其余状态交回普通错误展示', () => {
  assertEquals(frozenAccessHint(401), FROZEN_LOGIN_HINT);
  assertEquals(frozenAccessHint(403), FROZEN_SELF_ONLY_HINT);
  // 404/500 等不是"封榜不可见"，不能被伪装成提示（否则会掩盖真实故障）
  assertEquals(frozenAccessHint(404), null);
  assertEquals(frozenAccessHint(500), null);
  assertEquals(frozenAccessHint(undefined), null);
  assertEquals(frozenAccessHint(null), null);
});
