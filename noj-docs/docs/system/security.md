# 安全模型

> 本页汇总认证、密码、沙箱隔离、数据传输与日志脱敏的默认安全基线。**所有数值均为默认值，以源码与配置注册表为准。**

## 安全基线速览

| 领域 | 默认设置 | 说明 |
| --- | --- | --- |
| 认证 | JWT **HS256**，HTTP-only Cookie，24h 过期 | 无刷新机制；`jti` + `session_version` 支持撤销 |
| 密码 | bcrypt cost 12，≥8 位含大小写字母与数字 | 不可与用户名/邮箱前缀相同 |
| 容器 | `cap_drop ALL`、`no-new-privileges`、`network_mode none`、`ipc_mode none`、`pids_limit 256` | 另加只读 rootfs + tmpfs、CPU/内存上限 |
| ZIP | 拒绝路径穿越；条目 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB | 按实际解压字节实时限额，不信任条目声明 |
| 日志 | 生产环境 UUID 截断、`score` 隐藏、DB 密码脱敏 | 由统一 logger 处理 |
| 审计日志 | 保留 90 天后清理 | `AUDIT_LOG_RETENTION_DAYS`，`0` 表示禁用清理 |

::: warning 生产环境必须配置可信代理
未配置 `TRUSTED_PROXIES` 时，`X-Forwarded-For` / `X-Real-IP` 可被伪造，导致 IP 限流与 IP 黑名单被绕过。生产环境（`NOJ_ENV=production`）启动时会因缺少该配置而**拒绝启动**。
:::

::: tip 会话撤销
改密、重置密码、补设密码会原子递增 `users.session_version`，使全部旧会话立即失效；登出则把 `jti` 写入 Redis 黑名单。两者都在鉴权中间件实时校验。
:::

## 认证与密码细节

- **JWT**：HS256、校验 `iss`/`aud`、默认 24h 过期（`jwt_expires_in` 可热改）。签名密钥 `JWT_SECRET` ≥ 32 字符，且拒绝已知占位值。
- **密码强度**：至少 8 字符，包含至少一个小写字母、一个大写字母和一个数字；不得与用户名或邮箱前缀相同。
- **bcrypt**：默认 cost 12（`BCRYPT_SALT_ROUNDS` 启动期可覆盖，仅影响新哈希）。

## 容器与 ZIP 隔离（noj-judge）

评测容器在创建时即收敛到最小权限，且不挂载任何宿主路径或设备：

| 限制项 | 值 | 作用 |
| --- | --- | --- |
| `cap_drop` | `ALL` | 丢弃全部 Linux capabilities |
| `security_opt` | `no-new-privileges:true` | 禁止提权 |
| `network_mode` | `none`（默认） | 默认无网络；LLM 题由题目配置显式开启 |
| `ipc_mode` | `none` | 不共享宿主 IPC；`pid_mode` 未设置（沿用 Docker 默认命名空间） |
| `pids_limit` | `256` | 限制进程数，防 fork 炸弹 |
| `readonly_rootfs` | `true` | 根文件系统只读，`/workspace` 用 tmpfs |
| `nano_cpus` | 可配（默认 ≤ 1 核） | 越界值收敛到安全范围 |

::: danger 不要放宽沙箱限制
`cap_drop`、`no-new-privileges` 与 `network_mode none` 是不可逆的安全红线。为让题目"跑起来"而给容器加 capability、挂载宿主目录或改为 `privileged`，会直接打破多租户隔离。
:::

ZIP 解压防护按实际解压字节实时统计：单文件超过 64 MiB 或总量超过 512 MiB 即中止，条目数上限 1000。

## 题目可见性（problems.visibility）

`problems.visibility` 是题目访问控制的核心列，取值范围：

| 取值 | 语义 |
| --- | --- |
| `public` | 公开题：出现在题目列表 / 搜索 / 公开入口，匿名与登录用户可按规则访问和提交。 |
| `private` | 私有题：默认仅题目创建者与管理员可见、可管理、可提交；他人不能通过普通列表、搜索或直链读取。 |

新建 U 型（用户题）默认 `private`，owner 可通过"我的题目"或 `PUT /problems/:id/visibility` 转 `public`；P 型（主题库题）恒为 `public`（数据库 CHECK 兜底，`problems_p_visibility_check`）。存量题目在迁移时保持 `public` 以延续升级前可见性。

访问判定由 catalog 域纯函数 `resolveProblemAccess` 统一完成，读取与提交路径共用，判定顺序为：

`admin → owner → 竞赛上下文（不回退 public）→ visibility`

其中竞赛上下文不是可伪装的"额外放行"：`verifyContestAccess` 会校验题目确实属于该竞赛、查看者是参赛者、且竞赛处于 running/ended。普通用户创建竞赛时也只能加入 `public` 题或自己拥有的 `private` 题，不能把他人私有题塞进竞赛来绕过访问控制。

## 竞赛分类（contests.kind）

`contests.kind` 区分竞赛的公开/邀请模型，取值范围：

| 取值 | 语义 |
| --- | --- |
| `public` | 公开赛：仅管理员可创建，出现在公开竞赛列表，参赛者可以自助注册；可额外设置密码（设置后报名需匹配）。 |
| `invite` | 邀请赛：具备 `contest:create` 权限的普通用户可创建，创建时必须设置邀请码；报名时必须提供正确邀请码，否则拒绝。 |

`is_public` 是列表/详情是否对外展示的字段，且**由 `kind` 派生**（`public ↔ true`、`invite ↔ false`）：写入路径统一收敛为 `kind` 语义，不单独接受 `is_public` 覆盖。邀请赛邀请码在写入时经 bcrypt 哈希存储，校验时兼容历史明文行。

## 提交结果投影（applySubmissionProjection）

竞赛场景下，提交详情/列表/SSE/队列等所有读路径都必须经过统一投影函数 `applySubmissionProjection`，防止判据、隐藏用例、标准答案经任何渠道泄露。

投影上下文包括查看者身份、是否管理员、是否提交者本人、是否参赛者，以及竞赛是否 running。主要规则：

- 管理员、无竞赛上下文的提交、题目 owner（非提交者本人）：维持既有 DTO 可见性（代码/输出/用例详情仍只对 owner/admin 开放）。
- 竞赛进行中或结束后，参赛者 + 提交者本人：保留最终状态与分数，剥离 `details` 中的隐藏用例、`subtasks`、`testCases`、`output`；只保留 `details.cases` 中未被标记为隐藏的可见用例。
- 竞赛中他人或非参赛者：仅返回 `{ id, problem_id, status }` 这类存在级信息。
- 旧评测脚本若用例缺少 `hidden` 标记：按 fail-safe 处理，整份用例详情不返回，避免旧数据假设"未标记即可见"造成泄露。

因此评测脚本契约要求：`details.cases` 中每个用例都必须带有布尔标记 `hidden`（`true` 为隐藏用例，`false` 为可见用例）。可见用例可附带输入、期望输出、实际输出；隐藏用例只允许返回 ID、状态、耗时/内存等非敏感元数据，MUST NOT 返回输入、期望输出、实际输出。

::: info 客观题同样防泄露
竞赛模式提交与详情中的解析、`expected`/标准答案会被剥离；练习模式只有公开套卷、套卷 owner 或管理员能看到解析。
:::

详细安全模型另见[架构总览](./architecture.md)与仓库根目录 `AGENTS.md`。
