# 安全模型

- 认证：JWT HS256，HTTP-only Cookie，24h 过期。
- 密码：bcrypt cost 12，最小 8 位含大小写与数字。
- 容器安全：cap_drop ALL、no-new-privileges、network_mode none、ipc_mode none、pids_limit 256。
- ZIP 安全：拒绝路径穿越、条目数 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB。
- 日志安全：生产环境 UUID 截断、score 隐藏、DB 密码脱敏。

详细安全模型见仓库根目录 `AGENTS.md`。

## 题目可见性（problems.visibility）

`problems.visibility` 是题目访问控制的核心列，取值范围：

| 取值 | 语义 |
| --- | --- |
| `public` | 公开题：出现在题目列表 / 搜索 / 公开入口，匿名与登录用户可按规则访问和提交。 |
| `private` | 私有题：默认仅题目创建者与管理员可见、可管理、可提交；他人不能通过普通列表、搜索或直链读取。 |

访问判定由 catalog 域纯函数 `resolveProblemAccess` 统一完成，读取与提交路径共用，判定顺序为：

`admin → owner → 竞赛上下文（不回退 public）→ visibility`

其中竞赛上下文不是可伪装的“额外放行”：`verifyContestAccess` 会校验题目确实属于该竞赛、查看者是参赛者、且竞赛处于 running/ended。普通用户创建竞赛时也只能加入 `public` 题或自己拥有的 `private` 题，不能把他人私有题塞进竞赛来绕过访问控制。

## 竞赛分类（contests.kind）

`contests.kind` 区分竞赛的公开/邀请模型，取值范围：

| 取值 | 语义 |
| --- | --- |
| `public` | 公开赛：仅管理员可创建，出现在公开竞赛列表，参赛者可以自助注册；可额外设置密码（设置后报名需匹配）。 |
| `invite` | 邀请赛：具备 `contest:create` 权限的普通用户可创建，创建时必须设置邀请码；报名时必须提供正确邀请码，否则拒绝。 |

`is_public` 仍是控制竞赛列表/详情是否对外展示的字段；`kind` 负责创建权限与报名/邀请校验的语义，二者不可互相替代。邀请赛密码在库中只存哈希，用于报名校验。

## 提交结果投影（applySubmissionProjection）

竞赛场景下，提交详情/列表/SSE/队列等所有读路径都必须经过统一投影函数 `applySubmissionProjection`，防止判据、隐藏用例、标准答案经任何渠道泄露。

投影上下文包括查看者身份、是否管理员/题目 owner、是否提交者本人、是否参赛者，以及竞赛是否 running。主要规则：

- 管理员、无竞赛上下文的提交、题目 owner（非提交者本人）：维持既有 DTO 可见性（代码/输出/用例详情仍只对 owner/admin 开放）。
- 竞赛进行中，参赛者 + 提交者本人：保留最终状态与分数，剥离 `details` 中的隐藏用例、`subtasks`、`testCases`、`output`；只保留 `details.cases` 中 `hidden: false` 的可见用例。
- 竞赛结束后，参赛者 + 提交者本人：保留状态与分数，但隐藏用例仍然不返回。
- 竞赛中他人或非参赛者：仅返回 `{ id, problem_id, status }` 这类存在级信息。
- 旧评测脚本若用例缺少 `hidden` 标记：按 fail-safe 处理，整份用例详情不返回，避免旧数据假设“未标记即可见”造成泄露。

因此评测脚本契约要求：`details.cases` 中每个用例都必须带有布尔标记 `hidden`（`true` 为隐藏用例，`false` 为可见用例）。可见用例可附带输入、期望输出、实际输出；隐藏用例只允许返回 ID、状态、耗时/内存等非敏感元数据，MUST NOT 返回输入、期望输出、实际输出。

客观题同样执行防泄露规则：竞赛模式提交与详情中的解析、`expected`/标准答案会被剥离，练习模式只有公开套卷、套卷 owner 或管理员能看到解析。
