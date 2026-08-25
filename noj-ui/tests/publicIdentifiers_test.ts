/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  problemUrl,
  publicUrl,
  userUrl,
} from '../utils/publicIdentifiers.ts';

Deno.test('publicIdentifiers: problemUrl 优先 display_id', () => {
  assertEquals(problemUrl('uuid', 'P100'), '/problems/P100');
  assertEquals(problemUrl('uuid'), '/problems/uuid');
});

Deno.test('publicIdentifiers: userUrl 使用 username', () => {
  assertEquals(userUrl('zhangsan'), '/users/zhangsan');
});

Deno.test('publicIdentifiers: publicUrl 生成各实体链接', () => {
  assertEquals(
    publicUrl('contest', 'ct-8f3k2xq'),
    '/contests/ct-8f3k2xq',
  );
  assertEquals(
    publicUrl('training', 'tr-9qx2lm'),
    '/trainings/tr-9qx2lm',
  );
  assertEquals(
    publicUrl('submission', 'sub-3fk9xq'),
    '/submissions/sub-3fk9xq',
  );
  assertEquals(
    publicUrl('post', 'post-7m2nq8'),
    '/community/posts/post-7m2nq8',
  );
  assertEquals(
    publicUrl('announcement', 'ann-4d6k9m'),
    '/announcements/ann-4d6k9m',
  );
});
