# nojctl 部署运维 CLI 设计（Rust 重写）

Status: draft-2（已吸收 2026-09-27 PM 审计的 P0 前置条件；待项目所有者复审）
日期：2026-09-27
范围：新增 `nojctl`（Rust，musl 静态二进制）；`noj-cli`（TS 版）冻结不再演进；发布链路（`release.yml` + CI）新增 manifest 资产与四道门禁；`noj-core` 增补两个可选能力（`noj config check --json`、`noj db status --json`）与一个 follow-up（`email_provider` 运行时化）；不改动 core / judge / ui / gateway 的既有行为
基线：main @ `ca6d3458`（含本 spec 与 PM 审计）

---

## 0. 本稿（draft-2）相对 draft-1 的变更

吸收自 [PM 审计](../audit/2026-09-27-nojctl-design-pm-audit.md)（结论：有条件进入实施，7 Blocker / 14 Major / 8 Minor / 6 处自相矛盾）。逐条落点：

| 审计项 | 本稿改法 |
| --- | --- |
| **B1** HTTP 明文部署（core 生产配置致命校验 / Secure Cookie 丢失；VERIFY 只验 200） | §5.5 屏幕 1 恢复"对外协议"一问；屏幕 2 推导清单加入 `NOJ_ALLOW_INSECURE_HTTP`；PREPARE 复制 core 的生产配置判据（失败前移到零写入阶段）；VERIFY 增加**真实登录往返**；§6.3 增补**首装失败**语义 |
| **B2** 邮件默认 disabled ⇒ 学生无法注册且后台改不了 | §5.5 屏幕 1 第③问改成带后果的措辞、删掉"稍后再配"；完成页在邮件未配置时插入固定警示区块；§13 增加"`email_provider` 运行时化"的跨模块 follow-up |
| **B3** 无"停站/开站"，`stopped` 无出路 | §5.1 新增 `start` / `stop`；`apply` 不再改变运行态（只切版本/配置），§5.6 规则⑤改写 |
| **B4 / C1** 目录守卫与卸载保留物、幂等续跑互锁 | §9.3 守卫判据改为"以 `.nojctl/state.json` 为准"：有 state 即视为本工具目录（续跑/复用）；无 state 时只接受空目录或仅含保留物（`.env.prod`、`backups/`） |
| **B5** 不接管既有安装 + 不读 v1 备份 ⇒ 现网无路可走 | 维持"不接管、不兼容产物"，但**新增受支持的迁移手册**（§12 批次 6.5，人工步骤 + CI 演练清单），并在 Release Notes 模板中固定披露 |
| **B6** 固定 `name: noj-prod` ⇒ 同机第二实例互相接管 | §7.1 项目名按安装目录派生（`noj-<8 位摘要>`，可用 `NOJCTL_PROJECT_NAME` 覆盖）；§5.5 屏幕 0 增加"同名项目已存在"检查并拒绝 |
| **B7** Docker 缺失/无权限只有"退出 3" | §5.5 屏幕 0 的失败输出必须含**可复制的安装/授权指引**（Debian/Ubuntu 与 RHEL 两族） |
| **M2 / C4** 回退退出码判据冲突 + 回退文案不诚实 | §5.2 与 §6.3 统一为"**数据面是否可能已前进**"单一判据；回退文案改为只陈述已验证事实并把数据库状态单列 |
| **M3** 迁移信息无决策价值（A1 的代价） | §6.7 增加**可选**能力：镜像提供 `noj db status --json` 时读精确增量，缺失时降级为"目标版本声明总数 + 增量未知"；能力进 §12 与 §13 |
| **M4** 日常配置无引导 | §5.7 `.env.prod.example` 顶部新增"最常改的键"分区；`status` / `doctor` 给出可复制的修改指引 |
| **M6** 完成页 URL 未处理 DNS/TLS | 完成页增加"浏览器可访问性检查清单"（DNS 解析、TLS 握手与剩余天数） |
| **M7** 备份口令与异地 | §8.1 口令二次确认 + 指纹显示；同盘风险提示与异地一行命令示例 |
| **M8** 备份漏 Redis（v1 有） | §8.1 / §8.3 备份与恢复纳入 `redis.rdb`（JWT 撤销名单、队列、claim） |
| **M9** 磁盘无回收 | §11 / §6.3 FINALIZE：世代被清理时同步回收其独占镜像；`doctor` 报告可回收量 |
| **M12** 现有运维文档未切换 | §12 新增"批次 7.5 文档切换"（`production-deploy.md` / `judge-workers.md` / `cli.md` / `noj-cli/README.md`），与新命令面同批发布 |
| **M14** 受限网络下 GHCR 不可达 | §5.5 屏幕 0 增加镜像源可达性检查与三种出路（镜像源 / 代理 / 离线 `docker load`），并在摘要中显示拉取预估 |
| **C2** 「不对数据负责」却要求签"已备份" | §5.3 明确签名是**知情声明**、工具不校验其真伪；新增**可选**严格模式 `NOJCTL_REQUIRE_RECENT_BACKUP_DAYS`（默认 0=关） |
| **C3** 「不做 config」与"向导写 `.env.prod`"边界不清 | §5.7 明确三类键：CLI 生成（可覆盖）/ 用户拥有（永不写）/ 无白名单代改（手改 + 工具校验） |
| **C5** 「世代=可原样复原」易被读成含数据 | §2 术语条目直接写明"仅部署描述，不含数据" |
| **C6** monitoring「忠实渲染但不算支持」 | **删除**：生成的 compose 不再包含 monitoring 服务与 4 个文件（§1.1、§7.1、§7.5） |
| **US-8** 证书到期 | `doctor` 对配置域名做一次 TLS 握手，报告剩余天数（< 14 天告警）；续期仍归外部工具 |
| **US-11** 被攻击后要留证 | `doctor --bundle` 输出诊断包（版本、state.json、容器状态、日志摘要、doctor 报告） |
| **US-13 / M10** 专业维护者被挡在外面、管理员找回 | 新增 `core -- <args…>` 逃生舱：把参数透传给容器内 `/app/bin/noj`（`bootstrap first-admin` / `admin` / `db migrate` / `problem` …） |
| **US-12** 给同事开权限 | §12 文档批次含"权限与交接"小节（要给他什么、为什么需要 docker 组） |

**需要项目所有者明确定调的三处**（本稿按下面取默认值，可否决）：① 维持"不接管 + 不兼容"，只加人工迁移手册（若改为提供 `import`/`adopt` 则 §9 与 §12 需重写）；② 用 `start` / `stop` 承担运行态，而不是把运行态塞进 `apply`；③ 保留口令门禁，但把"是否真备份过"交给可选的严格模式，而不是工具替用户判断。

---

## 1. 背景与目标

部署与运维是 NOJ 目前**唯一没有原子性、也最容易把非技术运营者卡住**的环节。目标受众是**没接触过服务器运维的运营者（如学校教练）**：他们能拿到一台 Linux 服务器和一个域名，但不该被迫理解 compose / env 文件 / rootless Docker / 数据库迁移不可逆这些概念。

本设计重写部署运维 CLI（二进制名 **`nojctl`**），交付四件事：

