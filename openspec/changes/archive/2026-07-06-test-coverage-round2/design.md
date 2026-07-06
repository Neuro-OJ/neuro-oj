## Context

第一轮测试补强（P0-P2）新增 14 个测试、解决 CI 挂起问题，使三类测试全部通过（655 测试）。覆盖表展示以下 P3-P4 盲区：

- **SSE 推送**：无任何测试（服务层 + HTTP 层均无）
- **私信**：服务层有 14 个单元测试，但无全链路 HTTP E2E
- **审计日志**：路由层有 4 个单元测试，但无 E2E 验证完整操作记录流程
- **支持包 S3 上传**：仅 S3 client 单元测试（6 个），无上传/删除 E2E
- **重测（rejudge）**：无任何测试
- **CI 冒烟子集**：E2E 全量运行需 5-15min，缺少快速反馈路径

## Goals / Non-Goals

**Goals:**
- SSE 端点 E2E 测试：验证事件推送、心跳、连接关闭
- 私信 HTTP API E2E 测试：覆盖会话 CRUD、消息发送/列表/删除
- 审计日志 E2E 测试：验证 7 类操作的审计记录和列表查询
- 支持包 S3 上传 E2E 测试：在 S3 模式下验证上传/下载/删除
- 重测 E2E 测试：验证单条和批量重测全流程
- CI 冒烟测试 job：快速验证核心 API 可达性 + 数据库迁移（不启动 judge）
- 新增约 30-40 个测试函数

**Non-Goals:**
- 速率限制 E2E（明确排除）
- SSE UI 端集成测试（仅后端验证）
- 支持包 Base64 模式（已有 local 模式覆盖，S3 才是盲区）
- 审计日志前端 UI 测试（已有管理面板 spec）
- 全量 E2E 替换——冒烟测试是补充，非替代

## Decisions

### 1. SSE E2E 使用 AbortSignal 模式而非 EventSource

在 Deno 测试环境中 `EventSource` 不可用且难以控制超时。使用 `fetch` + `AbortSignal.timeout()` + `ReadableStream` 解析 SSE 流，可控性更好。

**替代方案**：启动真实 SSE 客户端 → 需要前后端联合测试环境，复杂度超收益。

### 2. 私信测试复用现有用户注册流程（幂等）

私信需两个用户在相同会话中交互。E2E 测试时在 `beforeAll` 中注册两个测试用户（UUID 后缀防冲突），每个测试用例独立标记已读状态。

### 3. 审计日志 E2E 通过种子用户执行 7 类操作

利用 seed 脚本的 `ensureE2EAdminUser()` 创建固定测试管理员，执行角色变更、封禁、删题等操作，然后调用列表 API 验证记录存在。

### 4. S3 支持包测试使用 MinIO

本地开发环境使用 docker-compose 中的 MinIO（已在基础架构中启用）。测试设置 `STORAGE_PROVIDER=s3` + `S3_ENDPOINT=http://localhost:9000`，使用 `ensureBucket()` 确保 bucket 存在。CI 中也有 MinIO service。

### 5. 冒烟测试作为独立 CI job

在 `.github/workflows/ci.yml` 中新增 `core-smoke` job：启动 PostgreSQL + Redis，运行 noj-core，执行核心 API 可达性测试（health、auth、problems list）。**不启动 noj-judge**，控制在 2-3 分钟内。

### 6. 重测 E2E 依赖完整评测栈

重测 E2E 需要通过 `06_pipeline.test.ts` 先提交正确代码获得 `finished` 状态的提交，再调用 `POST /admin/submissions/:id/rejudge` 触发重测。复用 `pollSubmission()` 等待重测完成。

## Risks / Trade-offs

- **[SSE 测试稳定性]** AbortSignal 超时与事件推送存在时序竞争 → 断言时使用宽松超时（15s），设置合理的退避次数
- **[MinIO 环境依赖]** 非所有 CI 环境都有 MinIO → 使用 `S3_ENDPOINT` 环境变量门控，无变量时 skip S3 测试
- **[重测 E2E 耗时]** 完整重测流程需 2x 正常评测时间（第一次 + 重测）→ 设置 60s 总超时，非 E2E 模式 skip
- **[冒烟测试维护]** 冒烟测试 URL 列表随路由变更需同步 → 集中管理 `SMOKE_ENDPOINTS` 常量数组
