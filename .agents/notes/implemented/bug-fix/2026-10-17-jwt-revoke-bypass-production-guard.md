# Agent Note: JWT 撤销旁路开关的生产环境护栏

Status: implemented

## Problem

`isJtiRevoked` 中保留了一个测试短路开关 `NOJ_BYPASS_JWT_REVOKE`：只要值为 `"1"`
就直接返回 `false`，跳过 Redis 撤销查询。代码注释以「生产环境永不设置该变量」
为前提，但没有任何代码强制。一旦生产部署误设该变量（例如从测试环境复制配置），
logout、改密、封禁、角色降级签发的全部撤销都会静默失效——被撤销的 token 在
自然过期前仍可继续访问，且没有任何告警。

## Decision

- 启动期硬约束：`findProductionConfigErrors` 在 `NOJ_ENV === "production"` 且
  `NOJ_BYPASS_JWT_REVOKE` 为 `"1"` 时追加一条 finding，沿用既有 fail-fast
  机制（`assertProductionConfig` 抛错 → `main.ts` 记录日志并 `Deno.exit(1)`）。
  `ProductionConfig` 新增 `bypassJwtRevoke` 字段，由 `buildProductionConfig`
  从环境变量读取。
- 运行时纵深防御：`isJtiRevoked` 仅在 `NOJ_ENV !== "production"` 时认可该开关。
  即使启动期校验被绕过（如直接调用模块、测试注入），生产环境也不会短路， 继续走
  Redis 查询并保持 fail-closed。
- 配置注册表同步描述：明确该键只在测试环境生效，生产环境设置后拒绝启动。
- 新增测试：生产配置校验拒绝该组合；运行时生产环境忽略开关（Redis 不可用时 仍抛
  503），非生产环境允许短路。

## Alternatives considered

- 直接删除 `NOJ_BYPASS_JWT_REVOKE`：会破坏 `initRedisForTest` 等测试 helper 与
  多个测试文件的既有用法，改动面远超本次修复。
- 只在运行时加判断：启动阶段不会失败，运维无法从日志发现误配置，问题会被
  静默吞掉。
- 启动期只打 warning 不退出：与项目既有的生产配置 fail-fast 风格不一致，
  且撤销失效属于安全边界，不能带病运行。

## Consequences

- 生产环境误设 `NOJ_BYPASS_JWT_REVOKE=1` 将无法启动，需显式移除该变量；
  这是有意的破坏性行为，避免撤销机制被静默关闭。
- 非生产环境（`test`、`development`、未设置 `NOJ_ENV`）行为不变，测试 helper
  无需修改。
- `ProductionConfig` 新增可选字段，现有调用方与测试构造器不受影响。
