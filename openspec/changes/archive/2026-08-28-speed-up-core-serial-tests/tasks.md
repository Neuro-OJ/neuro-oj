## 1. PGlite 模板缓存

- [x] 1.1 在 `noj-core/.gitignore` 中添加 `.test-cache/` 忽略规则
- [x] 1.2 新增 `noj-core/scripts/prepare-pglite-template.ts`：构建 PGlite 实例并执行 `SCHEMA_DDL`、`SCHEMA_INDEXES` 和基础种子，导出模板到 `.test-cache/pglite-template-<hash>.tgz`
- [x] 1.3 在模板构建脚本中计算内容 hash（包含 `SCHEMA_DDL`、`SCHEMA_INDEXES`、种子相关源码和 `PGLITE_TEMPLATE_FORMAT`）
- [x] 1.4 修改 `noj-core/src/db/connection.ts`：PGlite 模式优先通过 `loadDataDir` 加载模板；模板缺失/过期时自动重建或回退到原 DDL 引导
- [x] 1.5 修改 `tests/_setup.ts` / `ensurePGliteSchemaForTest()`：基于模板加载后不再重复执行 DDL

## 2. 测试任务低 bcrypt cost

- [x] 2.1 在 `noj-core/deno.json` 的 `test` 任务中注入 `BCRYPT_SALT_ROUNDS=4`
- [x] 2.2 在 `noj-core/deno.json` 的 `test:watch` 任务中注入 `BCRYPT_SALT_ROUNDS=4`
- [x] 2.3 在 `noj-core/deno.json` 的 `test:pg` 任务中注入 `BCRYPT_SALT_ROUNDS=4`

## 3. 优化 resetDbForTest

- [x] 3.1 修改 `src/db/connection.ts` 的 postgres.js 模式：`resetDbForTest()` 不再关闭/重建连接池，复用现有连接执行 `TRUNCATE` + seed
- [x] 3.2 修改 PGlite 模式 `resetDbForTest()`：只执行 `TRUNCATE` + 轻量 seed，不重建 schema
- [x] 3.3 将 RBAC 种子参考表（角色/权限/系统设置）从默认 `TRUNCATE` 路径中排除，避免每次全量重播
- [x] 3.4 提供显式“深度重置”入口供 RBAC 专项测试使用（完整清空种子表）
- [x] 3.5 将 `user_rankings` 物化视图刷新改为按需触发，排名相关测试显式请求刷新

## 4. 减少固定等待

- [x] 4.1 优化 `tests/lib/revokedTokens.test.ts`：使用更短 TTL 和条件等待，去掉固定 1.5s sleep
- [x] 4.2 优化 `tests/routes/sse.test.ts`：使用更短超时或立即关闭/推送事件，减少真实等待
- [x] 4.3 检查 `tests/lib/loginThrottle.test.ts` 等重试等待，改为更短或条件等待

## 5. 验证与回归

- [x] 5.1 运行 `deno fmt --check` 和 `deno lint`，确保无格式/静态检查问题
- [x] 5.2 运行 `deno task test` 全量回归，确认测试全部通过
- [x] 5.3 记录优化前后 `deno task test` 总耗时，确认串行路径显著提速
- [x] 5.4 确认 `deno task test` 仍可在无外部 PostgreSQL 环境下运行（零依赖保持）