| 编号 | 目标 | 一句话 |
| --- | --- | --- |
| **D** | 部署状态机与原子提交 | 版本切换是一个可回退的事务；失败自动回到上一世代 |
| **G** | 生成式部署描述 | compose 与挂载文件由 `nojctl` 渲染，配置只有一个真相源（`.env.prod`），"填了不生效"在结构上不可能 |
| **O** | 面向零基础运营者的交互 | `deploy` 向导 + rootless 引导；`apply` 一个动词解决版本与配置变更；风险在知情状态下确认 |
| **U** | 站"可用"而不只是"起来了" | VERIFY 做语义冒烟（真实登录 + judge 执行面探测）；完成页给出 DNS/TLS 与开放注册的前置检查 |

### 1.1 非目标（明确不做）

- **不接管任何既有安装**，**不兼容 v1 产物**（不读 `snapshot-*.nojbackup`，不嗅探 `.bootstrap-*.tmp` / `.env.prod.staged`）。迁移走**人工手册**（§12 批次 6.5）。
- **不做 `config` 子命令**：`.env.prod` 由用户手写 + 工具校验（无白名单代改）。
- **不做恢复演练 `drill`**、不做定时/异地备份、不做出题包管理、不做判题机独立安装、不做全屏 TUI。
- **不支持系统 Docker daemon 跑 judge**：judge 只有"同机 rootless 开"与"关"两个状态。
- **不渲染 monitoring**：生成的 compose 不含 `prometheus` / `alertmanager` 与其 4 个挂载文件（原"忠实渲染但不算支持"的状态被判定为陷阱）。
- **不把 judge 网络收窄、不改 `JUDGE_ALLOW_HTTP_S3` 默认值、不在 production 下禁用 `local` 下载 scheme**（记为 follow-up，§13）。
- **不提供 TLS 终止**：沿用"TLS 由外部边缘终止"的既有部署模型，nojctl 只负责把 `APP_URL` / CORS / Cookie 标志**配成一致**，并检查握手与到期（§6.6）。
- **不交付 Windows / macOS 产物**；**不支持 SSH 远端执行**（B 模式只留 `Runner` seam 与契约文档）。

### 1.2 关键判断

1. **"原子"必须在第一次就成立**，因此不接受任何"从外来状态开始"的路径（§9.3 的目录判据是它的前提）。
2. **升级链路不对数据负责**：`apply` 不备份、不还原、不碰数据；数据安全归 `backup` / `restore`，提醒由 `status` / `doctor` / `apply` 摘要承担（§5.3 说明"签名"只是知情声明，不是校验）。
3. **schema 归镜像，触发归 compose，`nojctl` 只观测**：部署链路零数据库访问（§6.7）。
4. **拿不准就失败关闭**：`deploy_format` 不认识、别名无解、资产不齐、manifest 校验不过、目录外来、项目名冲突 —— 一律拒绝并说清下一步。
5. **生成物归 CLI、配置归用户**：`docker-compose.prod.yml` 与挂载文件由 `nojctl` 生成并覆盖（文件头有声明），`.env.prod` 除首装向导与"补缺失键"外永不写入。

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| **`deploy_format`** | 部署描述的**格式版本**（整数，单调递增）。规定 compose + 挂载文件 + 必需配置键 + 健康语义的形状；只在"旧渲染器产不出新版本所需描述"时 +1。不是产品版本 |
| **世代（generation）** | 一次可原样复原的**部署描述**快照：compose + 挂载文件 + 该世代实际生效的配置快照 + manifest + hash。**仅部署描述，不含任何数据**；`current` 为 live，`previous` 供回退 |
| **`state`** | 栈的运行态：`uninitialized` / `stopped` / `running` / `partial`（另有 `last_error` 字段）。运行态由 `start` / `stop` 改变，`apply` 不改运行态 |
| **`apply`** | 唯一让"部署描述与期望一致"的命令（版本变更、配置变更、no-op、崩溃恢复四合一） |
| **manifest** | Release 资产 `nojctl-manifest.json`：`deploy_format`、7 个镜像 digest、迁移摘要、`min_nojctl`、`min_source_version` |
| **别名** | `newest` / `stable` / `beta` / `alpha`：对"已发布且资产就绪"版本的**时间/渠道**选择器；解析结果是**具体 tag** |
| **资产就绪** | 该 Release 具备 `nojctl-manifest.json` 且全部镜像 digest 可校验 |
| **交付自检** | 校验"`.env.prod` 里存在的键是否真的进入了容器"（对照 `env.delivery.json`） |
| **rootless Docker** | 以普通用户运行的 dockerd（userns + subuid），judge 通过 `/run/noj-judge/docker.sock` 使用 |
| **传输无关** | 所有系统交互经 `Runner` seam，本地与将来的远端（SSH）实现同一套状态机 |

---

## 3. 现状证据（均为实测）

1. **v1 规模与形状**：`noj-cli` 源码 23,168 行 + 测试 20,668 行；最大文件 `prod/lifecycle.ts` 2096、`cli.ts` 1517、`prod/config.ts` 1217、`prod/drill/drill.ts` 1179。命令面横跨三层入口 + 7 个子系统，术语重叠（`install` / `update` / `upgrade` / `verify` / `config check` / `--files-only`）。
2. **迁移有三个入口**：compose 一次性 `migrate` 服务、core 启动的 `fatalStep("数据库迁移")`、gateway 启动自迁移；失败表现为"core 没起来"，归因困难。
3. **发布资产名耦合**（2026-09-27）：GitHub 把以 `.` 开头的资产名改写为 `default.<name>`，CLI 下载原名 → `install` / `update` 对 `0.10.1-alpha.2`、`alpha.3`、`beta.1` 全线 404（#588 修复）。
4. **"填了不生效"**：`.env.prod.example` 文档化 69 键、compose 引用 108 处，交叉审计发现 **12 个键从未被引用**；其中 7 个邮件凭据与 `JUDGE_REQUIRE_ISOLATED_DOCKER` 属真漏（后者使 judge 隔离校验在生产上是哑的）。
5. **v1 不物化挂载文件**：`bootstrap` 只下载 compose + env 模板，而 compose 挂载 `deploy/` 下 6 个文件 → 全新安装起不了 nginx。
6. **升级后 502**：core/ui 重建后容器 IP 变化，nginx 自身配置未变、不会被 `up -d` 重建 → upstream 指旧 IP。
7. **没有原子回退**：原地改文件 + `up -d`；中断后留下 `.bak-*` / `.orig` / `.staged` 残骸，无法判定"切到哪一步"。
8. **环境事实**：目标服务器常处于受限网络（Docker Hub 直连超时、`sudo` 需密码）；因此发布侧必须自带可离线验证的 manifest，且 nojctl 必须给出镜像源/离线出路。
9. **明文 HTTP 是真实路径而非假设**：production 校验要求 `APP_URL` / CORS 为 HTTPS（`noj-core/src/shared/config/production-config.ts:84/117`）且该校验是 `fatalStep`（`main.ts:272`）；v1 由 scheme 推导 `NOJ_ALLOW_INSECURE_HTTP`（`noj-cli/src/prod/config.ts:1071`）。教练"填 IP + 8080"是最自然的路径，必须被设计正面处理。

---

## 4. 架构与不变量

### 4.1 分层

