// deno-lint-ignore no-import-prefix -- 复用仓库既有断言依赖，不引入新版本。
import { assertEquals } from 'jsr:@std/assert@^1';
import { defaultProblemReference, defaultWorkspaceDestination } from '../utils/default-workspace.ts';
Deno.test('旧Public入口固定main，不从偏好或题库类型决定空间', () => {
  assertEquals(defaultWorkspaceDestination('/problems/'), { path: '/d/main/problems' });
  assertEquals(defaultWorkspaceDestination('/trainings'), { path: '/d/main/trainings' });
  assertEquals(defaultWorkspaceDestination('/contests/ct-one/ranking'), { path: '/d/main/contests/ct-one/ranking' });
  assertEquals(defaultWorkspaceDestination('/editor/P1001'), { problemRef: 'P1001', editor: false });
  assertEquals(defaultWorkspaceDestination('/problems/P1001/edit'), { problemRef: 'P1001', editor: true });
  assertEquals(defaultWorkspaceDestination('/problems/new/objective'), {
    path: '/d/main/problems/new',
    kind: 'objective',
  });
  assertEquals(defaultWorkspaceDestination('/d/school/problems/1001'), null);
});
Deno.test('旧P号只转数字，U题不能猜成默认域题，UUID需只读授权解析', () => {
  assertEquals(defaultProblemReference('P1001'), '1001');
  assertEquals(defaultProblemReference('1001'), '1001');
  assertEquals(defaultProblemReference('U1001'), null);
  assertEquals(defaultProblemReference('uuid'), null);
  assertEquals(defaultProblemReference('2147483648'), null);
  assertEquals(defaultWorkspaceDestination('/trainings/tr-one'), { trainingRef: 'tr-one' });
});
