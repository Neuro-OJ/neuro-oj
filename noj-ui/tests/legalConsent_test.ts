/**
 * 政策变更弹窗判定逻辑测试。
 *
 * 口径：只有 `needs_consent=true` 且 `is_material=true` 才弹窗；
 * 非重大修订与已同意状态均不弹。
 */
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { collectPendingConsents, type LegalStatusMap } from '../utils/legalConsent.ts';

Deno.test('legalConsent: 未登录（undefined）时不弹窗', () => {
  assertEquals(collectPendingConsents(undefined), []);
  assertEquals(collectPendingConsents(null), []);
});

Deno.test('legalConsent: 无需同意时不弹窗', () => {
  const legal: LegalStatusMap = {
    privacy: {
      required_version: 3,
      agreed_version: 3,
      needs_consent: false,
      is_material: true,
    },
  };
  assertEquals(collectPendingConsents(legal), []);
});

Deno.test('legalConsent: 非重大修订即使 needs_consent 也不弹窗', () => {
  const legal: LegalStatusMap = {
    privacy: {
      required_version: 3,
      agreed_version: 2,
      needs_consent: true,
      is_material: false,
    },
  };
  assertEquals(collectPendingConsents(legal), []);
});

Deno.test('legalConsent: 重大变更未同意时弹窗并带版本区间', () => {
  const legal: LegalStatusMap = {
    privacy: {
      required_version: 4,
      agreed_version: 2,
      needs_consent: true,
      is_material: true,
      change_summary: '新增第三方共享说明',
    },
    terms: {
      required_version: 1,
      agreed_version: 1,
      needs_consent: false,
      is_material: true,
    },
  };
  const pending = collectPendingConsents(legal);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].kind, 'privacy');
  assertEquals(pending[0].label, '隐私政策');
  assertEquals(pending[0].agreedVersion, 2);
  assertEquals(pending[0].requiredVersion, 4);
  // 变更摘要透传给弹窗
  assertEquals(pending[0].changeSummary, '新增第三方共享说明');
});

Deno.test('legalConsent: 无 change_summary 时为 null', () => {
  const legal: LegalStatusMap = {
    privacy: {
      required_version: 1,
      agreed_version: 0,
      needs_consent: true,
      is_material: true,
    },
  };
  assertEquals(collectPendingConsents(legal)[0].changeSummary, null);
});

Deno.test('legalConsent: 未知 kind 回退显示原 key', () => {
  const legal: LegalStatusMap = {
    cookies: {
      required_version: 1,
      agreed_version: 0,
      needs_consent: true,
      is_material: true,
    },
  };
  assertEquals(collectPendingConsents(legal)[0].label, 'cookies');
});