| 层 | 职责 | 关键性质 |
| --- | --- | --- |
| `cli` | clap 命令面：解析、帮助、别名展开 | 零业务逻辑 |
| `ui` | 进度、交互确认、口令门禁、`--json` | 交互只在这一层；非 TTY / `--json` / `--dry-run` 一律关掉交互 |
| `state` | 状态机 + `state.json` 持久化 | **唯一状态源**；原子写（tmp+rename+fsync） |
| `plan` | 由"当前状态 + 目标 + manifest"算世代计划 | **纯函数、零副作用**；`--dry-run` 即打印它 |
| `apply` | 准备 → 单点提交 → 验证 → 失败自动回退 | 唯一改部署描述的地方，且只按计划改 |
| `render` | `deploy_format` solver 注册表 → 产物 | **纯函数**；黄金文件测试 |
| `manifest` | 取 manifest、判定 `deploy_format`、迁移摘要 | 联网或离线（镜像 label）；失败关闭 |
| `backup` | 还原点：DB / Redis / 对象 / 卷 / 配置快照，单文件加密 | 独立子系统，`apply` 永不调用 |
| `runtime` | `Runner` 抽象（`Local` 先实现，`Ssh` 留 seam）+ `HostFs` / `Clock` / `Net` | 所有 IO 的唯一出口 |
| `versions` | 别名解析 + 风险列 | 资产就绪过滤；为空则报错不回落 |
| `doctor` | 自检、完整性报告、TLS 到期检测、诊断包 | 只读（`--bundle` 只写一个 tar） |

**执行器选择**：栈定义是 compose（`nojctl` 渲染），落地用 `docker compose` CLI，状态读取用 `docker compose ps --format json` / `docker inspect`。**不**用 bollard 自己解释 compose 语义。代价：宿主机必须有 `docker` + `compose ≥ 2.x`，且失败时必须给出安装/授权指引（§5.5 屏幕 0）。二进制用 `rustls` + `x86_64-unknown-linux-musl` 静态链接。

### 4.2 不变量

1. **单一状态源**：只有 `state` 能改状态；`state.json` 原子落盘；并发由 `.nojctl/lock` 拒绝。
2. **渲染是纯函数**：同输入必同输出；产物与 manifest 的镜像 digest 交叉校验，不一致即失败。
3. **计划与执行分离**：`plan` 无副作用；`--dry-run` 零写操作（用假 `Runner` 断言）。
4. **提交点唯一**：一个世代只有一次"生效"动作；失败自动回退，且回退豁免口令门禁。
5. **运行态与部署描述分离**：`start` / `stop` 只管运行态；`apply` 只管部署描述，**不会启动已停止的栈**。
6. **数据不经 CLI 自动改动**：`apply` 不备份/不还原/不查库（§6.7）；`restore` 是唯一改写数据的命令。
7. **失败关闭**：`deploy_format` 不认识 / 别名无解 / 资产不齐 / manifest 校验不过 / 目录判据不过 / 项目名冲突 → 拒绝执行并说清下一步。
8. **生成物归 CLI，配置归用户**：compose、`deploy/*`、`.env.prod.example`、`.nojctl/**` 由 `nojctl` 生成并覆盖（文件头带声明）；`.env.prod` 只在首装向导与补缺失键时写入（§5.7 三类键）。
9. **传输无关**：所有 IO 经 `Runner` / seams；状态可序列化、可在远端重建（B 模式的前提）。
10. **确认前零写入**：向导/摘要在用户确认之前不落任何盘。
11. **世代保留**：默认保留上一个可回退世代（`keep_generations`，缺省 1）；verify 通过前不清理被替换的世代；清理世代时同步回收其独占镜像。

---

## 5. 命令面与交互

### 5.1 命令（11 条 + `--version`；下表 10 行，`start` / `stop` 合占一行）

| 命令 | 语义 |
| --- | --- |
| `deploy` | 首装：前置探测（含 Docker 指引、镜像源可达性、项目名冲突）→ 配置向导 → rootless 引导（judge 开启时）→ 渲染与空转 → 摘要确认 → 执行 → 完成页（含可访问性检查清单） |
| `apply [版本\|别名]` | 唯一让"部署描述与期望一致"的命令：版本变更 / 配置变更 / no-op / 崩溃恢复；**不改运行态** |
| `start` / `stop` | 运行态：启动 / 停止栈（应急"先停站"的第一反应；`stop` 保留数据卷与世代） |
| `versions` | 版本表：每个 tag 的渠道、是否资产就绪、`deploy_format`、迁移摘要、本机是否装得了；四个别名 → 解析到的具体 tag（空显示 `—`）；当前部署；最近备份时间 |
| `status` | 当前世代、运行态、容器与健康、版本、`deploy_format`、世代/备份磁盘占用、**配置漂移提示**、**未应用的配置变更** |
| `logs [服务]` | `compose logs` 薄封装（`--follow` / `--tail` / `--since`） |
| `doctor` | 只读自检：docker/compose 版本、judge socket 自洽、磁盘与可回收量、`.env.prod` 权限与校验、生成物漂移、镜像 digest、容器健康、备份新鲜度、**配置域名的 TLS 剩余天数**、旧文件残留；`--bundle` 输出诊断包 |
| `backup create\|list\|verify\|restore\|prune` | 独立还原点子系统（§8） |
| `uninstall` | 默认停栈 + 移除生成物，保留数据卷 / `.env.prod` / 备份；`--purge` 才删数据 |
| `core -- <args…>` | 逃生舱：把参数透传给容器内 `/app/bin/noj`（`bootstrap first-admin` / `admin` / `db migrate` / `problem` / `search`）。文档明确标注"给专业维护者，不是给教练的" |

全局：`--dir`（缺省当前目录）、`--dry-run`、`--json`、`-v/--quiet`。`apply` 额外：`--acknowledge-risk`。`backup restore`：`--acknowledge-restore`、`--skip-safety-snapshot`。`uninstall`：`--acknowledge-purge`。

**别名语义**（四个都过资产就绪过滤；为空则报错不回落）：

| 别名 | 解析为 |
| --- | --- |
| `stable` | 最新**非预发布**且资产就绪 |
| `beta` | 最新 beta 渠道 |
| `alpha` | 最新 alpha 渠道 |
| `newest` | 最新**任意渠道**且资产就绪 |

排序规则：按语义化版本取最大（预发布小于对应正式版，如 `0.10.1-beta.2 < 0.10.1`），候选集内只保留资产就绪者。`deploy` 默认别名 `stable`；若 `stable` 为空则以**退出码 5** 报错并写明"最近可安装版本为 `X`（beta 渠道），确认使用请加 `--version X`"。`nightly` 为**未来保留**（自动构建开发版通道，本仓库目前不产出）。

### 5.2 退出码（稳定契约）

| 码 | 含义 |
| --- | --- |
| 0 | 成功（含 no-op） |
| 1 | 运行期失败（未分类） |
| 2 | 用法错误（clap 默认） |
| 3 | 前置/配置不合法（docker 缺失、`.env.prod` 校验失败、目录判据不过、项目名冲突、生产配置判据不过） |
| 4 | 门禁未通过（口令错、缺 `--acknowledge-*`、用户拒绝、严格模式下无近期备份） |
| 5 | 目标不可安装（`deploy_format` 太新、别名无解、资产不齐） |
| 6 | 失败但**系统处于干净的已知状态**：已回退到上一世代并验证通过，**且本次未成功推进数据库迁移**；或首装失败后已清理到"未安装" |
| 7 | 失败且**需要人工介入**：回退失败 / 数据库可能已前进（迁移已应用）/ 首装后留下 `partial` 且无法清理 |

**判据只有一条**：数据面（数据库 schema）是否可能已被推进。推进过 → 7；否则 → 6。`--json` 的 `ok/exit_code/data` 与 CI 都依赖这条。

### 5.3 门禁（口令）

