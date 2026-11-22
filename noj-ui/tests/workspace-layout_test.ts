// deno-lint-ignore no-import-prefix -- 复用仓库既有断言依赖，不引入新版本。
import { assertEquals } from 'jsr:@std/assert@^1';
import { resolveWorkspaceWidth, WORKSPACE_WIDTH_MAP } from '../utils/workspace-layout.ts';

Deno.test('resolveWorkspaceWidth: 返回已命名宽度规格', () => {
  assertEquals(resolveWorkspaceWidth({ workspaceWidth: 'home' }), WORKSPACE_WIDTH_MAP.home);
  assertEquals(resolveWorkspaceWidth({ workspaceWidth: 'library' }), WORKSPACE_WIDTH_MAP.library);
  assertEquals(resolveWorkspaceWidth({ workspaceWidth: 'problem' }), WORKSPACE_WIDTH_MAP.problem);
  assertEquals(resolveWorkspaceWidth({ workspaceWidth: 'workspace' }), WORKSPACE_WIDTH_MAP.workspace);
});

Deno.test('resolveWorkspaceWidth: 兼容 problemWorkspace 与默认值回退', () => {
  assertEquals(resolveWorkspaceWidth({ problemWorkspace: true }), WORKSPACE_WIDTH_MAP.workspace);
  assertEquals(resolveWorkspaceWidth({}), WORKSPACE_WIDTH_MAP.default);
  assertEquals(resolveWorkspaceWidth(undefined), WORKSPACE_WIDTH_MAP.default);
});
