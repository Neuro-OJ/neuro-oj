# CLI 初始化（dev-setup 与各子命令）

## 管理 CLI

`noj-core/scripts/noj.ts` 是统一的命令行入口（Cliffy 框架），取代了早期的
`seed.ts` / `build-packages.ts` 脚本。所有管理操作通过子命令完成：

```bash
cd noj-core
deno task db:migrate          # 数据库迁移（= noj db migrate）
deno task init:system         # 系统基础数据：root + RBAC + 镜像白名单 + 分类（= noj init system）
deno task bootstrap:admin     # 管理员引导（= noj bootstrap admin）
deno task problems:build      # 构建统一题目包（= noj problems build）
deno task problems:import     # 批量导入统一题目包（= noj problems import）
deno task dev-setup           # 开发环境一键初始化（= noj dev-setup）
```

`deno task noj --help`（或任一子命令 `--help`）可查看完整用法。

## dev-setup 做什么

`dev-setup` 按顺序执行：

1. `db migrate` — 数据库迁移
2. `init system` — root 用户、RBAC 预置角色、评测镜像白名单、示例分类
3. `bootstrap admin` — 管理员引导
4. `problems build` — 从 `data/problems-src/<id>/` 构建统一题目包到 `data/packages/`
5. `problems import` — 扫描 `data/packages/*.zip` 走统一导入（幂等 upsert）

最后额外填充 **dev 专用数据**：E2E 守卫测试用户（`NOJ_RUN_E2E=1` 时）。

> dev-setup 面向开发、测试和首次初始化。**生产环境**请按需执行
> `db:migrate` → `init:system` → `bootstrap:admin` → `problems:build` →
> `problems:import`（正式统一题目包），不要执行 dev-setup 的 dev 数据部分。

## 管理员初始化

`bootstrap admin` 支持环境变量或 CLI 参数：

```bash
# 环境变量（推荐）
ADMIN_EMAIL=admin@example.com ADMIN_PASS='...' deno task bootstrap:admin

# 或 CLI 参数
deno task bootstrap:admin -- --email admin@example.com --password '...'
```

- 设置了 `ADMIN_EMAIL` / `ADMIN_PASS`：创建或提升对应管理员，强制首次登录后修改密码。
- 未设置：在无任何可登录管理员时创建临时引导管理员（`admin@noj.local`，随机密码打印到终端）。

## 样例题同步

`data/problems-src/` 中的 1001–1003 样例题通过 `problems:build` + `problems:import`
同步（manifest 带固定 `number`，id 一律由服务端生成 UUID；重复导入按
(type, number) 幂等更新，不会产生重复题目）。

正式出题建议：在 Web 管理界面创建题目，或打包统一题目包（见"出题人"文档）
后通过管理界面上传 / `problems:import` 导入。