| 触发命令 | 口令（全大写、逐字、去首尾空白） | 非 TTY 参数 |
| --- | --- | --- |
| `apply`（目标版本 ≠ 当前版本） | `I UNDERSTAND THE RISK AND HAVE BACKED UP` | `--acknowledge-risk` |
| `backup restore` | `I UNDERSTAND THIS WILL OVERWRITE CURRENT DATA` | `--acknowledge-restore` |
| `uninstall --purge` | `I UNDERSTAND THIS DELETES ALL DATA` | `--acknowledge-purge` |

规则：① 有 TTY 时**先打印完整风险信息，再要求输入**；② 最多 2 次尝试，失败退出 4；③ 无 TTY 时直接报错退出 4 并给出对应参数；④ **不支持环境变量绕过**；⑤ **豁免**：失败自动回退、`--dry-run`、`apply` 的 no-op 与仅配置变更（后者用 `[Y/n]`）、`start` / `stop`、所有非破坏性命令。

**关于"签名"的诚实说明**（写进 `--help` 与该步输出）：这句口令是**知情声明**，工具**不校验**你是否真的备份过。想让工具替你守住这条线，可开启严格模式：`NOJCTL_REQUIRE_RECENT_BACKUP_DAYS=N`（默认 `0`＝关闭）。开启后，若 `backups/` 中**没有 N 天内验证通过**的快照，`apply`（版本变更）拒绝执行，退出 4，并给出可直接复制的 `nojctl backup create`。

### 5.4 `--json` 契约

stdout 只含一个 JSON 文档，人话走 stderr，字段只增不改：

```jsonc
{ "schema": 1, "command": "apply", "ok": false, "exit_code": 6,
  "from": "0.10.1-beta.2", "to": "0.10.1-beta.3", "deploy_format": 3,
  "data": { }, "warnings": [ ], "next_steps": [ ] }
```

`next_steps` 为可执行建议（如 `nojctl doctor`），脚本可忽略。密钥永远掩码，不落日志/管道。

### 5.5 `deploy` 交互编排

| # | 屏 | 内容 |
| --- | --- | --- |
| 0 | 前置探测 | 静默：docker / compose 版本与权限、架构、磁盘、**目录判据**、**同名 compose 项目冲突**、**镜像源可达性**（GHCR + manifest）。失败时输出**可复制的指引**：Debian/Ubuntu 与 RHEL 两族的 docker 安装、`usermod -aG docker`、compose 插件版本要求；受限网络给出三种出路（配置镜像源 / 走代理 / 在别处 `docker pull` 后 `docker save` + `docker load`）。失败退出 3 |
| 1 | 配置向导 | 逐问的行内提示（`inquire`/`dialoguer` 风格，**不做全屏 TUI**），四问：① **对外协议**（`HTTPS`（有域名+证书/反代，推荐）或 `HTTP`（仅内网/临时试用））+ 域名或 IP + 端口（默认 8080）② 是否启用 judge ③ **邮件**：「不配置（**学生将无法自助注册**，只能由管理员手动建号，且之后必须修改服务器上的配置文件才能开放）」「阿里云 DirectMail」「腾讯云 SES」（**不提供"稍后再配"**）④ 首个管理员（可选；跳过则打印 `nojctl core -- bootstrap first-admin …` 命令） |
| 2 | 推导与生成（不问） | 由 ① 推导 `APP_URL` / `CORS_ALLOWED_ORIGINS` / `DOMAIN` / **`NOJ_ALLOW_INSECURE_HTTP`**（协议为 http 时为 `true`）；`TRUSTED_PROXIES` 由生成的 compose 子网确定性算出；`S3_*` 与内网端点固定；`JWT_SECRET` / `TFA_ENCRYPTION_KEY` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `MINIO_ROOT_*` / S3 凭据**密码学强随机生成**；日志/保留期/资源上限取生产默认。**选 HTTPS 时**打印"TLS 不由本站点提供"，附两行可复制的 Caddy / Nginx 反代示例 |
| 3 | rootless 引导 | judge 开启时：打印发行版自适应的**幂等脚本** → **等待回车** → 探测 7 项（socket 存在且是 socket；gid 与将写入的 `JUDGE_DOCKER_SOCKET_GID` 一致且组有 rw；能 `docker -H … info`；确认是 rootless/userns 且 `Docker Root Dir` 在家目录，并与 `JUDGE_REQUIRE_ISOLATED_DOCKER=true` 自洽；`loginctl` linger 已开；**家目录**剩余空间；通过该 daemon 预拉评测镜像）→ 失败可重试或输入 `skip`（置 `JUDGE_ENABLED=false` 继续并说明后续补装路径）。**向导不调用 sudo、不改宿主机** |
| 4 | 渲染 + 空转（零写入） | 渲染世代 → `compose config -q` → **复制 core 的生产配置判据**（`APP_URL`/CORS 必须 https，除非 `NOJ_ALLOW_INSECURE_HTTP=true`）→ 端口占用 → 磁盘。任何一项不过 → 零写入，退出 3 |
| 5 | 摘要 + 确认 | 版本/渠道/`deploy_format`、对外地址与协议、服务清单、启用的 profile、**生成密钥数**、**由我推导的键数**（让"我推了什么"可见）、需下载镜像体积、迁移摘要（§6.7）、`[Y/n]`。若为明文 HTTP，额外一行："当前使用明文 HTTP：已放宽 Cookie 安全限制；配置 HTTPS 后运行 `nojctl apply` 收紧" |
| 6 | 执行 | ① 写 `.env.prod`（0600）+ 世代目录 ② 拉镜像（逐镜像进度 + 预估）③ `up -d`（含 compose 内的 `migrate` 一次性服务）④ 等健康 ⑤ 建首个管理员（若选） |
| 7 | 完成页 | 站点 URL + **浏览器可访问性检查清单**（域名是否已解析到本机、TLS 握手是否成功与剩余天数、是否需要外部反代）；**邮件未配置时的固定警示区块**（`⚠ 公开注册目前是关闭的` + 要改的 4 个键 + `nojctl apply`）；备份口令（抄写提示 + 指纹）；下一步建议（`status` / `doctor` / `backup create`） |

**首装失败语义**（无 `previous` 世代时）：不得宣称"已回退"。输出必须是"未安装成功，已清理到 `<状态>`；原因：`<具体键名/阶段>`；下一步：`<可复制命令>`"，并按 §5.2 判据给出 3 / 6 / 7。中断或失败后重跑 `deploy` **幂等续跑**（不重拉已缓存镜像；目录判据允许含本工具产物）。

非交互等价：`--scheme=http|https`、`--domain`、`--port`、`--judge=on|off`、`--email=none|aliyun|tencent`、`--admin-email`、`--admin-username`，以及快路径 `deploy --domain oj.school.edu --scheme=https --yes`。

### 5.6 `apply` 交互编排

| 情形 | 期望状态来源 | 动作 | 门禁 |
| --- | --- | --- | --- |
| `apply beta` | 参数解析出的**具体 tag** + 当前 `.env.prod` | 完整事务 | 口令（+ 严格模式下的备份新鲜度检查） |
| `apply`（配置变更） | `.env.prod` 的 `NOJ_VERSION` + 当前配置 | 完整事务（版本不变，容器重建） | 摘要 + `[Y/n]` |
| `apply`（无变化） | 同上，渲染 hash 与 `current` 一致 | **no-op**，退出 0 | 无 |
| `apply`（残留 journal） | 上次被中断的事务 | **恢复**：目标世代产物完整且镜像已在本地则续做提交，否则回退上一世代，然后验证 | 无 |

