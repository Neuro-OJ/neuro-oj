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

| 组件     | 选择                        |
| -------- | --------------------------- |
| 运行时   | Deno                        |
| 语言     | TypeScript                  |
| Web 框架 | Hono                        |
| 数据库   | PostgreSQL 16 + postgres.js |
| 消息队列 | Redis (Producer)            |
| 部署     | Deno Deploy / Docker        |

## 目录约定

```
noj-core/
├── deno.json          # 项目配置 & 导入映射
├── src/
│   ├── main.ts        # 入口
│   ├── app.ts         # Hono 应用工厂
│   ├── mod.ts         # 公共导出
│   ├── routes/        # 路由（一个文件一个资源）
│   ├── db/            # 数据库连接 & ORM schema（Drizzle + PostgreSQL）
│   ├── middleware/     # 中间件（auth、cors、logger 等）
│   ├── models/        # 数据模型 / ORM
│   ├── services/      # 业务逻辑层
│   ├── mq/            # Redis 消息队列生产者
│   └── types/         # 类型定义
└── tests/             # 测试文件（与 src 镜像结构）
```

## 题目数据管理

```
data/
├── problems-src/<id>/      # 题目源文件（版本控制，仅限样例题/开发测试用）
│   ├── evaluate.py         #   评测脚本（评判入口）
│   ├── hidden.jsonl        #   隐藏测试用例
│   ├── visible.jsonl       #   可见测试用例
│   ├── submission.py       #   示例解法
│   └── README.md           #   题目描述
└── packages/<id>.zip       # 构建产物（gitignored）
    ↑ `deno task build-packages` 从 problems-src 打包生成
```

**⚠️ 重要约束：此目录仅用于样例题和开发测试。**

`problems-src/` 中的题目文件会被打包为 support package（zip），通过
`support_package_path` 字段写入数据库，noj-judge
在评测时拉取。当前目录下存放的是样例题 **1001 T0-LMCC**，目的是：

1. **降低贡献门槛** — 新人 clone 后直接 `deno task setup` 就能跑通全流程
2. **CI 可复现** — 流水线无需外部依赖即可验证评测流程
3. **方便本地调试** — 修改评测脚本后即时验证

**正式比赛题目（包括其隐藏测试数据、评测脚本）不得提交到此 git 仓库。**
正式题目应通过管理 API 或独立的安全通道部署，其 `support_package_path`
指向受控存储（MinIO/S3 等），确保评测材料和隐藏数据不公开。

### 开发流程

```bash
# 一键初始化样例题
deno task setup              # build-packages → seed

# 分步
deno task build-packages     # problems-src → packages/<id>.zip
deno task seed               # 写入数据库
```

## 提交与评测流程

```
用户提交 submission.py
       │
       ▼
noj-core 组装 JudgeTask（含 code + support_package_path）
       │
       ▼  Redis MQ
noj-judge 拉取任务
       │
       ├─ 1. 读取 support_package.zip
       │     evaluate.py, hidden.jsonl, visible.jsonl, README.md
       ├─ 2. 将用户代码写入 submission.py（覆盖/补全）
       ├─ 3. Docker 容器中执行 evaluate.py
       └─ 4. 返回评分结果 → Redis MQ → noj-core 持久化
```

关键点：

- **支持包不包含 submission.py** — 用户提交的代码由 noj-judge 在运行时放入
- **支持包包含评测脚本 evaluate.py** — 负责读取测试用例、调用用户代码、计算得分
- **支持包包含测试用例** —
  `visible.jsonl`（可见，可公开）、`hidden.jsonl`（隐藏，仅存在于 zip/受控存储）
- **评测命令为题目自定义** — 通过 `judge_command` 字段指定，不一定是 evaluate.py

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
- 评测结果通道：`noj:judge:results`
- 使用连接池管理 Redis 连接

## 贡献要求

- **所有提交必须 GPG 签名**（参见根目录 README.md 配置步骤）
- **仅通过 PR 贡献**，禁止直接推送到 main
- 提交信息遵循 Conventional Commits（`feat(core): ...` / `fix(core): ...`）

## 相关文档

- [Hono 文档](https://hono.dev/)
- [Deno 文档](https://docs.deno.com/)
