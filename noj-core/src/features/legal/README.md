# legal — 法律文档 / 同意 / 数据请求（PIPL 合规）

发布隐私政策与服务条款的版本，记录用户同意（重大版本触发重新同意），受理用户的
删除/更正请求，并提供 `/admin/legal` 管理端发布与处置。

| 文件                                               | 职责                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `index.ts`                                         | 唯一对外出口：`feature` 声明 + 供 access/http 使用的函数与类型    |
| `routes.ts`                                        | 组合各子路由；`/admin/legal/*` 显式挂 `authMiddleware`            |
| `documents-routes.ts`                              | `/api/v1/legal/documents*`（公开只读）                            |
| `consent-routes.ts`                                | `POST /api/v1/legal/consent`                                      |
| `data-requests-routes.ts`                          | `GET/POST /api/v1/legal/data-requests`（用户自己的请求）          |
| `admin-routes.ts`                                  | `/api/v1/admin/legal/*`，处理器内检查 `legal:manage` 与审计       |
| `documents.ts` / `consent.ts` / `data-requests.ts` | 服务层                                                            |
| `types.ts`                                         | `LegalKind`、快照类型                                             |
| `tests/`                                           | 路由与服务测试；运行 `cd noj-core && deno task test:domain legal` |

关键约束：

- 表 `legal_documents` / `user_consents` / `data_requests` 定义在
  `src/shared/db/schema/legal.ts`，不随功能迁移。
- `/admin/legal` 已不在 admin 聚合的 `FINE_GRAINED_ADMIN_PREFIXES` 中；鉴权由
  `routes.ts` 挂载，细粒度权限检查（`legal:manage`）保留在 `admin-routes.ts`。
- 外部使用方：`modules/access`（注册写入同意、`/auth/me` 的 legal 状态）经本目录
  `index.ts` 引用。