规则：① **别名只作一次性意图**：成功后把解析出的具体 tag 写入 `.env.prod` 的 `NOJ_VERSION`（绝不写别名，避免静默漂移）；② 未初始化 → 报错并指向 `deploy`（退出 3）；③ 门禁规则一句话：*目标版本 ≠ 当前版本 → 要口令*；④ 崩溃后**重跑 `apply` 即可**；⑤ **`apply` 不改运行态**：栈为 `stopped` 时只切换部署描述并提示"运行 `nojctl start` 启动"。

摘要示例（**先信息、后门禁**）：

```
期望状态：0.10.1-beta.3（beta 渠道，deploy_format 3）
  · 变更：版本 0.10.1-beta.2 → 0.10.1-beta.3；配置无变化
  · 迁移：目标版本声明 95 条（精确增量：本机镜像支持 db status 时显示，见 §6.7）
  · 镜像：4 个需下载（约 1.2 GB）
  · 最近备份：3 天前 ⚠ 建议先执行 nojctl backup create
  · 失败处理：验证不通过会自动切回 0.10.1-beta.2（不触碰数据；数据库可能已推进，届时退出码为 7）
请输入确认口令（全大写）：I UNDERSTAND THE RISK AND HAVE BACKED UP
```

### 5.7 `.env.prod` 与生成物（无 `config` 命令）

三类键，边界写死：

| 类别 | 例子 | nojctl 的行为 |
| --- | --- | --- |
| **CLI 生成**（可覆盖） | 首装时生成的密钥、推导出的 `APP_URL` / CORS / `TRUSTED_PROXIES` / `NOJ_ALLOW_INSECURE_HTTP` | 向导写入；后续 `apply` 若发现缺失则补齐 |
| **用户拥有**（永不写） | 用户后来手改的任何键、邮件凭据、资源上限、保留期 | 只读校验与报告，绝不改写或"纠正" |
| **代改** | —— | **不存在**：没有白名单代改，改配置就是手改文件 + `apply` |

- `.env.prod` 权限 0600；`deploy` 与 `apply` 的前置做 schema / 交叉约束 / 占位符校验，失败零写入、退出 3，错误信息指向**具体键名 + 文件行号**（如"`EMAIL_PROVIDER=aliyun` 但 `ALIBABA_FROM_EMAIL` 为空（`.env.prod:134`）"）。
- **交付自检**（§7.4）：存在但无人接收的键 → 警告并列出；必需但缺失 → 失败。
- **`.env.prod.example` 由同一份 schema 生成**，顶部固定一个"**最常改的键**"分区（对外地址/协议、邮件四键、judge 开关、资源上限、日志级别），其余按键组排列，每行带 `# [必需] 交付给 core` / `# [可选] 默认 false` / `# [仅 nojctl 使用]`。
- **`status` 报漂移**：比对 `current` 世代的配置快照与当前 `.env.prod` → "配置自 07:12 起已变更，3 个键尚未应用；运行 `nojctl apply` 生效"，并列出键名。
- 生成文件头部声明：`# 本文件由 nojctl <版本> 生成（世代 <id>，deploy_format N，<时间>）。请勿手工编辑：任何修改都会在下次 deploy/apply 时被覆盖。`

---

## 6. 状态机与原子提交

### 6.1 状态与 `state.json`

`<dir>/.nojctl/state.json`（0600，tmp+rename+fsync）。四个状态：`uninitialized | stopped | running | partial`，另有 `last_error {at, kind, message}`。

```jsonc
{
  "state_schema": 1,
  "install_dir": "/opt/neuro-oj",
  "project_name": "noj-3f9c1a2b",
  "current":  { "generation": "g-20260927-0712-3f9c", "version": "0.10.1-beta.2",
                "deploy_format": 3, "artifact_hash": "…", "image_digests": { }, "applied_at": "…" },
  "previous": { },
  "journal":  { "phase": "commit", "target": "g-…", "started_at": "…" },
  "last_verify":  { "at": "…", "ok": true, "checks": [ ] },
  "last_restore": { "at": "…", "backup_id": "…" },
  "keep_generations": 1
}
```

### 6.2 世代布局

`<dir>/.nojctl/generations/<id>/`：渲染出的 compose、被挂载的文件、`env.delivery.json`、`manifest.json`、`artifact_hash`，以及**该世代实际生效的配置快照（0600）**——快照是"回退后配置也真的回到那一版"的前提，代价是多一份含密钥的文件（认可）。

`artifact_hash` 对 canonical 化产物（键排序、空白归一）取 hash，用于 no-op 判定与漂移检测。

### 6.3 事务三阶段

| 阶段 | 做什么 | 失败/中断后果 |
| --- | --- | --- |
| **PREPARE**（对线上零影响） | 渲染 → `compose config -q` → **生产配置判据** → 校验 manifest digest → 交付自检与必需键校验 → 拉镜像 → 写世代目录 → 算 hash | 干净中止，线上原样，退出 6（首装则 3/6，见 §5.5） |
| **COMMIT**（唯一提交点） | 先写 journal → 原子替换 live 文件 → `state.current` 前移、旧世代记为 `previous` → **一次** `up -d`（**显式 `--force-recreate nginx`**；judge 开启时带 `--profile judge`） | 崩溃落在此处 → journal 留在 `commit`，下次任何命令都能判定方向 |
| **VERIFY** | §6.6 | 失败 → 自动回退 |
| **FINALIZE** | `state=running`、写 `last_verify`、按 `keep_generations` 清理旧世代**并回收其独占镜像** | — |

**失败 → 自动回退**：恢复 `previous` 的文件与配置 → `up -d` → 再验证。输出只陈述已验证事实：

```
已自动回到 0.10.1-beta.2 并验证通过（容器健康 + HTTP 200）。
数据库：本次迁移未推进（或：已推进 1 条，不会回滚）。
原因：<VERIFY 中失败的检查项>
下一步：nojctl doctor
```

退出码按 §5.2 单一判据：**数据库可能已前进 → 7**，否则 → 6。回退本身失败 → 7 + `state=partial` + 恢复步骤 + 建议备份 id。

**首装失败**（无 `previous`）：清理已启动的服务与生成物到"未安装"或 `partial`，按 §5.2 判据给出 3 / 6 / 7，输出"未安装成功 + 具体原因 + 可复制下一步"。

**Ctrl-C**：提交窗口内屏蔽 SIGINT（跑完当前原子步再退出）；窗口外中断都留下可判定状态。

### 6.4 崩溃恢复

`apply` 重跑即恢复：读 journal → 目标世代产物完整且镜像已在本地 → **续做提交**；否则 → **回退上一世代** → 验证。帮助文本直接写"上次 `apply` 若被中断，再跑一次 `apply` 即可"。

### 6.5 并发锁

`.nojctl/lock`（pid / hostname / command / started_at）。并发运行拒绝（退出 3）；同机且 pid 消失 → 视为陈旧锁自动清理；否则拒绝并说明。

### 6.6 VERIFY 的检查集

