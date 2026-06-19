# noj-core — Neuro OJ 核心后端

基于 **Deno + Hono** 的 RESTful API 服务端。

## 职责

- 提供 RESTful API 供 noj-ui 调用
- 用户认证与授权
- 题目管理（CRUD）
- 提交管理（接收代码提交）
- 通过 Redis MQ 向 noj-judge 分发评测任务（Producer）
- 接收评测结果并持久化

## 技术栈

| 组件 | 选择 |
|------|------|
| 运行时 | Deno |
| 语言 | TypeScript |
| Web 框架 | Hono |
| 数据库 | 待定（PostgreSQL / SQLite） |
| 消息队列 | Redis (Producer) |
| 部署 | Deno Deploy / Docker |

## 目录约定

```
noj-core/
├── deno.json          # 项目配置 & 导入映射
├── src/
│   ├── main.ts        # 入口
│   ├── app.ts         # Hono 应用工厂
│   ├── mod.ts         # 公共导出
│   ├── routes/        # 路由（一个文件一个资源）
│   ├── middleware/     # 中间件（auth、cors、logger 等）
│   ├── models/        # 数据模型 / ORM
│   ├── services/      # 业务逻辑层
│   ├── mq/            # Redis 消息队列生产者
│   └── types/         # 类型定义
└── tests/             # 测试文件（与 src 镜像结构）
```

## 编码规范

- 使用 TypeScript 严格模式
- 路由文件默认导出 Hono 实例，由 `app.ts` 组合
- API 路径遵循 RESTful：`/api/v1/{resource}`
- 使用 `deno fmt` 格式化代码
- 使用 `deno lint` 检查代码
- 使用 `deno test` 运行测试
- 环境变量通过 `Deno.env.get()` 读取
- 错误处理：统一 JSON 错误响应格式

### 示例路由

```ts
import { Hono } from "hono";

const router = new Hono();

router.get("/", (c) => c.json({ items: [] }));
router.post("/", async (c) => {
  const body = await c.req.json();
  return c.json({ created: body }, 201);
});

export default router;
```

## Redis MQ 约定

- 评测任务队列：`noj:judge:queue`（LPUSH / BRPOP）
- 评测结果通道：`noj:judge:results:{submissionId}`
- 使用连接池管理 Redis 连接

## 贡献要求

- **所有提交必须 GPG 签名**（参见根目录 README.md 配置步骤）
- **仅通过 PR 贡献**，禁止直接推送到 main
- 提交信息遵循 Conventional Commits（`feat(core): ...` / `fix(core): ...`）

## 相关文档

- [Hono 文档](https://hono.dev/)
- [Deno 文档](https://docs.deno.com/)
