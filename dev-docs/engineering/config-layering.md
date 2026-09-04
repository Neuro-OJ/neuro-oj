# NOJ 配置分层

NOJ 使用"环境模板 + 本地覆盖 + 校验 + 生命周期归属"的配置体系。每个配置项由
**统一注册表**（noj-core `src/shared/config/settings-registry.ts` 的
`CONFIG_DEFINITIONS`）声明 归属（scope）与 env 键名，消灭多份手写副本。

## 生命周期两分法（scope）

| scope                      | 存储                            | 读取链                      | 变更方式               | 后台                 |
| -------------------------- | ------------------------------- | --------------------------- | ---------------------- | -------------------- |
| **runtime**（DB-owned）    | DB `system_settings`            | `DB → env(仅兜底) → 默认值` | 管理后台写入，即时生效 | 可改、可重置         |
| **bootstrap**（env-owned） | env（.env / compose / secrets） | `env → 默认值`（不读 DB）   | 改 env + 重启 noj-core | 只读展示（含未配置） |

- runtime
  项示例：限流、社区开关、审核阈值、`allow_register`、`maintenance_mode`；
- bootstrap 项示例：`DATABASE_URL`/`JWT_SECRET`/`PORT` 等基础设施，以及
  storage/email/审计保留等"启动期定型"项（改后需重启，故归 env 单一事实源）；
- bootstrap 项在 DB 中的残留旧值**被忽略**（启动日志提示 +
  后台徽标），可一键清理。

## 配置来源分层

| 层         | 文件                                                     | 用途                                                   |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------ |
| 统一注册表 | `noj-core/src/shared/config/settings-registry.ts`                  | **单一事实源**：scope/type/默认值/secret/env 键名/分类 |
| 模块模板   | `noj-core/.env.example` / `noj-llm-gateway/.env.example` | 模块级环境变量说明（与注册表一致，由 check-env 校验）  |
| E2E 模板   | `env.e2e.template`                                       | 跨模块 E2E 固定测试配置                                |
| 本地覆盖   | `noj-core/.env` 等                                       | 开发者本地实际值，gitignored                           |
| 运行时配置 | DB `system_settings`（管理后台写入）                     | runtime 项的当前值                                     |

## 规则

1. **新配置项/新环境变量必须登记入注册表**（`CONFIG_DEFINITIONS`，声明 scope +
   envKey/envFallback + type + 分类），并同步 `.env.example`；
2. 生命周期划分：**运行时可热改 → runtime（DB）**；**启动期定型/基础设施 →
   bootstrap（env）**，禁止把启动期定型项做成 DB 可写；
3. bootstrap 项 env 键在注册表中唯一（`validateRegistry()` 启动校验，两个设置项
   不得共用一个 env 变量）；
4. 模板中禁止硬编码真实凭据；占位符应使用 `change-this-*` 等可被 `check-env.ts`
   识别的形式；
5. 生产部署必须显式注入 `JWT_SECRET`、`DATABASE_URL`、`TRUSTED_PROXIES`
   等关键变量。

### runtime env/DB 共存提示

- 当某个 runtime 项**同时存在 DB 写入值与 env 兜底**时，当前实际生效的是 DB 值，
  env 被遮蔽，容易造成“改了 .env 不生效”的歧义。
- noj-core 启动时会输出 warning，列出 `key (envKey)`，建议移除 `.env`
  中对应变量； 管理后台设置页进入时也会弹窗提示，并在 runtime 表格行上显示“env
  兜底存在”徽标。
- 该提示**不改变读取/写入行为**，仅用于提醒避免双源共存。

## 校验

```bash
cd noj-core
deno task check:env          # 基础校验（占位符 + 注册表↔.env.example 键覆盖一致性）
deno task check:env:strict   # 严格校验（本地开发用）
deno task check:prod         # 校验生产模板
```

`check-env` 的一致性检查：每个可见 bootstrap 键必须出现在 `.env.example`
（注释示例也算）；`.env.example` 中注册表未登记的键按孤儿警告（部署编排级键
白名单豁免）。