1. 期望容器集合齐全且 healthy（judge 无 healthcheck → 运行中 + 日志新鲜）；
2. HTTP 经 nginx：`/` 200、`/api/v1/problems` 200、`/healthz` 200；
3. **语义冒烟（新增）**：`POST /api/v1/auth/login` 拿到 Cookie，再带 Cookie 调 `/api/v1/auth/me` 期望 200 —— 这条直接覆盖 B1 的"明文下 Secure Cookie 被丢弃"故障；若向导未创建管理员，则跳过并记为 warning（不静默）；
4. **judge 执行面探测（judge 开启时）**：通过 rootless socket 跑一个一次性容器（`--rm --network none` 的最小镜像）确认 judge 侧 daemon 真能创建容器（不依赖题库，因此首装即可执行）；
5. 运行镜像 digest == manifest digest；
6. `migrate` 一次性服务退出码为 0，且日志中无迁移错误（§6.7）；
7. `state.current` 与运行世代一致，无游离文件；
8. 启动后 core / judge / gateway 日志中无致命模式。

**数据内容校验不在这里**（归 `restore` 与 `doctor`）。时间预算：PREPARE 单镜像 ≤ 20 min（可配）、总计 ≤ 45 min；COMMIT ≤ 5 min；VERIFY 总 ≤ 150 s（单检查 15 s、健康轮询 5 s）；回退路径同等预算，最坏 ≤ 10 min。

### 6.7 数据库迁移的责任边界（**A + A1**）

**内容与触发保持在镜像 + compose 里，`nojctl` 不执行、不查库，只观测。**

- **内容所有权**：服务端镜像（drizzle 迁移烤进 `noj-server`）；gateway 拥有自己的 4 个迁移文件并在启动时自迁移。
- **触发**：生成的 compose 保留一次性 `migrate` 服务（`/app/bin/noj db migrate && /app/bin/noj init system`）与 `core.depends_on: migrate: service_completed_successfully`；这条不变量用**黄金文件测试**钉住，且对**任何入口**（`nojctl` 或手动 `docker compose up -d`）都成立。**不为 gateway 增加一次性迁移服务。**
- **观测（A1）**：部署链路**零数据库访问**。归因来自 compose 事实——`migrate` 服务的退出码与日志：

  | `up -d` | `migrate` 服务 | 归因与动作 |
  | --- | --- | --- |
  | 成功 | 退出 0 | 迁移与应用都成功 → 继续 VERIFY |
  | 失败 | 退出 ≠ 0 | "**迁移未完成**（日志停在 `<迁移号>`）"→ 应用层未起 → 切回上一世代，退出 **7**（库可能停在中间点） |
  | 失败 | 退出 0 | "**迁移成功，应用层未起**"→ 切回上一世代，退出 **7**（数据面已前进） |

- **精确增量的可选来源**：若目标镜像支持 `noj db status --json`（core 侧增补，§12 批次 2.5），`nojctl` 通过 `compose run` 调用它得到"待应用 N 条 / 末条 tag"；镜像不支持时降级为"目标版本声明总数 + 增量未知"，并在摘要中如实标注。**这是唯一的例外路径，且仍是"问镜像"，不是 CLI 查库。**
- **manifest 的迁移字段**：`migrations: { server: {count,last_tag,last_hash}, gateway: {…} }`；跨多版本升级不需要中间版本 manifest（drizzle 按 journal 顺序补齐，CI 已有迁移安全与 journal 一致性门禁守着这个前提）；`min_source_version`（可选）用于"必须经由某中间版本"的未来场景。

---

## 7. 生成器与 `deploy_format`

### 7.1 渲染是纯函数

```
render(deploy_format, config, probe) -> Artifacts
  probe = docker/compose 版本、架构、judge socket 探测结果、judge 开关、安装目录（用于派生项目名）
  Artifacts = { docker-compose.prod.yml, deploy/{nginx,minio}/*,
                env.delivery.json, artifact_hash }
```

无 IO、无时钟（时间戳参数注入）。**compose 项目名按安装目录派生**：`name: noj-<install_dir 的 8 位摘要>`，可用 `NOJCTL_PROJECT_NAME` 覆盖；派生值进入 `state.json.project_name`，PREPARE 检查同名项目是否已被**其它安装目录**占用，冲突即拒绝（退出 3）。被挂载的文件总是物化；**不再包含 monitoring 的 4 个文件**（§1.1）。

### 7.2 Solver 注册表与选择（失败关闭）

```rust
trait Solver { fn deploy_format(&self) -> u32; fn render(&self, cfg, probe) -> Result<Artifacts>; }
```

| 情形 | 行为 |
| --- | --- |
| manifest 声明 `deploy_format = N`，N 在支持集合 | 用对应 solver（**老 `nojctl` 照旧能装新版本**，只要格式没变） |
| `N >` 已知上限 | 退出 5："该版本需要 nojctl ≥ x.y" |
| `N <` 支持下限 | 退出 5："该版本使用已停止支持的部署格式 N" |

`deploy_format` 来源两条路收敛到同一结构：① Release 资产 `nojctl-manifest.json`；② **镜像 label** `org.noj.deploy-format`（离线时对本地镜像 `docker image inspect`）。两条都拿不到 → 失败关闭。

### 7.3 manifest 与 CI 不变量

```jsonc
{ "manifest_schema": 1, "version": "0.10.1-beta.3", "deploy_format": 3,
  "min_nojctl": "0.1.0", "min_source_version": "0.9.0",
  "images": { "noj-server": "ghcr.io/…@sha256:…" /* 7 个 */ },
  "migrations": {
    "server":  { "count": 95, "last_tag": "0094_…", "last_hash": "…" },
    "gateway": { "count": 5,  "last_tag": "0004_…", "last_hash": "…" } },
  "published_at": "…" }
```

`migrations` 只存最小可验证集（计数 + 末条 tag + hash）：迁移的权威在数据库的 `__drizzle_migrations` 表。

**CI 三条不变量**（缺一条，前向兼容就会开始撒谎）：

1. manifest 里 7 个 digest 与实际推送的镜像一致；
2. 用**发布版 `nojctl`** 渲染目标版本 → `docker compose config -q` 通过；
3. 用渲染产物**真起栈 e2e**。

### 7.4 "文档化的键必进容器"两层

1. **构建期（CI 门禁）**：schema 里每个键，要么出现在某服务的 `environment` / `env_file`，要么显式标记 `nojctl-only`。"文档化但无交付目标" = CI 失败（12 个键的永久防线）。
2. **运行期（`deploy` / `apply` 前置）**：`.env.prod` 存在的键对照 `env.delivery.json`——存在但无人接收 → 警告并列出；必需但缺失 → 失败（退出 3，指出键名 + 行号）。

### 7.5 模板与测试

- 模板用 `include_str!` 的文本模板 + 受控的最小替换/条件块；渲染后**双重结构校验**（YAML 解析 + `docker compose config -q`）。
- **黄金文件**：每个 `deploy_format` × 代表配置（最小 / judge 开 / judge 关 / **http 明文** / https 域名 / 自定义端口 / 自定义 `NOJCTL_PROJECT_NAME`）。
- **确定性**：同输入两次渲染 `artifact_hash` 相同；键顺序无关。
- **兼容性**：每个"声称支持的 `deploy_format`"都跑 §7.3 的第 2、3 条。

### 7.6 bump `deploy_format` 的规则

判据清单：服务/profile 增删改、卷与网络集合变化、挂载文件集合变化、必需配置键增删或语义变化、健康检查/就绪语义变化、镜像名集合变化。**只有"旧 solver 产不出新版本所需描述"时才 +1**；纯镜像版本升级、注释与文案变化一律不动。这份清单同时是发布检查表的一项。

---

## 8. 备份与还原

### 8.1 产物：单文件、加密、自描述

