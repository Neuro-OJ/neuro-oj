# 开赛前业务与产品决策表决单（Product Decision Sign-off）

> **文档状态**：待 Owner 填写 / Pending Sign-off  
> **基准设计文档**：[`dev-docs/superpowers/specs/2026-09-28-contest-readiness-unattended-audit-design.md`](file:///home/xyber-nova/Github/neuro-oj/dev-docs/superpowers/specs/2026-09-28-contest-readiness-unattended-audit-design.md)  
> **填写指引**：请在每个决策项的候选方案括号中勾选 `[x]`；若有特定要求，可直接在“**自定义裁决 / 补充说明**”区域填写。填写完毕后通知 AI 助手即可。

---

## 目录
- [决策 1：赛时讨论区与动态（Moments）的发言管控策略](#决策-1赛时讨论区与动态moments的发言管控策略)
- [决策 2：邀请赛与私有赛的保密边界与自主报名开放性](#决策-2邀请赛与私有赛的保密边界与自主报名开放性)
- [决策 3：全站总榜与个人解题数在赛期的准实时性与防泄露](#决策-3全站总榜与个人解题数在赛期的准实时性与防泄露)
- [决策 4：提交语言支持范围收敛 vs 评测机扩充](#决策-4提交语言支持范围收敛-vs-评测机扩充)
- [决策 5：评测运行超时的错误归因呈现（TLE vs SystemError）](#决策-5评测运行超时的错误归因呈现tle-vs-systemerror)
- [决策 6：Kaggle / IOAI 赛制平局决胜时间戳与 0 分惩罚规则](#决策-6kaggle--ioai-赛制平局决胜时间戳与-0-分惩罚规则)
- [决策 7：LLM 评测 Token 单次生命周期与配额零值语义](#决策-7llm-评测-token-单次生命周期与配额零值语义)
- [决策 8：生产部署配置中 Docker 镜像强验签默认开关](#决策-8生产部署配置中-docker-镜像强验签默认开关)
- [附录：无需产品决策的 28 项纯技术缺陷（直接工程修复）](#附录无需产品决策的-28-项纯技术缺陷直接工程修复)

---

### 决策 1：赛时讨论区与动态（Moments）的发言管控策略
- **涉及缺陷**：`FC-01`、`AR-09`、`N-01`
- **相关代码**：[`noj-core/src/features/discussions/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/discussions/service.ts)、[`noj-core/src/features/moments/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/moments/service.ts)
- **现状机理**：目前系统仅在发帖时“显式关联了 `problem_id` 且该题关联了进行中的比赛”时才会拦截。选手若发帖时不选题目，或直接在“动态（Moments）”中发帖，可向全站广播解法和评测输出。
- **候选方案（请勾选单项）**：
  - [x] **方案 A（推荐 · 赛时全局静默）**：有任何正式比赛进行期间，全站普通用户禁止公开发布新讨论帖与动态（出题人/管理员除外）；参赛选手如需交流只能通过“赛中答疑/Clarification”与裁判通信。
  - [ ] **方案 B（赛时先审后发）**：比赛期间全站新讨论帖与动态正常接收，但强制进入“人工待审队列”，待赛程全部结束后由管理员批量放行公开。
  - [ ] **方案 C（强制题号关联校验）**：允许发帖，但发帖必须填写关联题目，且禁止非题目讨论；动态（Moments）在赛中针对参赛选手进行屏蔽。
- **自定义裁决 / 补充说明**：
  ```text
  （如有额外要求请在此填写）
  ```

---

### 决策 2：邀请赛与私有赛的保密边界与自主报名开放性
- **涉及缺陷**：`FC-02`、`AR-02`
- **相关代码**：[`noj-core/src/features/contests/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/contests/service.ts)、[`noj-core/src/features/problems/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/problems/service.ts)
- **现状机理**：
  1. `kind='private'` 的私有赛目前在后端允许任何登录用户调用 `registerContest` 自主报名；
  2. 题目的保密状态机（SSOT）仅限制了常规公开赛关联的题目，若出题人创建了“邀请赛（invitational）”，其关联题目不会在主站题库中隐身。
- **候选方案（请勾选单项）**：
  - [ ] **方案 A（推荐 · 彻底收口）**：
    1. `kind='private'` 彻底禁止自主注册，仅允许管理员在后台批量导入名单或凭独立邀请码报名；
    2. 邀请赛关联的题目一并纳入全站保密 SSOT，开赛前与赛中对场外未参赛选手强制遮蔽。
  - [ ] **方案 B（保留自主申请 + 审核）**：私有赛允许选手提交报名申请，但需管理员审核通过后方可进入；邀请赛题目纳入保密 SSOT。
- **自定义裁决 / 补充说明**：
  ```text
  保持现状，当前邀请赛的保密方式请见 noj-docs 和其他历史文档
  ```

---

### 决策 3：全站总榜与个人解题数在赛期的准实时性与防泄露
- **涉及缺陷**：`DL-02`、`DL-03`、`F-02`
- **相关代码**：[`noj-core/src/features/rankings/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/rankings/service.ts)、[`noj-core/src/features/users/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/users/service.ts)
- **现状机理**：选手在比赛中攻破题目（AC）后，全站大排行榜（`/rankings`）和个人主页解题数立即 +1，且全站 SSE 会广播提交状态更新。外部对手可通过轮询全站总榜数值，实时反推出某选手攻克了盲盒题目（尤其在封榜期间造成侧信道破防）。
- **候选方案（请勾选单项）**：
  - [x] **方案 A（推荐 · 赛中数据隔离）**：全站总榜与个人主页统计的计算中，**排除所有未结束比赛中的提交**。比赛期间全站榜单正常流转但绝不体现赛中增量，待比赛彻底结束结算后，一次性合入全站大榜。
  - [ ] **方案 B（赛期全站总榜全局冻结）**：比赛期间停止更新全站大排行榜（页面提示“比赛期间总榜维护冻结”），赛后统一解冻刷新。
- **自定义裁决 / 补充说明**：
  ```text
  （如有额外要求请在此填写）
  ```

---

### 决策 4：提交语言支持范围收敛 vs 评测机扩充
- **涉及缺陷**：`AR-06`
- **相关代码**：[`noj-core/src/features/submissions/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/submissions/service.ts)、[`noj-judge/src/runner.rs`](file:///home/xyber-nova/Github/neuro-oj/noj-judge/src/runner.rs)
- **现状机理**：`noj-core` 的枚举声明支持 `python`, `cpp`, `c`, `javascript`，但 `noj-judge` 双容器沙箱硬编码了 `python3 solution.py`。若选手提交 C++ 代码，评测机在运行期会直接抛出语法解析错误或编译失败。
- **候选方案（请勾选单项）**：
  - [x] **方案 A（推荐 · 紧急收敛契约）**：鉴于本次比赛核心为 Python / LLM 评测，开赛前直接将前端与后端允许提交的语言**收敛为仅支持 `python`（Python 3）**，并在界面明确提示“当前赛程仅开放 Python 3”，阻断其余语言提交。
  - [ ] **方案 B（评测机端紧急扩充）**：在 `noj-judge` 中紧急实现多语言编译镜像切换与 C++/C 编译管道（需新增 g++ 容器镜像与编译产物挂载，改动面较大）。
- **自定义裁决 / 补充说明**：
  ```text
  （如有额外要求请在此填写）
  ```

---

### 决策 5：评测运行超时的错误归因呈现（TLE vs SystemError）
- **涉及缺陷**：`AR-07`
- **相关代码**：[`noj-judge/src/runner.rs`](file:///home/xyber-nova/Github/neuro-oj/noj-judge/src/runner.rs)、[`noj-core/src/features/submissions/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/submissions/service.ts)
- **现状机理**：沙箱评测执行超限（例如超过了设定的 300 秒最大运行时限）被 Tokio `timeout` 捕获后，Rust 端统一下发为 `SystemError`。选手在前端看到的是“系统错误/评测机故障”，容易引发大量不必要的误解与组委会申诉。
- **候选方案（请勾选单项）**：
  - [x] **方案 A（推荐 · 规范归因）**：严格区分用户超限与平台故障——用户容器运行满额超时统一判定为 **`TimeLimitExceeded`（超时）**，扣分并计为超时；仅当 Docker 守护进程失联、镜像拉取失败、Socket 通信崩溃时才归因归类为 `SystemError`。
  - [ ] **方案 B（维持原样）**：保持全部抛出 `SystemError`。
- **自定义裁决 / 补充说明**：
  ```text
  （如有额外要求请在此填写）
  ```

---

### 决策 6：Kaggle / IOAI 赛制平局决胜时间戳与 0 分惩罚规则
- **涉及缺陷**：`AR-10`
- **相关代码**：[`noj-core/src/features/contests/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/contests/service.ts)
- **现状机理**：目前 Kaggle 赛制榜单在计算选手同分平局时，误用了选手的最后提交时间 `MAX(submitted_at)`。如果选手在取得最高分后，又随手提交了一次编译错误（CE）或 0 分的代码，该选手的“刷新时间”会被严重推后，导致排名被对手反超。
- **候选方案（请勾选单项）**：
  - [x] **方案 A（推荐 · 标准竞赛规则）**：选手的“成绩刷新时间点”必须**严格锁定为“取得当前最高得分的那次提交的时间”**。随后的同分提交、更低分提交或错误提交，绝不推后选手的高分锁定时间。0 分选手按“首次提交时间”或并列排在有得分选手之后。
  - [ ] **方案 B（最后得分更新时间）**：只要得分发生变化（哪怕变低）才更新时间戳；0 分提交不更新时间戳。
- **自定义裁决 / 补充说明**：
  ```text
  （如有额外要求请在此填写）
  ```

---

### 决策 7：LLM 评测 Token 单次生命周期与配额零值语义
- **涉及缺陷**：`AR-08`、`G-01`、`G-07`
- **相关代码**：[`noj-llm-gateway/src/routes/evaluate.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-llm-gateway/src/routes/evaluate.ts)、[`noj-core/src/features/submissions/service.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-core/src/features/submissions/service.ts)
- **现状机理**：
  1. 生成的 `eval_token` 目前未与单次评测提交 ID 绑定生命周期，沙箱内若截获 token 可持续滥用；
  2. 后台配置 LLM 模型配额时，`max_requests: 0` 在代码中真值判断产生歧义（是禁用还是无上限）。
- **候选方案（请勾选单项）**：
  - [x] **方案 A（推荐 · 单次绑定注销 + 0 即禁用）**：
    1. `eval_token` 严格与 `submission_id` 单次绑定，评测结束（或超时）立即在 Redis 中原子吊销；
    2. 配额字段中 `0` 明确定义为“禁用/禁止调用该模型”；如需“不设限/无上限”必须显式配置为 `null` 或 `-1`。
  - [ ] **方案 B（维持长效 Token）**：`eval_token` 保持有效直至固定时间（如 1 小时）自然过期；`0` 视为无上限。
- **自定义裁决 / 补充说明**：
  ```text
  （如有额外要求请在此填写）
  ```

---

### 决策 8：生产部署配置中 Docker 镜像强验签默认开关
- **涉及缺陷**：`SC-02`
- **相关代码**：[`.env.prod.example`](file:///home/xyber-nova/Github/neuro-oj/.env.prod.example)、[`noj-cli/src/commands/verify.ts`](file:///home/xyber-nova/Github/neuro-oj/noj-cli/src/commands/verify.ts)
- **现状机理**：生产配置模板默认强启 cosign 镜像验签（`NOJ_ENFORCE_IMAGE_SIGNATURES=true`）。但在完全物理隔离的离线竞赛内网部署中，缺少公网公钥证书链会导致 `noj-cli install` 在第一步拉取镜像时直接报错退出。
- **候选方案（请勾选单项）**：
  - [x] **方案 A（推荐 · 默认兼顾离线）**：`.env.prod.example` 默认设为 `false`，文档与 CLI 交互中提供明确加固提示：“在具备公网连通性的标准集群中推荐切换为 `true`”。
  - [ ] **方案 B（默认强安全）**：保持默认 `true`，离线部署文档中指导运维手动关闭。
- **自定义裁决 / 补充说明**：
  ```text
  （如有额外要求请在此填写）
  ```

---

## 附录：无需产品决策的 28 项纯技术缺陷（直接工程修复）

以下问题属于客观技术 Bug，工程师将直接按照既定工程标准进行修复，无需产品团队额外决策：

| 领域 | 编号 | 严重度 | 缺陷简述 |
|---|---|---|---|
| **评测与调度** | `AR-01` | Critical | Multipart 上传解析顺序错误导致 64KB TCP 管道挂起死锁 |
| | `JA-01` | Critical | 多 Worker 挂载同 Volume 导致 instance_id 相同容器互杀 |
| | `JA-02` | High | Rejudge 先在 DB 事务删数据再推 Redis，失败导致历史成绩物理丢失 |
| | `AR-04` | High | `sweeper.ts` 超时重投用 `RPUSH` 导致毒药任务反向插队队首死循环 |
| | `JA-03` | High | 评测崩溃后 `support-*.zip` 解压临时目录未在 defer 中清理撑爆磁盘 |
| | `CR-01` | High | `createSubmission` 单语句 `FOR UPDATE` 未在显式事务块，行锁即刻释放 |
| | `CR-02` | Medium | 提交防刷计数先 `redis.incr` 后做校验，参数错误也白扣限额 |
| | `CR-03` | Medium | `stats-cache.ts` 违规使用进程内局部变量缓存违背多副本约束 |
| | `AR-03` | High | 题目转公开 `to_p` 并发 MAX 产生 23505 唯一键冲突崩溃且漏发搜索事件 |
| **沙箱隔离** | `TI-01` | Critical | `noj-eval-net` 缺少 `internal: true` 导致沙箱拥有外部出站访问权限 |
| | `SE-01` | High | `noj-download://local` 绕过对象存储，路径穿越直读宿主机任意文件 |
| | `SE-02` | High | `noj-download://s3` 缺乏私网网段与保留地址校验，存在内网 SSRF 风险 |
| | `SE-03` | Medium | 沙箱容器未显式指定非 root UID，具备容器内 root 权限 |
| **数据保密与越权** | `DL-01` | High | 客观题历史练习详情回显正在进行的公开赛标准答案与解析 |
| | `DL-04` | High | 个人主页漏掉 `pending` 赛前封存期，提前泄露题目名称与类型 |
| | `DL-05` | Medium | 题单与标签统计泄露保密题数量；客观题权限校验 403 产生存在性预言机 |
| | `FC-03` | High | 封榜 SSE 广播闭包状态未动态刷新；JSON 解析异常未采用 Fail-Closed |
| | `FC-04` | Medium | 赛中答疑 Clarification 接口无频控且全量数组在内存过滤 |
| | `FC-05` | Low | 举报接口响应体回显被举报题解全文，产生低权限探查侧信道 |
| **网关与前端防御** | `GW-01` | High | LLM 网关 `upstreamRes.text()` 无上限，超大流式响应引发 OOM 崩溃 |
| | `GW-02` | High | Provider 账单计费允许负数 cost，导致配额反向盗刷充值 |
| | `GW-03` | Medium | 异常请求分支在数据库落库 50MB 巨大 jsonb 撑爆磁盘 |
| | `GW-04` | Low | 网关 Token 比对采用 `!==` 弱比较存在时序攻击隐患 |
| | `UI-01` | Medium | DOMPurify 净化未禁用 `style` 属性存在 CSS 钓鱼注入风险 |
| | `UI-02` | Low | 外链图片正则有误导致合法图片解析失败 |
| | `UI-03` | Low | 前端 CSP 策略过于宽松缺乏纵深防御 |
| **会话与测试供应链** | `AR-05` | High | 封禁作弊用户时未自增 `session_version`，存量多副本 JWT 仍生效 |
| | `TH-01` | Medium | PGlite 与真实 PG 在 `count(*)` 返回值类型（number vs string）不一致 |
| | `TH-02` | Medium | 本地 E2E 测试脚本清理 Docker 容器缺乏项目名命名空间隔离 |
| | `TH-03` | Low | 验证脚本先写盘后校验失去门禁效力；GitHub Actions 缺失 commit SHA pin |