```
snapshot-20260927-0712-<应用版本>.nojbackup      # tar → zstd → GPG 对称加密
├─ manifest.json    # schema、nojctl 版本、应用版本、deploy_format、迁移摘要、
│                   # 各组成部分大小与 sha256、关键表行数、对象清单摘要、创建时间
├─ postgres.dump    # pg_dump --format=custom
├─ redis.rdb        # Redis 快照（JWT 撤销名单 / 队列 / claim）—— v1 有，本稿补回
├─ objects/         # MinIO 桶内容（mc mirror 导出）
├─ volumes/         # noj-packages、noj-storage（存在则含）
└─ .env.prod        # 加密内含（没有它恢复不出可运行的实例）
```

- **默认强制加密**：没有 passphrase 就拒绝创建（内容是全部学生数据 + 密钥）。`deploy` 时自动生成随机 passphrase 存 0600，**要求二次确认输入以证明已抄写**，并显示口令指纹（前 8 位 sha256）便于日后核对；丢失 passphrase = 备份不可恢复。
- **同盘风险显式提示**：备份默认落在 `<dir>/backups/`，与数据同盘；完成页与 `doctor` 都提示"至少复制一份到服务器之外"，并给出一行 `scp` / `rsync` 示例。

### 8.2 命令

| 命令 | 语义 | 门禁 |
| --- | --- | --- |
| `backup create` | **不需要停机**（`pg_dump` 事务一致；Redis 用 `BGSAVE` + 取 `dump.rdb`；对象 `mc mirror` 应用层一致）→ 打包 → **自动 verify 一次** → 打印 id/大小/耗时；任一步失败即删除半成品 | 无 |
| `backup list` | id / 时间 / 应用版本 / `deploy_format` / 大小 / 最近一次 verify 结果 / 磁盘占用 | 无 |
| `backup verify <id>` | **不需要栈运行**：sha256、GPG 可解、tar 可读、`pg_restore -l` 可解析、manifest 自洽、对象清单匹配、关键表行数与 dump 记录一致 | 无 |
| `backup restore <id>` | 唯一改写数据的命令（§8.3） | 最强口令 |
| `backup prune` | **默认 dry-run（零删除）**，`--confirm` 才真删；保留最近 N（默认 7）+ 至少 1 个已验证；**永不删"最近一个验证通过的"** | 需 `--confirm` |

### 8.3 `restore` 序列

1. 前置：`verify <id>` 必须通过；备份的应用版本与当前部署不同 → 警告"恢复后建议 `apply` 到匹配版本"，**不自动切版本**。
2. 门禁：`I UNDERSTAND THIS WILL OVERWRITE CURRENT DATA`。
3. **安全网**：自动给"当前数据"打一份快照；若因磁盘不足失败，必须显式 `--skip-safety-snapshot` 才能继续。
4. 停写入者：停应用层（`nojctl stop`）与 minio；**postgres 与 redis 保持运行**（它们要接收还原）。
5. 还原 DB：`pg_restore --clean --if-exists --no-owner --exit-on-error`（失败即整体回滚，不留半套 schema + 半套数据）。
6. 还原 Redis：停 redis → 写入 `dump.rdb` → 启动 redis。
7. 还原对象与卷：解包回 minio / packages / storage 卷（辅助容器），再起 minio。
8. 起应用层（`nojctl start`）+ **VERIFY（唯一做数据核对的地方）**：容器健康 + HTTP + 语义冒烟 + **关键表行数与备份 manifest 一致** + 对象条数一致。
9. 收尾：记 `state.last_restore`；打印"数据已恢复到 `<备份时间>`（id `<id>`）"+ 建议（`doctor`；版本不同则 `apply <该版本>`）。

### 8.4 边界

`apply` 永不调用 backup/restore；`restore` 永不自动切版本；`backup` 永不改部署描述。**跨机恢复是备份存在的首要理由**，写成手册化步骤（`scp` 快照到新机 → `deploy` → `restore` → 验证 → 改 DNS → 老机下线），并进 e2e（§10.5）。

---

## 9. 分发、目录与共存

### 9.1 分发模型：独立二进制

- **不软链、不写 PATH、不改 `~/.profile`、不把自己复制进安装目录**；v1 的 `path.ts` 整块消失。
- 调用模型：`nojctl [--dir <安装目录>] <命令>`，`--dir` 缺省为当前目录；安装目录里只有数据与生成物。
- `uninstall` 明确输出"工具二进制不归我管，请自行删除"。
- 该模型同时是 B 模式（将来由本地驱动远端）的天然形状。

### 9.2 目录布局与所有权

```
<install_dir>/
├── .env.prod                 用户所有（0600，手写）；nojctl 只在首装/补缺失键时写
├── docker-compose.prod.yml   nojctl 生成（头部声明）
├── deploy/                   nojctl 生成（nginx / minio）
├── .env.prod.example         nojctl 生成（带注释的键清单）
├── .nojctl/                  nojctl 独占：state.json / lock / generations/
└── backups/                  单文件快照
```

### 9.3 目录判据（拒绝外来目录）

以 **`.nojctl/state.json` 是否存在**为唯一判据：

| 目录状态 | 行为 |
| --- | --- |
| 不存在 / 完全为空 | `deploy` 允许（不存在则创建） |
| 含 `.nojctl/state.json` | 视为本工具目录：`deploy` 进入**续跑/复用**分支，`apply` / `start` / `stop` / `backup` / `uninstall` 正常 |
| 无 state，且除保留物（`.env.prod`、`backups/`、本工具生成物）外还有其它条目 | **拒绝写操作**（退出 3），列出外来条目 |
| 无 state，仅含保留物或本工具生成物 | `deploy` 允许（覆盖生成物、保留 `.env.prod` 与 `backups/`） |

只读命令（`status` / `doctor` / `logs` / `versions` / `backup list`）可在外来目录运行，输出置顶 `⚠ 该目录不是 nojctl 管理的，本工具不会改动它`。

**结论**：① 原子性在第一次就成立（受管部署永远至少有一个世代）；② 卸载后目录可直接重装（`uninstall` 保留 `.env.prod` + `backups/` 属于"仅含保留物"）；③ **`nojctl` 不接管任何既有安装**——迁移走人工手册（§12 批次 6.5）。

### 9.4 漂移守卫

live 文件与 `current` 世代的 `artifact_hash` 不一致（手改、被 v1 覆盖等）→ **破坏性操作 fail-closed**，提示"部署文件不是 nojctl 生成的/已漂移，请先 `nojctl apply` 恢复受管状态"；`status` / `doctor` 照常报告差异清单。

### 9.5 卸载与交接

- `uninstall`（默认）：停栈 + 移除 `.nojctl/` 与生成物；**保留** `.env.prod`、数据卷、`backups/`；目录处于"可直接重装"状态。
- `--purge`：额外删数据卷 + `.env.prod` + 备份（口令 `I UNDERSTAND THIS DELETES ALL DATA`）。
- **永不自动删除**：数据卷、备份、`.env.prod`（`--purge` 例外）。
- **交接**：`uninstall` 不动任何东西之外，`doctor --bundle` 与文档的"权限与交接"小节（US-12）共同承担换届场景。

---

## 10. 测试与验收

### 10.1 故障注入矩阵（证明"原子"不是口号）

| 注入点 | 断言 |
| --- | --- |
| PREPARE：渲染失败 / 生产配置判据不过 / digest 不符 / 拉镜像失败 | 线上零改动；退出 3 或 6；live 文件与 `current` 一致 |
| COMMIT：`up -d` 非零 / `migrate` 非零 / `SIGKILL` | 要么"旧世代且健康"（6），要么"`partial` + journal 可判定"（7）；**永不出现混合状态** |
| VERIFY：健康超时 / HTTP 非 200 / **登录往返失败** / digest 不符 / judge 容器冒烟失败 | 自动回退触发；回退后退出码按 §5.2 判据；站点可用 |
| 首装失败（无 `previous`） | 输出"未安装成功 + 原因 + 下一步"；退出 3 / 6 / 7 之一；重跑 `deploy` 幂等续跑成功 |
| 回退本身失败 | 退出 7；`state=partial`；报告含恢复步骤与建议备份 id |

绝大多数用注入的 `Runner`（假 docker）跑；关键路径用真 docker 跑少量（含提交窗口内 `SIGKILL` 后重跑 `apply` 的崩溃恢复用例）。**不变量测试**：任何注入后都必须满足"live hash == `current` hash"或"`state=partial` 且 journal 可判定"。

### 10.2 幂等与零副作用

`apply` 两次 → 第二次 no-op（退出 0、零写操作）；`deploy` 中断后重跑幂等；`--dry-run` 用假 `Runner` 断言没有任何写调用；`doctor` 纯只读（`--bundle` 只写一个 tar）。

### 10.3 生成器测试

黄金文件（每个 `deploy_format` × 代表配置，含 §6.7 的 `migrate` + `depends_on` 不变量、项目名派生、http/https 两种协议）；确定性（同输入同 hash）；双重结构校验；§7.4 第 1 层的 CI 门禁。

### 10.4 契约测试

退出码表每个码至少一个用例（含 §5.2 单一判据的两侧）；`--json` schema 快照 + "字段只增不改"守卫；门禁三条路径（TTY 口令错/对/两次失败；非 TTY 报错与参数；豁免路径；严格模式下无近期备份 → 4）；目录判据四种状态；项目名冲突拒绝。

### 10.5 e2e（真 docker，CI）

空目录 `deploy`（http 与 https 各一次）→ 健康 → 语义冒烟 → `doctor` 通过 → `backup create` + `verify` → **仅配置变更**的 `apply` → **换版本**的 `apply` → `stop` / `start` → 注入失败版本断言自动回退 → **跨机恢复**（新目录 `deploy` → `restore` → 验证）→ 目录判据与项目名冲突用例。

### 10.6 发布门禁

发布 workflow 增补四步：① manifest 的 7 个 digest 与实推镜像一致；② 发布版 `nojctl` 渲染 + `config -q`；③ 真起栈 e2e；④ **用上一版 `nojctl` 装这个新版本**（前向兼容的逆向验证）。

---

## 11. 验收口径

- [ ] `deploy` 在空目录上从零到**可用**（含 rootless 引导与浏览器可访问性检查），全程无需用户理解 compose / env / Docker
- [ ] http 与 https 两条路径都能通过 core 的生产配置校验；明文路径明确告知 Cookie 放宽与收紧方式
- [ ] 邮件未配置时，完成页明确显示"公开注册目前关闭"与补救步骤
- [ ] `apply` 覆盖四种情形（版本变更 / 配置变更 / no-op / 崩溃恢复），门禁与退出码符合 §5.2–5.3
- [ ] `start` / `stop` 覆盖应急停站与恢复；`apply` 不改变运行态
- [ ] 任一注入点失败后系统要么回到上一世代且健康（6），要么 `partial` 且可判定恢复（7）；无混合状态
- [ ] 备份：单文件加密、含 Redis、`verify` 不依赖运行中的栈、`restore` 前自动安全网、`prune` 默认 dry-run、跨机恢复 e2e 通过
- [ ] 目录判据四种状态、项目名冲突、漂移守卫按 §9.3–9.4 生效
- [ ] `doctor` 报告 TLS 剩余天数、磁盘可回收量、备份新鲜度；`doctor --bundle` 产出可发给维护者的诊断包
- [ ] 生成器：黄金文件 + 确定性 + 双重结构校验通过；"文档化的键必进容器"CI 门禁通过
- [ ] 现有运维文档（4 份）与新命令面同批发布
- [ ] 本设计不改动 core / judge / ui / gateway 的既有行为（仅新增两个可选只读命令）

---

## 12. 交付批次

| 批次 | 内容 | 依赖 |
| --- | --- | --- |
| **1** | 骨架：`Runner`/seams、`state` + `state.json`、`cli`/`ui`（`--json`/退出码）、目录判据、锁 | — |
| **2** | `render` + `deploy_format` 注册表 + 项目名派生 + 黄金文件 + manifest 取数与校验 | 1 |
| **2.5** | core 侧增补：`noj config check --json`（生产配置判据）与 `noj db status --json`（迁移增量，可选能力，向后兼容） | — |
| **3** | `plan` + `apply` 事务（PREPARE/COMMIT/VERIFY/回退/崩溃恢复/首装失败）+ 故障注入测试 | 2 |
| **4** | `deploy` 向导（含协议一问、邮件后果文案、rootless 引导、完成页检查清单）+ 非交互等价 | 3 |
| **5** | `backup` / `restore`（含 Redis、加密与口令二次确认、verify、安全网、跨机恢复） | 1 |
| **6** | `status` / `logs` / `doctor`（TLS、磁盘、`--bundle`）/ `versions` / `start` / `stop` / `core --` / `uninstall` | 3,5 |
| **6.5** | **迁移手册**（人工步骤 + CI 演练清单）：v1 目录 → nojctl 目录（数据导出/导入、域名与证书切换、回滚点） | 5 |
| **7** | 发布链路：manifest 资产 + CI 四道门禁 + 用上一版 CLI 的逆向验证 | 2,3 |
| **7.5** | **文档切换**：`production-deploy.md` / `judge-workers.md` / `cli.md` / `noj-cli/README.md` + 权限与交接小节 | 4,6 |

实施计划**按批次拆分**：建议第一份计划覆盖**批次 1–3**（含 2.5 的 core 侧增补），因为 `apply` 的原子语义是整个设计的承重墙；批次 4–7.5 各自成计划，可并行推进。

---

## 13. 开放问题与 follow-ups

1. **`email_provider` 运行时化**（跨模块）：把它与凭据从 `bootstrap` scope 迁到 `runtime`（DB 管理），让后台邮件页真正做到启动日志承诺的事；在此之前，nojctl 必须承担"邮件配置只能在服务器上改"的披露与引导。
2. **judge 网络收窄**（只给 redis + minio）——降低横向面最值钱的一步。
3. **`JUDGE_ALLOW_HTTP_S3` 默认改 false**、**production 下禁用 `local` 下载 scheme**。
4. **`v1 → nojctl` 迁移工具**（当前只有人工手册）。
5. **恢复演练 `drill` 自动化**、**定时/异地备份**。
6. **B 模式（SSH 远端执行）**：`Runner` seam 已留。
7. **aarch64 与 Windows / macOS 产物**。
8. **`noj` 名字的收编**：容器内 `/app/bin/noj`（`db`/`init`/`bootstrap`/`problem`）与宿主机 CLI 同名不同物；将来若统一为 `noj`，需先给容器内 CLI 改名（本次通过 `core --` 透传缓解）。
9. **独立判题机 / 第二 Worker**（`judge-workers.md` 的拓扑）：nojctl v1 不支持，只能文档化并明确声明。
10. **多实例**：本稿用"项目名派生 + 冲突拒绝"支持同机多安装；"一个 nojctl 管多个安装目录"记为开放问题，不影响 v1 交付。
