# nojctl 部署运维 CLI 设计（Rust 重写）

Status: draft-4（已吸收三轮 PM 审计；待项目所有者复审）
日期：2026-09-27
范围：新增 `nojctl`（Rust，musl 静态二进制）；`noj-cli`（TS 版）冻结不再演进；发布链路（`release.yml` + CI）新增 manifest 资产与四道门禁；`noj-core` 增补三个**向后兼容的本地只读/本机授权**能力（`noj config check --json`、`noj db status --json`、`noj bootstrap first-admin --password-file`）；不改动 core / judge / ui / gateway 的既有行为
基线：main @ `63615a81`（含本 spec draft-3 与三轮 PM 审计）

---

## 0. 变更记录

### 0.1 draft-3 相对 draft-2（吸收复审 [N1–N12] 与 Blocker 缺口）

| 复审项 | 本稿改法 |
| --- | --- |
| **N1** `apply` 不改运行态 vs COMMIT `up -d` / FINALIZE `state=running` / VERIFY 要求 healthy（三方冲突） | §4.2 不变量 5 改为"`apply` 不**主动改变**运行态"：进入时 `stopped` 的栈，提交阶段**临时启动以完成 VERIFY，成功后自动回到 `stopped`**；`FINALIZE` 按**进入时的运行态**写 state（不再硬编码 `running`）；摘要与 `--dry-run` 明示该行为；§10.4 增契约测试 |
| **N2** "无 state 但已有 `.env.prod`"分支未定义 | §9.3 明确"本工具生成物"的判定 = 带 nojctl 头部声明或位于 `.nojctl/` 下；新增"仅含保留物/本工具生成物（含来自卸载或仅剩 `.env.prod`）"的行，并说明复用规则 |
| **N3** 项目名把安装目录绑进 `artifact_hash` → 搬目录触发漂移与孤儿容器卷 | §6.1 引入 `install_id`（部署时生成、持久化）；§7.1 项目名由 `install_id` 派生（不再依赖路径），一旦部署即固定；§5.5/§6.6 增加"安装目录变更"的检测与提示（不影响项目名） |
| **N4** 回退文案把"增量未知"写成"未推进" | §6.3 回退输出改为**只陈述可证实的事实**，来源限定为 `migrate` 服务的退出码与日志；无法判定时写"无法判断（迁移服务未运行）" |
| **N5** 登录冒烟无密码来源（`first-admin` 强制 TTY） | §12 批次 2.5 增补 `noj bootstrap first-admin --password-file <path>`（保持"本机授权"语义，只去掉 TTY 要求）；§5.5 改为**由 nojctl 生成管理员密码**（只打印一次、强制首登改密、绝不写入 state/世代/日志，日志脱敏断言进测试）；跳过建号时登录冒烟**显式 warning**（不静默） |
| **B1 缺口①** 第④问"可选"导致冒烟可被跳过 | 第④问改为**默认创建**（`[Y/n]`，默认 Y），跳过时必须说明后果并给出事后命令 |
| **B1 缺口②** VERIFY 探测目标未定义（HTTPS 推荐路径会自我失败） | §6.6 明确：所有本地探测走 `127.0.0.1:<NGINX_PORT>` + `Host: <DOMAIN>` 头，**不**走外部域名；外部可达性（DNS/TLS）只在完成页做**非阻断**检查 |
| **B1 缺口③** 黄金文件未断言 `NOJ_ALLOW_INSECURE_HTTP` 同时进 core 与 ui | §7.5 黄金文件断言清单显式加入"该键同时出现在 core 与 ui 两个服务" |
| **B2** 缺自助补救路径 | §5.5 完成页固定"开放注册前置"区块（要改的 4 个键 + 从哪取值 + `nojctl apply`）；`status` / `doctor` 在邮件未配置时常驻提示 |
| **B5** 迁移手册未定义未验证 | §12 批次 6.5 给出**手册大纲**（导出 → 一致性窗口 → 导入 → 验证 → DNS 切换 → 观察期 → 回滚点），并在 CI 演练清单中验证 |
| **N6** 退出码字面冲突 | §5.2 判据改写为可证实的二分：**6 = 确认未发生任何迁移且已回退并验证通过**；**7 = 迁移可能已前进（退出非零或已应用≥1 条）/ 回退失败 / 首装留下 partial**；§6.7 表同步 |
| **N7** `start` / `stop` 在 `uninitialized` / `partial` 未定义 | §5.1 明确：`uninitialized` → 退出 3（提示先 `deploy`）；`partial` → 退出 3 并建议 `doctor` 或重跑 `apply` |
| **N8** `stop` 被混入"非破坏性"豁免 | §5.3 豁免项改写：`start` / `stop` 影响可用性但不涉版本与数据，故不要求口令；`stop` 需一次 `[Y/n]` 确认 |
| **N9** 值不自洽时只给行号 | §5.7 交叉约束失败必须给**二选一修复建议** + 可复制编辑指引 |
| **N10** judge 冒烟用最小镜像在受限网络下误判 | §6.6 改为使用屏幕 3 已预拉的评测镜像（`noj-evaluator-python:<版本>`） |
| **N11** 可达性检查漏掉 `NOJ_IMAGE_REGISTRY` | §5.5 屏幕 0 分别检查**镜像仓库**（默认 ghcr.io，可被 `NOJ_IMAGE_REGISTRY` 覆盖）与 **manifest 所在 GitHub**，并分别给指引 |
| **N12** `--acknowledge-*` 出现在全局 help | §5.3 明确：这三个参数只出现在对应子命令的 help 中，不进全局 `--help` 首屏 |
| **PM UX-1** rootless 绑定首装成功率 | 见 §0.2（judge 改为可选二级项） |
| **PM UX-2** 屏幕 0 静默、拉镜像无心跳 | §5.5 屏幕 0 改为**非静默**（我是谁 / 要多久 / 正在检查什么）；屏幕 6 拉镜像给**心跳 + 预估剩余 + 超时改为询问 + 断点续传说明** |
| **PM UX-3** 完成页信息不全 | §5.5 屏幕 7 固定**五段**：能用什么 / 账号 / 必须抄写 / 还没开启的功能 / 现在就做的两件事 |
| **PM UX-4** 认知负荷 | §11 验收口径新增"**必须理解的概念清单**"（教练只需理解 5 个；其余必须被完全隐藏），作为验收项 |
| **PM UX-5** 降级路径 | §5.5 与 §13 覆盖四种降级（缺域名 / 缺证书 / 2 GB 内存 / 网络受限） |
| **PM UX-6** 15 分钟上手材料 | §12 批次 7.5 新增交付物（章节清单见该批次） |

### 0.2 项目所有者在 draft-2 之后的三处定调

1. **门禁形态不变**：保留"输入全大写英文口令"（不采用"随机 4 位码 + 选项菜单"）。可选严格模式 `NOJCTL_REQUIRE_RECENT_BACKUP_DAYS` 默认仍为 `0`（关闭）；备份不新鲜时**只升级提示语气，不阻断**。
2. **judge 改为 `deploy` 的可选二级项**：`deploy` 只做三个必答问题；"是否在本机安装 noj-judge"是**二级选项**，**默认跳过**；选"是"才进入 rootless 引导（打印脚本 → 等回车 → 7 项探测 → 可重试或放弃），选"否"则记 `JUDGE_ENABLED=false` 并把"第 2 步：开启判题（约 15 分钟）"写进完成页。
3. **A 类修复全做**（本表的 N1–N12 与 Blocker 缺口）。

### 0.4 draft-4 相对 draft-3（吸收第三轮复核 R1–R9）

第三轮复核（[round3](../audit/2026-09-27-nojctl-design-pm-audit-round3.md)）判定 N1–N12 已关闭 9 / 部分关闭 3 / 未关闭 0，但**本轮修复自身带出 18 条新问题**。本稿按"范围受控：6 修 + 2 补"处理高优先项，其余降级为实现阶段注意事项（§13.12）。

| 复核项 | 本稿改法 |
| --- | --- |
| **R1**（高）安装身份与实例级密钥不随数据延续：`uninstall` 删 `.nojctl/` → `install_id` 丢 → 项目名变 → 卷名（由项目名派生，`docker-compose.prod.yml:514-523` 无 `name:`/`external:`）变 → **重装后新建空卷、旧数据成孤儿**；同路径下密钥被重新生成 → Postgres 凭据不匹配起不来 / TFA 学生登录不上 / LLM 题静默失败 | **安装身份移入 `.env.prod`**（`# [仅 nojctl 使用]` 分区：`NOJCTL_INSTALL_ID`、`NOJCTL_PROJECT_NAME`）——`uninstall` 保留 `.env.prod`，因此身份与数据一起延续；§5.5 屏幕 2 增加**密钥沿用例外**（复用既有 `.env.prod` 时一切已有键**沿用原值**，只补缺失键；仅全新首装才生成新密钥）；§7.4 增加 fail-closed 校验（**已有数据卷但无对应身份/配置 → 拒绝**）；§10.5 与 §11 增加"卸载后重装不丢数据"的 e2e 与验收项 |
| **R2**（高）"第 2 步：开启判题"没有命令落点（默认路径的必经下一步无路可走） | 新增 **`judge enable` / `judge disable`**（一个命令两个子命令）：`enable` 完整复用屏幕 3 子流程（打印 rootless 脚本 → 等回车 → 7 项探测 → 预拉评测镜像 → 写 `JUDGE_ENABLED`/socket/gid 键 → 走一次 `apply` 事务 + VERIFY #4）；完成页"第 2 步"直接打印这条命令；§9.3 同时收紧 `deploy` 在已初始化目录上的语义（不再有含糊的"续跑/复用"） |
| **R3**（高）迁移手册缺"实例级加密密钥必须原样携带"清单（数据在但读不出来） | §12 批次 6.5 增加**实例级密钥携带清单**与验证步骤（`JWT_SECRET` / `TFA_ENCRYPTION_KEY` / `NOJ_LLM_STORE_KEY` / `NOJ_LLM_SERVICE_TOKEN` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `MINIO_ROOT_*` / `S3_*`），并要求抽查"一名启用 TFA 的用户能登录 + 一个 LLM 题能跑" |
| **R4**（高）`deploy` 的 FINALIZE 无值可写（首装进入态是 `uninitialized`） | §6.3 FINALIZE 明确映射：`uninitialized`（首装）→ 写 `running`；`stopped` → 临时启动验证后回 `stopped`；`running` → `running`；§10.4 增加"首装后 `state=running` 且 `stop` 可用"的用例 |
| **R5**（中）HTTPS 路径下登录冒烟可能被 `Secure` Cookie 规则误杀 | §6.6 #3 改为**与 Cookie 语义解耦**：用登录响应体里的 JWT 作 `Authorization: Bearer` 调 `/auth/me`（不依赖 Cookie 存储）；`Set-Cookie` 的 `Secure` 属性只做**非阻断断言**（http+放宽 → 非 Secure；https → Secure）。token 不落盘、不回显 |
| **R6**（中）`--yes` + `--json` 时管理员密码无处安放（与 stdout 纯净冲突） | 新增 `--admin-password-out <path>`（0600，拒绝覆盖既有文件与宽松权限）；**`--json` 下密码永不进 stdout**；非交互且未给该参数时**跳过建号并显式 warning**（附 `core -- bootstrap first-admin` 命令）；交互式仍在完成页只显示一次 |
| **R7**（中）`migrate` 日志只有三行（无计数、无"无待应用"标记）→ 四值表不可实现 | §12 批次 2.5 增补"迁移结果的机器可读日志行"（core 侧）；在镜像支持前，§6.3 的四值表**降级为两值**（"退出 0" → 仍**无法确认** → 按 §5.2 判据取 7，并在文案中如实写"无法确认"）；§6.7 同步 |
| **R8**（中）复制目录会连 `install_id` 一起复制 → 冲突检查失效，两目录管同一 compose 项目 | §7.1 冲突检查改为**读 compose 项目标签**（`com.docker.compose.project` + `working_dir`）：同名项目已存在且 `working_dir` 不是本目录 → 拒绝（退出 3）并说明如何处置 |
| **R9**（中）`NOJCTL_PROJECT_NAME` 与 `state.project_name` 谁权威未定义 | §7.1 明确权威顺序：`.env.prod` 的 `NOJCTL_PROJECT_NAME`（若存在）> 由 `NOJCTL_INSTALL_ID` 派生 > 首次部署时生成并写入；`state.project_name` 只是**镜像**，不一致即 fail-closed 并给指引 |
| 门禁三条缓解（形态不变） | §5.3 增加：门禁前多打一行"建议先 `nojctl backup create`"；口令后附中文对照；备份新鲜度作为风险块的**标题行**（而非列表末行） |

**降级为实现阶段注意事项**（不构成返工，写进第一批实施计划的验收清单）：`stop` 在 `partial` 下必须**允许**（应急停站）、`stopped` + 无变化时的 no-op 文案、PREPARE 失败也属"线上未被触碰"的 6、首装失败按"迁移是否可能已推进"判 6/7、`--password-file` 的 0600+owner 校验、密码临时文件优先走 `/dev/stdin` 以免落盘、`--dir` 相对路径规范化为绝对路径、`.env.prod` 由工具写前自动留 `.env.prod.bak-<时间>`、错误建议附"搜索键名"提示、CLI 生成类键注明"手改会在下次重写时被覆盖"。

### 0.3 draft-2 相对 draft-1（首轮审计吸收，索引保留）

首轮 7 Blocker / 14 Major / 8 Minor / 6 处自相矛盾的逐条落点，见 draft-2 的变更记录（git 历史 `e798da71^..e798da71`）。要点：协议一问与 `NOJ_ALLOW_INSECURE_HTTP` 推导、生产配置判据前移、语义冒烟、首装失败语义、邮件后果披露、`start`/`stop`、目录判据、项目名派生、前置指引、文档批次；备份补回 Redis；`core --` 逃生舱；退出码单一判据；删除 monitoring 渲染；`.env.prod` 三类键；门禁明确为知情声明。

---

## 1. 背景与目标

部署与运维是 NOJ 目前**唯一没有原子性、也最容易把非技术运营者卡住**的环节。目标受众是**没接触过服务器运维的运营者（如学校教练）**：他们能拿到一台 Linux 服务器和一个域名，但不该被迫理解 compose / env 文件 / rootless Docker / 数据库迁移不可逆这些概念。

本设计重写部署运维 CLI（二进制名 **`nojctl`**），交付四件事：

| 编号 | 目标 | 一句话 |
| --- | --- | --- |
| **D** | 部署状态机与原子提交 | 版本切换是一个可回退的事务；失败自动回到上一世代 |
| **G** | 生成式部署描述 | compose 与挂载文件由 `nojctl` 渲染，配置只有一个真相源（`.env.prod`），"填了不生效"在结构上不可能 |
| **O** | 面向零基础运营者的交互 | 三问向导 + 可选二级项；`apply` 一个动词解决版本与配置变更；风险在知情状态下确认 |
| **U** | 站"可用"而不只是"起来了" | VERIFY 做语义冒烟；完成页给出 DNS/TLS/开放注册的前置检查；首装成功判据 = 学生能访问到站 |

### 1.1 非目标（明确不做）

- **不接管任何既有安装**，**不兼容 v1 产物**（不读 `snapshot-*.nojbackup`，不嗅探 `.bootstrap-*.tmp` / `.env.prod.staged`）。迁移走**人工手册**（§12 批次 6.5）。
- **不做 `config` 子命令**：`.env.prod` 由用户手写 + 工具校验（无白名单代改）。
- **不做恢复演练 `drill`**、不做定时/异地备份、不做出题包管理、不做判题机独立安装、不做全屏 TUI。
- **不支持系统 Docker daemon 跑 judge**：judge 只有"同机 rootless 开"与"关"两个状态（用 `judge enable` / `judge disable` 切换）。
- **不渲染 monitoring**：生成的 compose 不含 `prometheus` / `alertmanager` 与其挂载文件。
- **不把 judge 网络收窄、不改 `JUDGE_ALLOW_HTTP_S3` 默认值、不在 production 下禁用 `local` 下载 scheme**（记为 follow-up，§13）。
- **不提供 TLS 终止**：沿用"TLS 由外部边缘终止"的模型，nojctl 只把 `APP_URL` / CORS / Cookie 标志**配成一致**，并检查握手与到期。
- **不交付 Windows / macOS 产物**；**不支持 SSH 远端执行**（B 模式只留 `Runner` seam 与契约文档）。

### 1.2 关键判断

1. **"原子"必须在第一次就成立**，因此不接受任何"从外来状态开始"的路径（§9.3 的目录判据是前提）。
2. **升级链路不对数据负责**：`apply` 不备份、不还原、不碰数据；数据安全归 `backup` / `restore`。口令门禁是**知情声明**（§5.3）。
3. **schema 归镜像，触发归 compose，`nojctl` 只观测**：部署链路零数据库访问（§6.7）。
4. **拿不准就失败关闭**：`deploy_format` 不认识、别名无解、资产不齐、manifest 校验不过、目录判据不过、项目名冲突 —— 一律拒绝并说清下一步。
5. **生成物归 CLI、配置归用户**：compose、`deploy/*`、`.env.prod.example`、`.nojctl/**` 由 `nojctl` 生成并覆盖（文件头带声明）；`.env.prod` 只在首装向导与补缺失键时写入（§5.7 三类键）。
6. **首装的成功判据是"学生能访问到站"**：因此判题与邮件都不阻塞首装（二级项 + 完成页"第 2 步"）。

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| **`deploy_format`** | 部署描述的**格式版本**（整数，单调递增）。规定 compose + 挂载文件 + 必需配置键 + 健康语义的形状；只在"旧渲染器产不出新版本所需描述"时 +1。不是产品版本 |
| **世代（generation）** | 一次可原样复原的**部署描述**快照：compose + 挂载文件 + 该世代实际生效的配置快照 + manifest + hash。**仅部署描述，不含任何数据**；`current` 为 live，`previous` 供回退 |
| **`install_id`** | 安装身份，持久化在 **`.env.prod` 的 `NOJCTL_INSTALL_ID`**（state 里是镜像值）：compose 项目名由它派生，命名卷由项目名派生，因此"卸载后重装"与"搬目录"都不丢数据、也不影响 `artifact_hash` |
| **`state`** | 栈的运行态：`uninitialized` / `stopped` / `running` / `partial`（另有 `last_error` 字段）。运行态由 `start` / `stop` 改变 |
| **`apply`** | 唯一让"部署描述与期望一致"的命令（版本变更、配置变更、no-op、崩溃恢复四合一）；**不主动改变运行态**（§4.2 不变量 5） |
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
4. **"填了不生效"**：`.env.prod.example` 文档化 69 键、compose 引用 108 处，交叉审计发现 **12 个键从未被引用**；其中 7 个邮件凭据与 `JUDGE_REQUIRE_ISOLATED_DOCKER` 属真漏。
5. **v1 不物化挂载文件**：`bootstrap` 只下载 compose + env 模板，而 compose 挂载 `deploy/` 下 6 个文件 → 全新安装起不了 nginx。
6. **升级后 502**：core/ui 重建后容器 IP 变化，nginx 自身配置未变、不会被 `up -d` 重建 → upstream 指旧 IP。
7. **没有原子回退**：原地改文件 + `up -d`；中断后留下 `.bak-*` / `.orig` / `.staged` 残骸。
8. **环境事实**：目标服务器常处于受限网络（Docker Hub 直连超时、`sudo` 需密码）；发布侧必须自带可离线验证的 manifest，nojctl 必须给镜像源/离线出路。
9. **明文 HTTP 是真实路径**：production 校验要求 `APP_URL` / CORS 为 HTTPS（`production-config.ts:84/117`）且是 `fatalStep`（`main.ts:272`）；v1 由 scheme 推导 `NOJ_ALLOW_INSECURE_HTTP`（`noj-cli/src/prod/config.ts:1071`）。
10. **`first-admin` 只接受交互终端**：`noj-core/scripts/noj.ts:231-241` 在非 TTY 直接抛错并用 `Secret.prompt` 读密码 —— 因此非交互部署既建不了首个管理员，也跑不了登录冒烟（§12 批次 2.5 增补 `--password-file`）。

---

## 4. 架构与不变量

### 4.1 分层

| 层 | 职责 | 关键性质 |
| --- | --- | --- |
| `cli` | clap 命令面：解析、帮助、别名展开 | 零业务逻辑；`--acknowledge-*` 只出现在对应子命令 |
| `ui` | 进度（含心跳与预估）、交互确认、口令门禁、`--json` | 交互只在这一层；非 TTY / `--json` / `--dry-run` 一律关掉交互 |
| `state` | 状态机 + `state.json` 持久化 | **唯一状态源**；原子写（tmp+rename+fsync） |
| `plan` | 由"当前状态 + 目标 + manifest"算世代计划 | **纯函数、零副作用**；`--dry-run` 即打印它 |
| `apply` | 准备 → 单点提交 → 验证 → 失败自动回退 | 唯一改部署描述的地方，且只按计划改 |
| `render` | `deploy_format` solver 注册表 → 产物 | **纯函数**；黄金文件测试 |
| `manifest` | 取 manifest、判定 `deploy_format`、迁移摘要 | 联网或离线；失败关闭 |
| `backup` | 还原点：DB / Redis / 对象 / 卷 / 配置快照，单文件加密 | 独立子系统，`apply` 永不调用 |
| `runtime` | `Runner` 抽象（`Local` 先实现，`Ssh` 留 seam）+ `HostFs` / `Clock` / `Net` | 所有 IO 的唯一出口 |
| `versions` | 别名解析 + 风险列 | 资产就绪过滤；为空则报错不回落 |
| `doctor` | 自检、完整性报告、TLS 到期、诊断包 | 只读（`--bundle` 只写一个 tar） |

**执行器选择**：栈定义是 compose（`nojctl` 渲染），落地用 `docker compose` CLI，状态读取用 `docker compose ps --format json` / `docker inspect`。**不**用 bollard 自己解释 compose 语义。代价：宿主机必须有 `docker` + `compose ≥ 2.x`，失败时必须给安装/授权指引。二进制用 `rustls` + `x86_64-unknown-linux-musl` 静态链接。

### 4.2 不变量

1. **单一状态源**：只有 `state` 能改状态；`state.json` 原子落盘；并发由 `.nojctl/lock` 拒绝。
2. **渲染是纯函数**：同输入必同输出；产物与 manifest 的镜像 digest 交叉校验，不一致即失败。
3. **计划与执行分离**：`plan` 无副作用；`--dry-run` 零写操作（用假 `Runner` 断言）。
4. **提交点唯一**：一个世代只有一次"生效"动作；失败自动回退，且回退豁免口令门禁。
5. **`apply` 不主动改变运行态**：进入时 `stopped` 的栈，提交阶段**临时启动以完成 VERIFY，成功后自动回到 `stopped`**；进入时 `running` 则保持 `running`；`FINALIZE` 按**进入时的运行态**写 `state`。摘要与 `--dry-run` 必须显示该行为。
6. **数据不经 CLI 自动改动**：`apply` 不备份/不还原/不查库（§6.7）；`restore` 是唯一改写数据的命令。
7. **失败关闭**：`deploy_format` 不认识 / 别名无解 / 资产不齐 / manifest 校验不过 / 目录判据不过 / 项目名冲突 → 拒绝执行并说清下一步。
8. **生成物归 CLI，配置归用户**：compose、`deploy/*`、`.env.prod.example`、`.nojctl/**` 由 `nojctl` 生成并覆盖（文件头带声明）；`.env.prod` 只在首装向导与补缺失键时写入（§5.7 三类键）。
9. **传输无关**：所有 IO 经 `Runner` / seams；状态可序列化、可在远端重建（B 模式的前提）。
10. **确认前零写入**：向导/摘要在用户确认之前不落任何盘。
11. **世代保留**：默认保留上一个可回退世代（`keep_generations`，缺省 1）；verify 通过前不清理被替换的世代；清理世代时同步回收其独占镜像。
12. **秘密不外流**：口令、管理员密码、备份口令不进 `state.json`、不进世代快照、不进日志（脱敏断言进测试）；只允许一次性打印或写入 0600 的指定路径。
13. **身份与密钥随数据延续**：安装身份（`NOJCTL_INSTALL_ID` / `NOJCTL_PROJECT_NAME`）与全部实例级密钥存放在 `.env.prod`；**复用既有 `.env.prod` 时一律沿用原值、只补缺失键**，只有全新首装才生成新密钥；卷名由身份派生，因此"卸载后重装"不丢数据（§7.4 有 fail-closed 校验兜底）。

---

## 5. 命令面与交互

### 5.1 命令（12 条 + `--version`；下表 11 行，`start` / `stop` 与 `judge enable` / `judge disable` 各合占一行）

| 命令 | 语义 |
| --- | --- |
| `deploy` | 首装：前置探测（非静默，含 Docker 指引、镜像仓库与 manifest 双可达性、项目名与卷冲突）→ **三问向导** → **可选二级项：是否装 noj-judge（默认跳过；选"是"进入 rootless 引导）** → 渲染与空转 → 摘要确认 → 执行 → 完成页（五段，含可访问性检查与"第 2 步"）。**已安装到位且无中断事务时拒绝执行**（退出 3）并指路：改配置 → `apply`；装判题 → `judge enable`；`state=partial` → 续跑本次中断的部署 |
| `apply [版本\|别名]` | 唯一让"部署描述与期望一致"的命令：版本变更 / 配置变更 / no-op / 崩溃恢复；**不主动改变运行态**（§4.2 不变量 5） |
| `start` / `stop` | 运行态：启动 / 停止栈。`uninitialized` → 退出 3（提示先 `deploy`）；**`partial` 下 `stop` 始终允许**（应急停站优先）；`stop` 需一次 `[Y/n]` |
| `judge enable` / `judge disable` | 判题开关：`enable` 完整复用屏幕 3 子流程（打印 rootless 脚本 → 等回车 → 7 项探测 → 预拉评测镜像 → 写 `JUDGE_ENABLED` 与 socket/gid 键 → 走一次 `apply` 事务 + VERIFY #4）；`disable` 反向（置 `JUDGE_ENABLED=false` + 一次 `apply`）。**完成页"第 2 步"给出的就是 `nojctl judge enable`** |
| `versions` | 版本表：每个 tag 的渠道、是否资产就绪、`deploy_format`、迁移摘要、本机是否装得了；四个别名 → 解析到的具体 tag（空显示 `—`）；当前部署；最近备份时间 |
| `status` | 当前世代、运行态、容器与健康、版本、`deploy_format`、世代/备份磁盘占用、**配置漂移**、**未应用的配置变更**、**邮件未配置等"能力未开启"提示** |
| `logs [服务]` | `compose logs` 薄封装（`--follow` / `--tail` / `--since`） |
| `doctor` | 只读自检：docker/compose 版本、judge socket 自洽、磁盘与可回收量、`.env.prod` 权限与校验、生成物漂移、镜像 digest、容器健康、备份新鲜度、**配置域名的 TLS 剩余天数**、**安装目录是否已变更**、旧文件残留；`--bundle` 输出诊断包 |
| `backup create\|list\|verify\|restore\|prune` | 独立还原点子系统（§8） |
| `uninstall` | 默认停栈 + 移除生成物，保留数据卷 / `.env.prod` / 备份；`--purge` 才删数据 |
| `core -- <args…>` | 逃生舱：把参数透传给容器内 `/app/bin/noj`（`bootstrap first-admin` / `admin` / `db migrate` / `problem` / `search`）。文档标注"给专业维护者，不是给教练的" |

全局：`--dir`（缺省当前目录；相对路径**规范化为绝对路径**后使用与记录）、`--dry-run`、`--json`、`-v/--quiet`。`deploy` 额外：`--admin-password-out <path>`（非交互下管理员密码的落点，0600）。`apply` 额外：`--acknowledge-risk`。`backup restore`：`--acknowledge-restore`、`--skip-safety-snapshot`。`uninstall`：`--acknowledge-purge`。

**别名语义**（四个都过资产就绪过滤；为空则报错不回落）：

| 别名 | 解析为 |
| --- | --- |
| `stable` | 最新**非预发布**且资产就绪 |
| `beta` | 最新 beta 渠道 |
| `alpha` | 最新 alpha 渠道 |
| `newest` | 最新**任意渠道**且资产就绪 |

排序规则：按语义化版本取最大（预发布小于对应正式版，如 `0.10.1-beta.2 < 0.10.1`），候选集内只保留资产就绪者。`deploy` 默认别名 `stable`；若 `stable` 为空则以**退出码 5** 报错并写明"最近可安装版本为 `X`（beta 渠道），确认使用请加 `--version X`"。`nightly` 为**未来保留**。

### 5.2 退出码（稳定契约）

| 码 | 含义 |
| --- | --- |
| 0 | 成功（含 no-op） |
| 1 | 运行期失败（未分类） |
| 2 | 用法错误（clap 默认） |
| 3 | 前置/配置不合法（docker 缺失、`.env.prod` 校验失败、目录判据不过、项目名冲突、生产配置判据不过、`start`/`stop` 遇 `uninitialized`/`partial`） |
| 4 | 门禁未通过（口令错、缺 `--acknowledge-*`、用户拒绝、严格模式下无近期备份） |
| 5 | 目标不可安装（`deploy_format` 太新、别名无解、资产不齐） |
| 6 | 失败但**系统处于干净的已知状态且确认未发生任何数据库迁移**：线上未被触碰（PREPARE 阶段失败），或已回退到上一世代并验证通过；判定"未发生迁移"的依据是 `migrate` 服务未运行，或（在镜像支持机器可读迁移结果后）退出 0 且结果为 0 条；**无法确认时按 7 处理**；首装失败后已清理到"未安装"且未发生迁移也属此码 |
| 7 | 失败且**需要人工介入**：**迁移可能已前进**（`migrate` 退出非零，或已成功应用 ≥1 条，**或无法确认**）、回退失败、首装后留下 `partial` |

判据只有一条：**数据库是否可能已被推进，以及是否确认未推进**。无法确认 → 按 7 处理（宁严不宽）。`--json` 与 CI 都依赖这条。

### 5.3 门禁（口令）

| 触发命令 | 口令（全大写、逐字、去首尾空白） | 非 TTY 参数 |
| --- | --- | --- |
| `apply`（目标版本 ≠ 当前版本） | `I UNDERSTAND THE RISK AND HAVE BACKED UP` | `--acknowledge-risk` |
| `backup restore` | `I UNDERSTAND THIS WILL OVERWRITE CURRENT DATA` | `--acknowledge-restore` |
| `uninstall --purge` | `I UNDERSTAND THIS DELETES ALL DATA` | `--acknowledge-purge` |

规则：① TTY 下**先打印完整风险信息，再要求输入**；② 最多 2 次尝试，失败退出 4；③ 非 TTY 直接报错退出 4 并给出对应参数；④ **不支持环境变量绕过**；⑤ `--acknowledge-*` **只出现在对应子命令的 help**，不进全局 `--help` 首屏（避免把"绕过门禁"教给用户）；⑥ 豁免：失败自动回退、`--dry-run`、`apply` 的 no-op 与仅配置变更（`[Y/n]`）、`start`（不要求）、`stop`（需一次 `[Y/n]`，因其影响可用性）、所有非破坏性命令。

**知情声明**（写进 `--help` 与该步输出）：口令**不校验**你是否真的备份过。**门禁的三条缓解（形态不变）**：① 提问前多打一行"建议先执行 `nojctl backup create`"（附当前 `backups/` 的最新时间）；② 口令下方附中文对照（"我已知晓风险，并已完成数据备份"），降低抄写门槛、不改变要求；③ 备份新鲜度作为风险块的**标题行**而不是列表末行，避免被跳过。可选严格模式 `NOJCTL_REQUIRE_RECENT_BACKUP_DAYS=N`（默认 `0`＝关）开启后，若 `backups/` 中没有 N 天内验证通过的快照，`apply`（版本变更）拒绝执行（退出 4）并给出可复制的 `nojctl backup create`。默认路径下，备份不新鲜只**升级提示语气**（不阻断）。

### 5.4 `--json` 契约

stdout 只含一个 JSON 文档，人话走 stderr，字段只增不改：

```jsonc
{ "schema": 1, "command": "apply", "ok": false, "exit_code": 6,
  "from": "0.10.1-beta.2", "to": "0.10.1-beta.3", "deploy_format": 3,
  "data": { }, "warnings": [ ], "next_steps": [ ] }
```

`next_steps` 为可执行建议；密钥与口令永远掩码。

### 5.5 `deploy` 交互编排

| # | 屏 | 内容 |
| --- | --- | --- |
| 0 | 前置探测（**非静默**） | 首屏先说明"我是谁 / 大约要多久 / 我正在检查什么"，随后逐项显示进度：docker 与 compose 版本及权限、架构、磁盘、**目录判据**、**同名 compose 项目冲突**、**镜像仓库可达性**（`NOJ_IMAGE_REGISTRY`，默认 ghcr.io）与 **manifest 所在 GitHub 可达性**（两项分别检查、分别给指引）。失败输出**可复制的指引**：Debian/Ubuntu 与 RHEL 两族的 docker 安装、`usermod -aG docker`、compose 插件版本；受限网络给三种出路（配镜像源 / 走代理 / 别处 `docker pull` 后 `docker save` + `docker load`）。失败退出 3 |
| 1 | **三问向导** | ① **对外协议**（`HTTPS`（有域名+证书/反代，推荐）或 `HTTP`（仅内网/临时试用））+ 域名或 IP + 端口（默认 8080）；② **邮件**：「不配置（**学生将无法自助注册**，只能由管理员手动建号，且之后必须修改服务器上的配置文件才能开放）」「阿里云 DirectMail」「腾讯云 SES」（无"稍后再配"）；③ **首个管理员**（`[Y/n]`，**默认 Y**：用户名 + 邮箱；密码由 nojctl 生成，交互式在完成页只显示一次，非交互式写入 `--admin-password-out`，见屏幕 6/7） |
| 2 | 推导与生成（不问） | 由 ① 推导 `APP_URL` / `CORS_ALLOWED_ORIGINS` / `DOMAIN` / **`NOJ_ALLOW_INSECURE_HTTP`**（协议为 http 时为 `true`）；`TRUSTED_PROXIES` 由生成的 compose 子网确定性算出；`S3_*` 与内网端点固定；日志/保留期/资源上限取生产默认。**密钥例外（新增）**：若本次是**复用既有 `.env.prod`**（§9.3 第 3 行），则其中**一切已有键（含全部密钥与 `NOJCTL_*`）一律沿用原值，只补缺失键**；只有全新首装才强随机生成 `JWT_SECRET` / `TFA_ENCRYPTION_KEY` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `MINIO_ROOT_*` / S3 凭据 —— 否则会与既有数据卷里的状态不匹配（Postgres 角色口令、TFA secret、LLM Provider 信封加密都与此强绑定）。**选 HTTPS 时**打印"TLS 不由本站点提供"，附两行可复制的 Caddy / Nginx 反代示例 |
| 3 | **可选二级项：是否在本机安装 noj-judge**（**默认跳过**） | 选"是"→ 打印发行版自适应的**幂等脚本** → **等待回车** → 探测 7 项（socket 存在且是 socket；gid 与将写入的 `JUDGE_DOCKER_SOCKET_GID` 一致且组有 rw；能 `docker -H … info`；确认是 rootless/userns 且 `Docker Root Dir` 在家目录，并与 `JUDGE_REQUIRE_ISOLATED_DOCKER=true` 自洽；`loginctl` linger 已开；**家目录**剩余空间；通过该 daemon 预拉评测镜像）→ 失败可重试或放弃（转"否"）；选"否"→ `JUDGE_ENABLED=false`，完成页写"第 2 步：开启判题（约 15 分钟）"。**向导不调用 sudo、不改宿主机** |
| 4 | 渲染 + 空转（零写入） | 渲染世代 → `compose config -q` → **生产配置判据**（`APP_URL`/CORS 必须 https，除非 `NOJ_ALLOW_INSECURE_HTTP=true`）→ 端口占用 → 磁盘。任何一项不过 → 零写入，退出 3 |
| 5 | 摘要 + 确认 | 版本/渠道/`deploy_format`、对外地址与协议、服务清单、启用的 profile、生成密钥数、**由我推导的键数**、需下载镜像体积与预估耗时、迁移摘要（§6.7）、judge 是否安装、`[Y/n]`。明文 HTTP 时额外一行："已放宽 Cookie 安全限制；配置 HTTPS 后运行 `nojctl apply` 收紧" |
| 6 | 执行 | ① 写 `.env.prod`（0600，**写前自动留 `.env.prod.bak-<时间>`**）+ 世代目录 ② 拉镜像（**心跳 + 预估剩余 + 超时改为询问 + 明说断点续传**：已拉取的层不会重下）③ `up -d`（含 compose 内的 `migrate` 一次性服务）④ 等健康 ⑤ 建首个管理员（密码经 `--password-file /dev/stdin` 传入，**优先不落盘**；若必须落盘则 0600 且用完即删，崩溃残留由 `doctor` 报告） |
| 7 | 完成页（**固定五段**） | ① **能用什么**（站点 URL + 可访问性检查：域名是否已解析、TLS 握手是否成功与剩余天数、是否需要外部反代）② **账号**（管理员用户名 + **密码**：交互式在此只显示一次、首次登录强制改密；非交互式在 `--admin-password-out` 指定的文件里，未指定则未建号并在下文提示）③ **必须抄写**（备份口令 + 指纹）④ **还没开启的功能**（邮件未配置 → `⚠ 公开注册目前是关闭的` + 要改的 4 个键 + `nojctl apply`；judge 未装 → **`nojctl judge enable`（约 15 分钟）**）⑤ **现在就做的两件事**（`nojctl backup create`；把备份复制到服务器之外，附一行 `scp`/`rsync` 示例） |

**首装失败语义**（无 `previous` 世代）：不得宣称"已回退"。输出必须是"未安装成功，已清理到 `<状态>`；原因：`<具体键名/阶段>`；下一步：`<可复制命令>`"，并按 §5.2 判据给出 3 / 6 / 7。中断或失败后重跑 `deploy` **幂等续跑**（不重拉已缓存镜像）。

**降级路径**：缺域名 → 走 HTTP + IP（完成页给出之后换域名的两步：改 `APP_URL`/CORS/`NOJ_ALLOW_INSECURE_HTTP` → `apply`）；缺证书 → 同上，并指明 TLS 在外部边缘做；2 GB 内存 → 摘要里提示建议关闭 judge、限制并发与内存上限（给出要设的键）；网络受限 → 屏幕 0 的三种出路。

非交互等价：`--scheme=http|https`、`--domain`、`--port`、`--email=none|aliyun|tencent`、`--judge=on|off`、`--admin-email`、`--admin-username`、`--admin-password-out <path>`，以及快路径 `deploy --domain oj.school.edu --scheme=https --yes`。非交互下：密码写入 `--admin-password-out`（0600，拒绝覆盖既有文件）；**未给该参数则跳过建号并显式 warning**，并打印 `nojctl core -- bootstrap first-admin --username … --email …`；`--json` 模式下密码**永不进 stdout**。

### 5.6 `apply` 交互编排

| 情形 | 期望状态来源 | 动作 | 门禁 |
| --- | --- | --- | --- |
| `apply beta` | 参数解析出的**具体 tag** + 当前 `.env.prod` | 完整事务 | 口令（+ 严格模式下的备份新鲜度检查） |
| `apply`（配置变更） | `.env.prod` 的 `NOJ_VERSION` + 当前配置 | 完整事务（版本不变，容器重建） | 摘要 + `[Y/n]` |
| `apply`（无变化） | 同上，渲染 hash 与 `current` 一致**且运行态一致** | **no-op**，退出 0 | 无 |
| `apply`（残留 journal） | 上次被中断的事务 | **恢复**：目标世代产物完整且镜像已在本地则续做提交，否则回退上一世代，然后验证 | 无 |

规则：① **别名只作一次性意图**（成功后写入具体 tag，绝不写别名）；② 未初始化 → 报错并指向 `deploy`（退出 3）；③ 门禁一句话：*目标版本 ≠ 当前版本 → 要口令*；④ 崩溃后**重跑 `apply` 即可**；⑤ **运行态处理**（不变量 5）：栈为 `stopped` 时摘要写明"提交阶段将临时启动以完成验证，**成功后自动停止**"，`--dry-run` 同样显示；`FINALIZE` 按进入时的运行态落 `state`。

摘要示例（**先信息、后门禁**）：

```
期望状态：0.10.1-beta.3（beta 渠道，deploy_format 3）
  · 变更：版本 0.10.1-beta.2 → 0.10.1-beta.3；配置无变化
  · 运行态：当前已停止 → 提交阶段将临时启动验证，成功后自动停止
  · 迁移：目标版本声明 95 条（精确增量：镜像支持 db status 时显示，见 §6.7）
  · 镜像：4 个需下载（约 1.2 GB，预估 6 分钟）
  · 最近备份：3 天前 ⚠ 建议先执行 nojctl backup create
  · 失败处理：验证不通过会自动切回 0.10.1-beta.2（不触碰数据；若迁移可能已推进，退出码为 7）
请输入确认口令（全大写）：I UNDERSTAND THE RISK AND HAVE BACKED UP
```

### 5.7 `.env.prod` 与生成物（无 `config` 命令）

三类键，边界写死：

| 类别 | 例子 | nojctl 的行为 |
| --- | --- | --- |
| **CLI 生成**（可覆盖） | 首装生成的密钥、推导的 `APP_URL` / CORS / `TRUSTED_PROXIES` / `NOJ_ALLOW_INSECURE_HTTP` | 向导写入；后续 `apply` 若发现缺失则补齐。**手改这些键会在下次重写时被覆盖**（错误提示里会注明） |
| **安装身份**（可覆盖但**必须延续**） | `NOJCTL_INSTALL_ID`、`NOJCTL_PROJECT_NAME`（`# [仅 nojctl 使用]` 分区） | 首次部署生成并写入；**`uninstall` 保留 `.env.prod`**，因此重装沿用同一身份 → compose 项目名与命名卷不变 → **数据不丢**；搬目录时身份随文件一起走 |
| **用户拥有**（永不写） | 用户后来手改的任何键、邮件凭据、资源上限、保留期 | 只读校验与报告，绝不改写 |
| **代改** | —— | **不存在**：改配置 = 手改文件 + `apply` |

- `.env.prod` 权限 0600；`deploy` / `apply` 前置做 schema、交叉约束、占位符校验，失败零写入、退出 3。**工具在写入 `.env.prod` 之前自动留一份 `.env.prod.bak-<时间>`**（手改者的后悔药，`doctor` 报告数量与占用）。错误信息必须是**三段式**（发生了什么 / 为什么 / 抄这条命令），交叉约束失败要给**二选一修复建议**，并提示"可用键名在编辑器里搜索定位"（行号仅供参考），例如：
  ```
  ✗ EMAIL_PROVIDER=aliyun 但 ALIBABA_FROM_EMAIL 为空（.env.prod:134）
  二选一：
    a) 填上发信地址：编辑 .env.prod:134 → ALIBABA_FROM_EMAIL=your@school.edu
    b) 暂不启用邮件：把 .env.prod:132 改为 EMAIL_PROVIDER=disabled
    改完运行：nojctl apply
  ```
- **交付自检**（§7.4）：存在但无人接收的键 → 警告并列出；必需但缺失 → 失败。
- **`.env.prod.example` 由同一份 schema 生成**，顶部固定"**最常改的键**"分区（对外地址/协议、邮件四键、judge 开关、资源上限、日志级别），其余按键组排列，每行带 `# [必需] 交付给 core` / `# [可选] 默认 false` / `# [仅 nojctl 使用]`。
- **`status` 报漂移**：比对 `current` 世代的配置快照与当前 `.env.prod` → "配置自 07:12 起已变更，3 个键尚未应用；运行 `nojctl apply` 生效"，并列出键名。
- 生成文件头部声明：`# 本文件由 nojctl <版本> 生成（世代 <id>，deploy_format N，<时间>）。请勿手工编辑：任何修改都会在下次 deploy/apply 时被覆盖。`

---

## 6. 状态机与原子提交

### 6.1 状态与 `state.json`

`<dir>/.nojctl/state.json`（0600，tmp+rename+fsync）。四个状态：`uninitialized | stopped | running | partial`，另有 `last_error {at, kind, message}`。

```jsonc
{
  "state_schema": 1,
  "install_id": "6b0f2c1e-…",          // 权威在 .env.prod 的 NOJCTL_INSTALL_ID；此处为镜像值
  "install_dir": "/opt/neuro-oj",        // 绝对路径（相对 --dir 已规范化）；变更时 doctor 提示，不影响项目名
  "project_name": "noj-6b0f2c1e",
  "current":  { "generation": "g-20260927-0712-3f9c", "version": "0.10.1-beta.2",
                "deploy_format": 3, "artifact_hash": "…", "image_digests": { }, "applied_at": "…" },
  "previous": { },
  "journal":  { "phase": "commit", "target": "g-…", "started_at": "…",
                "entry_runtime_state": "stopped" },   // 进入本次事务时的运行态
  "last_verify":  { "at": "…", "ok": true, "checks": [ ] },
  "last_restore": { "at": "…", "backup_id": "…" },
  "keep_generations": 1
}
```

### 6.2 世代布局

`<dir>/.nojctl/generations/<id>/`：渲染出的 compose、被挂载的文件、`env.delivery.json`、`manifest.json`、`artifact_hash`，以及**该世代实际生效的配置快照（0600）**——快照是"回退后配置也真的回到那一版"的前提。**快照不含管理员密码、备份口令**（不变量 12）。

`artifact_hash` 对 canonical 化产物（键排序、空白归一）取 hash，用于 no-op 判定与漂移检测；**项目名来自 `install_id`（不是路径），因此搬目录/改名不改变 hash**。

### 6.3 事务三阶段

| 阶段 | 做什么 | 失败/中断后果 |
| --- | --- | --- |
| **PREPARE**（对线上零影响） | 渲染 → `compose config -q` → 生产配置判据 → 校验 manifest digest → 交付自检与必需键校验 → 拉镜像 → 写世代目录 → 算 hash | 干净中止，线上原样，退出 6（首装则 3/6，见 §5.5） |
| **COMMIT**（唯一提交点） | 先写 journal（含 `entry_runtime_state`）→ 原子替换 live 文件 → `state.current` 前移、旧世代记为 `previous` → **一次** `up -d`（**显式 `--force-recreate nginx`**；judge 开启时带 `--profile judge`） | 崩溃落在此处 → journal 留在 `commit`，下次任何命令都能判定方向 |
| **VERIFY** | §6.6（若进入时为 `stopped`，此处为临时启动后的验证） | 失败 → 自动回退 |
| **FINALIZE** | 落 `state`：`entry_runtime_state = uninitialized`（首装）→ 写 **`running`**；`stopped` → 先 `stop` 再写 `stopped`；`running` → `running`。随后写 `last_verify` → 按 `keep_generations` 清理旧世代**并回收其独占镜像** | — |

**失败 → 自动回退**：恢复 `previous` 的文件与配置 → `up -d` → 再验证 → 按 `entry_runtime_state` 恢复运行态。输出只陈述**可证实**的事实：

```
已自动回到 0.10.1-beta.2 并验证通过（容器健康 + HTTP 200 + 登录往返）。
数据库：migrate 服务未运行 → 无法判断本次是否推进（未做任何回滚）。
原因：<VERIFY 中失败的检查项>
下一步：nojctl doctor
```

数据库那句只允许以下取值，全部来自 `migrate` 服务的**退出码 + 机器可读结果行（§12 批次 2.5）+ 日志**，不得推测：

| migrate 服务事实 | 文案 | 退出码影响 |
| --- | --- | --- |
| 未运行 | 无法判断本次是否推进（迁移服务未运行） | → 7 |
| 退出 0，但镜像**未提供**机器可读结果行 | **无法确认**本次是否发生迁移（该版本镜像不支持迁移结果上报） | → 7（宁严不宽） |
| 退出 0，结果为 0 条 | 未发生迁移 | 可判 6 |
| 退出 0，结果为 N>0 条 | 已应用 N 条（最后一条 `<迁移号>`），不会回滚 | → 7 |
| 退出 ≠ 0 | 可能停在中间点（日志停在 `<迁移号>`），不会回滚 | → 7 |

退出码按 §5.2 判据：**确认未发生迁移且回退验证通过 → 6**；否则 → 7。回退本身失败 → 7 + `state=partial` + 恢复步骤 + 建议备份 id。

**首装失败**（无 `previous`）：清理已启动的服务与生成物到"未安装"或 `partial`，按 §5.2 判据给出 3 / 6 / 7。

**Ctrl-C**：提交窗口内屏蔽 SIGINT（跑完当前原子步再退出）；窗口外中断都留下可判定状态。

### 6.4 崩溃恢复

`apply` 重跑即恢复：读 journal → 目标世代产物完整且镜像已在本地 → **续做提交**；否则 → **回退上一世代** → 验证 → 恢复 `entry_runtime_state`。帮助文本直接写"上次 `apply` 若被中断，再跑一次 `apply` 即可"。

### 6.5 并发锁

`.nojctl/lock`（pid / hostname / command / started_at）。并发运行拒绝（退出 3）；同机且 pid 消失 → 视为陈旧锁自动清理；否则拒绝并说明。

### 6.6 VERIFY 的检查集

1. 期望容器集合齐全且 healthy（judge 无 healthcheck → 运行中 + 日志新鲜）；
2. HTTP **经回环** `127.0.0.1:<NGINX_PORT>` 并带 `Host: <DOMAIN>` 头：`/` 200、`/api/v1/problems` 200、`/healthz` 200 —— **不走外部域名**，避免 DNS/TLS 未就绪导致"正确部署自我失败"；
3. **语义冒烟**：`POST /api/v1/auth/login`（同一回环 + Host 头）拿到响应体里的 **JWT**，再用 `Authorization: Bearer <jwt>` 调 `/api/v1/auth/me` 期望 200 —— **与 Cookie 语义解耦**，因此 HTTPS 部署（`Secure` Cookie 不会在明文回环上回传）不会被误杀。另外对登录响应的 `Set-Cookie` 做**非阻断断言**：`APP_URL` 为 http 且已放宽 → 不应带 `Secure`；为 https → 应带 `Secure`，不符只 warning。JWT 与密码都不落盘、不回显。密码来源 = 本次首装生成的管理员密码；若首装跳过了建号，则**显式 warning** 并跳过该检查（不静默）；
4. **judge 执行面探测（judge 开启时）**：通过 rootless socket 跑一个一次性容器，**镜像用屏幕 3 已预拉的评测镜像**（`noj-evaluator-python:<版本>`，避免受限网络下拉不到最小镜像而误判）；
5. 运行镜像 digest == manifest digest；
6. `migrate` 一次性服务退出码与日志（§6.7），并据此决定是否允许报 6；
7. `state.current` 与运行世代一致，无游离文件；
8. 启动后 core / judge / gateway 日志中无致命模式。

**数据内容校验不在这里**（归 `restore` 与 `doctor`）。时间预算：PREPARE 单镜像 ≤ 20 min（可配）、总计 ≤ 45 min；COMMIT ≤ 5 min；VERIFY 总 ≤ 150 s（单检查 15 s、健康轮询 5 s）；回退路径同等预算，最坏 ≤ 10 min。

### 6.7 数据库迁移的责任边界（**A + A1**）

**内容与触发保持在镜像 + compose 里，`nojctl` 不执行、不查库，只观测。**

- **内容所有权**：服务端镜像；gateway 拥有自己的 4 个迁移文件并在启动时自迁移。
- **触发**：生成的 compose 保留一次性 `migrate` 服务与 `core.depends_on: migrate: service_completed_successfully`；这条不变量用**黄金文件测试**钉住，且对**任何入口**都成立。**不为 gateway 增加一次性迁移服务。**
- **观测（A1）**：部署链路零数据库访问。归因来自 —— `migrate` 服务的退出码与日志：

  | `up -d` | `migrate` 服务 | 归因与动作 |
  | --- | --- | --- |
  | 成功 | 退出 0 | 迁移与应用都成功 → 继续 VERIFY |
  | 失败 | 退出 ≠ 0 | "**迁移未完成**（日志停在 `<迁移号>`）"→ 切回上一世代，退出 **7**（库可能停在中间点） |
  | 失败 | 退出 0 且日志显示已应用 | "**迁移已应用 N 条，应用层未起**"→ 切回上一世代，退出 **7**（数据面已前进） |
  | 失败 | 退出 0 且日志无待应用 | 应用层失败、数据面未变 → 切回上一世代，退出 **6** |

- **精确增量的可选来源**：若目标镜像支持 `noj db status --json`（core 侧增补，§12 批次 2.5），`nojctl` 通过 `compose run` 调用它得到"待应用 N 条 / 末条 tag"；不支持时降级为"目标版本声明总数 + 增量未知"，摘要中如实标注。**这仍是"问镜像"，不是 CLI 查库。**
- **迁移结果的机器可读上报（本次新增）**：`migrate` 服务在完成时输出一行结构化结果（形如 `NOJ_MIGRATE_RESULT {"applied":1,"pending":0,"last":"0094_…"}`，实现方式由 core 决定），供 §6.3 的判定表与 §5.2 的退出码判据使用。该能力进 §12 批次 2.5；**在支持之前，`migrate` 退出 0 也只算"无法确认"，一律按 7 处理**（宁严不宽）。
- **manifest 的迁移字段**：`migrations: { server: {count,last_tag,last_hash}, gateway: {…} }`；跨多版本升级不需要中间版本 manifest；`min_source_version`（可选）用于"必须经由某中间版本"的未来场景。

---

## 7. 生成器与 `deploy_format`

### 7.1 渲染是纯函数

```
render(deploy_format, config, probe) -> Artifacts
  probe = docker/compose 版本、架构、judge socket 探测结果、judge 开关、install_id（用于项目名）
  Artifacts = { docker-compose.prod.yml, deploy/{nginx,minio}/*,
                env.delivery.json, artifact_hash }
```

无 IO、无时钟（时间戳参数注入）。**compose 项目名权威顺序**：`.env.prod` 的 `NOJCTL_PROJECT_NAME`（若存在）> 由 `NOJCTL_INSTALL_ID` 派生（`noj-<前 8 位>`）> 首次部署时生成并写回 `.env.prod`；与安装路径**无关**（搬目录不改变项目名与 `artifact_hash`）。PREPARE 的两项冲突检查：① 同名 compose 项目已存在且其 **`com.docker.compose.project.working_dir` 标签不是本目录** → 拒绝（退出 3，覆盖"复制目录导致 install_id 重复"的情形）；② `state.project_name` 与 `.env.prod` 的值不一致 → fail-closed 并给指引（改回或显式重置）。被挂载的文件总是物化；**不含 monitoring**。

### 7.2 Solver 注册表与选择（失败关闭）

```rust
trait Solver { fn deploy_format(&self) -> u32; fn render(&self, cfg, probe) -> Result<Artifacts>; }
```

| 情形 | 行为 |
| --- | --- |
| manifest 声明 `deploy_format = N`，N 在支持集合 | 用对应 solver（**老 `nojctl` 照旧能装新版本**） |
| `N >` 已知上限 | 退出 5："该版本需要 nojctl ≥ x.y" |
| `N <` 支持下限 | 退出 5："该版本使用已停止支持的部署格式 N" |

`deploy_format` 来源两条路：① Release 资产 `nojctl-manifest.json`；② 镜像 label `org.noj.deploy-format`。都拿不到 → 失败关闭。

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

**CI 三条不变量**：① manifest 的 7 个 digest 与实推镜像一致；② 发布版 `nojctl` 渲染 + `docker compose config -q`；③ 用渲染产物真起栈 e2e。

### 7.4 "文档化的键必进容器"两层

1. **构建期（CI 门禁）**：schema 里每个键要么出现在某服务的 `environment` / `env_file`，要么显式标记 `nojctl-only`。"文档化但无交付目标" = CI 失败。
2. **运行期（`deploy` / `apply` 前置）**：`.env.prod` 存在的键对照 `env.delivery.json` → 存在但无人接收 = 警告并列出；必需但缺失 = 失败（三段式 + 二选一修复建议）。**另有一条 fail-closed 校验（R1 兜底）**：若发现属于本安装身份的命名卷已存在（`<project_name>_pgdata` 等），但 `.env.prod` 缺失、缺少 `NOJCTL_INSTALL_ID`、或身份与卷前缀不匹配 → **拒绝执行**（退出 3），输出"检测到已有数据卷 `noj-xxxx_pgdata`，但没有对应的配置文件；直接继续会导致数据不可访问"，并给两个可复制选项：`--adopt-install-id <id>`（把身份写回 `.env.prod` 以接管既有数据）或 `--purge`（明确放弃数据）。

### 7.5 模板与测试

- 模板用 `include_str!` 文本模板 + 最小替换/条件块；渲染后双重结构校验（YAML 解析 + `docker compose config -q`）。
- **黄金文件**：每个 `deploy_format` × 代表配置（最小 / judge 开 / judge 关 / **http 明文** / https 域名 / 自定义端口 / 自定义 `NOJCTL_PROJECT_NAME`）；**断言清单显式包含**：`NOJ_ALLOW_INSECURE_HTTP` **同时出现在 core 与 ui 两个服务**、`migrate` 服务存在且 `core.depends_on` 指向它、无 monitoring 服务与文件、项目名来自 `install_id`。
- **确定性**：同输入两次渲染 `artifact_hash` 相同；键顺序无关；**搬目录后 hash 不变**。
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
├─ redis.rdb        # Redis 快照（JWT 撤销名单 / 队列 / claim）
├─ objects/         # MinIO 桶内容（mc mirror 导出）
├─ volumes/         # noj-packages、noj-storage（存在则含）
└─ .env.prod        # 加密内含（没有它恢复不出可运行的实例）
```

- **默认强制加密**：没有 passphrase 就拒绝创建。`deploy` 时自动生成随机 passphrase 存 0600，**要求二次确认输入以证明已抄写**，并显示口令指纹（前 8 位 sha256）便于日后核对。
- **同盘风险显式提示**：完成页与 `doctor` 都提示"至少复制一份到服务器之外"，附一行 `scp` / `rsync` 示例。

### 8.2 命令

| 命令 | 语义 | 门禁 |
| --- | --- | --- |
| `backup create` | **不需要停机**（`pg_dump` 事务一致；Redis `BGSAVE` + 取 `dump.rdb`；对象 `mc mirror`）→ 打包 → **自动 verify 一次** → 打印 id/大小/耗时；任一步失败即删除半成品 | 无 |
| `backup list` | id / 时间 / 应用版本 / `deploy_format` / 大小 / 最近一次 verify 结果 / 磁盘占用 | 无 |
| `backup verify <id>` | **不需要栈运行**：sha256、GPG 可解、tar 可读、`pg_restore -l` 可解析、manifest 自洽、对象清单匹配、关键表行数与 dump 记录一致 | 无 |
| `backup restore <id>` | 唯一改写数据的命令（§8.3） | 最强口令 |
| `backup prune` | **默认 dry-run（零删除）**，`--confirm` 才真删；保留最近 N（默认 7）+ 至少 1 个已验证；**永不删"最近一个验证通过的"** | 需 `--confirm` |

### 8.3 `restore` 序列

1. 前置：`verify <id>` 必须通过；备份应用版本与当前部署不同 → 警告"恢复后建议 `apply` 到匹配版本"，**不自动切版本**。
2. 门禁：`I UNDERSTAND THIS WILL OVERWRITE CURRENT DATA`。
3. **安全网**：自动给"当前数据"打一份快照；磁盘不足导致失败时，必须显式 `--skip-safety-snapshot`。
4. 停写入者：`nojctl stop` + 停 minio；**postgres 与 redis 保持运行**（要接收还原）。
5. 还原 DB：`pg_restore --clean --if-exists --no-owner --exit-on-error`。
6. 还原 Redis：停 redis → 写入 `dump.rdb` → 启动 redis。
7. 还原对象与卷：解包回 minio / packages / storage 卷，再起 minio。
8. `nojctl start` + **VERIFY（唯一做数据核对的地方）**：容器健康 + HTTP + 语义冒烟 + **关键表行数与备份 manifest 一致** + 对象条数一致。
9. 收尾：记 `state.last_restore`；打印"数据已恢复到 `<备份时间>`（id `<id>`）"+ 建议。

### 8.4 边界

`apply` 永不调用 backup/restore；`restore` 永不自动切版本；`backup` 永不改部署描述。**跨机恢复是备份存在的首要理由**，手册化步骤见 §12 批次 6.5，并进 e2e（§10.5）。

---

## 9. 分发、目录与共存

### 9.1 分发模型：独立二进制

- **不软链、不写 PATH、不改 `~/.profile`、不把自己复制进安装目录**。
- 调用模型：`nojctl [--dir <安装目录>] <命令>`，`--dir` 缺省为当前目录；安装目录里只有数据与生成物。
- `uninstall` 明确输出"工具二进制不归我管，请自行删除"。
- 该模型同时是 B 模式（将来由本地驱动远端）的天然形状。

### 9.2 目录布局与所有权

```
<install_dir>/
├── .env.prod                 用户所有（0600）；nojctl 只在首装/补缺失键时写
├── docker-compose.prod.yml   nojctl 生成（头部声明）
├── deploy/                   nojctl 生成（nginx / minio）
├── .env.prod.example         nojctl 生成（带注释的键清单）
├── .nojctl/                  nojctl 独占：state.json / lock / generations/
└── backups/                  单文件快照
```

### 9.3 目录判据（拒绝外来目录）

**判定基础**：`本工具生成物` = 带 nojctl 头部声明的文件，或位于 `.nojctl/` 下的内容；`保留物` = `.env.prod`、`backups/`。

| 目录状态 | 行为 |
| --- | --- |
| 不存在 / 完全为空 | `deploy` 允许（不存在则创建） |
| 含 `.nojctl/state.json` 且无中断事务 | **已安装：`deploy` 拒绝执行**（退出 3）并指路——改配置 → 编辑 `.env.prod` 后 `nojctl apply`；装判题 → `nojctl judge enable`；看状态 → `nojctl status`。不再有含糊的"续跑/复用" |
| 含 `.nojctl/state.json` 且 `state=partial`（上次部署被中断） | `deploy` **续跑**：只补做未完成的阶段，**不重跑三问向导**；若要改配置请先 `apply` |
| 无 state，仅含保留物 / 本工具生成物（例如 `uninstall` 之后的目录，或只剩 `.env.prod`） | `deploy` 允许：**沿用 `.env.prod` 中一切已有键（含密钥与 `NOJCTL_*` 安装身份），只补缺失键**（提示"检测到既有配置与安装身份，将沿用"），覆盖生成物、保留 `backups/` |
| 无 state 且含**外来条目**（无我们头部声明的 compose、`deploy/`、v1 的 `.bak/.orig/.staged` 等） | **拒绝写操作**（退出 3），逐条列出外来条目并说明"本工具不接管既有安装；迁移见手册（§12 批次 6.5）" |

只读命令（`status` / `doctor` / `logs` / `versions` / `backup list`）可在外来目录运行，输出置顶 `⚠ 该目录不是 nojctl 管理的，本工具不会改动它`。

**结论**：① 原子性在第一次就成立；② **卸载后可直接重装且数据仍在**（身份与密钥都在 `.env.prod`，卷名不变）；③ **不接管任何既有安装**（迁移走手册）。

### 9.4 漂移守卫

live 文件与 `current` 世代的 `artifact_hash` 不一致（手改、被 v1 覆盖等）→ **破坏性操作 fail-closed**，提示"部署文件不是 nojctl 生成的/已漂移，请先 `nojctl apply` 恢复受管状态"；`status` / `doctor` 照常报告差异清单。安装目录被移动或改名 → `doctor` 提示"`state.install_dir` 为 X，当前为 Y（项目名与世代不受影响）"，不视为漂移。

### 9.5 卸载与交接

- `uninstall`（默认）：停栈 + 移除 `.nojctl/` 与生成物；**保留** `.env.prod`、数据卷、`backups/`；目录处于"可直接重装"状态。**因为 `.env.prod` 里保留了 `NOJCTL_INSTALL_ID` / `NOJCTL_PROJECT_NAME`，重装会沿用同一 compose 项目名与命名卷 → 数据不丢**（§7.4 另有 fail-closed 兜底）。
- `--purge`：额外删数据卷 + `.env.prod` + 备份（口令 `I UNDERSTAND THIS DELETES ALL DATA`）。
- **永不自动删除**：数据卷、备份、`.env.prod`（`--purge` 例外）。
- **交接**：`doctor --bundle` + 文档的"权限与交接"小节（要移交的清单：安装目录、二进制位置、`backups/` 与异地副本、管理员账号、外部依赖如域名/证书/邮件服务商）。

---

## 10. 测试与验收

### 10.1 故障注入矩阵

| 注入点 | 断言 |
| --- | --- |
| PREPARE：渲染失败 / 生产配置判据不过 / digest 不符 / 拉镜像失败 | 线上零改动；退出 3 或 6；live 文件与 `current` 一致 |
| COMMIT：`up -d` 非零 / `migrate` 非零 / `SIGKILL` | 要么"旧世代且健康"（6），要么"`partial` + journal 可判定"（7）；**永不出现混合状态** |
| VERIFY：健康超时 / HTTP 非 200 / 登录往返失败 / digest 不符 / judge 冒烟失败 | 自动回退触发；回退后退出码按 §5.2 判据；运行态按 `entry_runtime_state` 恢复 |
| 首装失败（无 `previous`） | 输出"未安装成功 + 原因 + 下一步"；退出 3 / 6 / 7 之一；重跑 `deploy` 幂等续跑成功 |
| 回退本身失败 | 退出 7；`state=partial`；报告含恢复步骤与建议备份 id |

绝大多数用注入的 `Runner`（假 docker）跑；关键路径用真 docker 跑少量（含提交窗口内 `SIGKILL` 后重跑 `apply`）。

### 10.2 幂等与零副作用

`apply` 两次 → 第二次 no-op（退出 0、零写操作）；`deploy` 中断后重跑幂等；`--dry-run` 用假 `Runner` 断言没有任何写调用；`doctor` 纯只读（`--bundle` 只写一个 tar）。

### 10.3 生成器测试

§7.5 的黄金文件与断言清单；确定性（同输入同 hash；**搬目录后 hash 不变**）；双重结构校验；§7.4 第 1 层的 CI 门禁。

### 10.4 契约测试

退出码表每个码至少一个用例（含 §5.2 判据的两侧与"无法确认迁移状态 → 7"）；`--json` schema 快照 + "字段只增不改"守卫；门禁三条路径（TTY 口令错/对/两次失败；非 TTY 报错与参数；豁免路径；严格模式下无近期备份 → 4）；目录判据**五种状态**（含"已安装且无中断 → `deploy` 拒绝"与"`partial` → 续跑"）；项目名冲突与**复制目录（同 `install_id`、不同 `working_dir`）**均被拒绝；**`stopped` 栈上 `apply` 后仍为 `stopped` 且验证通过**；**首装后 `state=running` 且 `stop` 可用**；**`partial` 下 `stop` 允许**；`start` / `stop` 在 `uninitialized` → 3；**HTTPS 配置下登录冒烟通过**（`Secure` Cookie 不回传也能过）；**秘密不外流**（断言 `state.json`、世代快照、日志中不含管理员密码与备份口令；`--json` 下 stdout 不含密码）；**`.env.prod` 写入前生成 `.env.prod.bak-<时间>`**。

### 10.5 e2e（真 docker，CI）

空目录 `deploy`（http 与 https 各一次；judge 开与关各一次）→ 健康 → 语义冒烟 → `doctor` 通过 → `backup create` + `verify` → **仅配置变更**的 `apply` → **换版本**的 `apply`（含 `stopped` 栈场景）→ `stop` / `start` → 注入失败版本断言自动回退 → **跨机恢复**（新目录 `deploy` → `restore` → 验证）→ **`uninstall` → `deploy`（沿用身份与密钥）→ 抽查原有数据仍在** → **默认跳过判题后的 `judge enable` 真能开起判题（含预拉镜像与 VERIFY #4）** → 目录判据、项目名冲突、复制目录冲突用例。

### 10.6 发布门禁

发布 workflow 增补四步：① manifest 的 7 个 digest 与实推镜像一致；② 发布版 `nojctl` 渲染 + `config -q`；③ 真起栈 e2e；④ **用上一版 `nojctl` 装这个新版本**。

---

## 11. 验收口径

- [ ] `deploy` 在空目录上从零到**可用**（含根因引导的可选二级项与浏览器可访问性检查），全程无需用户理解 compose / env / Docker
- [ ] **教练必须理解的新概念 ≤ 5 个**（对外地址与协议、管理员账号、备份口令、`apply` 的用途、判题是可选的第二步）；`deploy_format` / 世代 / 别名 / manifest / rootless / 迁移 / 哈希等 9 个概念**必须被完全隐藏**（隐藏清单写进实现验收）
- [ ] http 与 https 两条路径都能通过 core 的生产配置校验；明文路径明确告知 Cookie 放宽与收紧方式
- [ ] 邮件未配置时完成页显示"公开注册目前关闭"与三步补救；`status` 常驻提示
- [ ] 跳过建号时必须显式 warning（不静默跳过登录冒烟）
- [ ] `apply` 覆盖四种情形；门禁与退出码符合 §5.2–5.3；**`stopped` 栈上 `apply` 后仍为 `stopped`**
- [ ] `start` / `stop` 覆盖应急停站与恢复；`apply` 不主动改变运行态
- [ ] 任一注入点失败后系统要么回到上一世代且健康（6），要么 `partial` 且可判定恢复（7）；无混合状态；回退输出不出现无法证实的数据断言
- [ ] 备份：单文件加密、含 Redis、`verify` 不依赖运行中的栈、`restore` 前自动安全网、`prune` 默认 dry-run、跨机恢复 e2e 通过
- [ ] 目录判据五种状态、项目名冲突、复制目录冲突、漂移守卫按 §9.3–9.4 生效；**搬目录不触发漂移**
- [ ] **卸载后重装不丢数据**：`uninstall` → `deploy` 沿用同一 `NOJCTL_INSTALL_ID` 与全部密钥，命名卷不变、抽查数据仍在
- [ ] **默认跳过判题的部署能靠完成页给出的 `nojctl judge enable` 真的开起判题**（e2e 覆盖）
- [ ] 首装成功后 `state=running` 且 `stop` / `start` 可用；`partial` 下 `stop` 允许
- [ ] 已有数据卷但身份/配置不匹配时 fail-closed 并给出 `--adopt-install-id` / `--purge` 两个选项
- [ ] `doctor` 报告 TLS 剩余天数、磁盘可回收量、备份新鲜度、安装目录变更；`doctor --bundle` 可发给维护者
- [ ] 生成器：黄金文件（含 `NOJ_ALLOW_INSECURE_HTTP` 双服务断言）+ 确定性 + 双重结构校验通过；"文档化的键必进容器"CI 门禁通过
- [ ] 现有运维文档（4 份）与新命令面同批发布；15 分钟上手材料与迁移手册同批交付
- [ ] 本设计不改动 core / judge / ui / gateway 的既有行为（仅新增三个向后兼容的本机只读/授权能力）

---

## 12. 交付批次

| 批次 | 内容 | 依赖 |
| --- | --- | --- |
| **1** | 骨架：`Runner`/seams、`state` + `state.json`（含 `install_id`）、`cli`/`ui`（`--json`/退出码/心跳进度）、目录判据、锁 | — |
| **2** | `render` + `deploy_format` 注册表 + 项目名派生（`install_id`）+ 黄金文件（含断言清单）+ manifest 取数与校验 | 1 |
| **2.5** | core 侧四个向后兼容能力：`noj config check --json`、`noj db status --json`、`noj bootstrap first-admin --password-file`（保持本机授权语义）、**`migrate` 的机器可读结果行**（供 §6.3/§5.2 判据） | — |
| **3** | `plan` + `apply` 事务（PREPARE/COMMIT/VERIFY/回退/崩溃恢复/首装失败/运行态临时启动与恢复）+ 故障注入测试 | 2 |
| **4** | `deploy` 向导（三问 + 可选二级项 + rootless 引导 + 完成页五段 + 降级路径）+ **`judge enable` / `judge disable`**（复用屏幕 3 子流程）+ 非交互等价 | 3 |
| **5** | `backup` / `restore`（含 Redis、加密与口令二次确认、verify、安全网、跨机恢复） | 1 |
| **6** | `status` / `logs` / `doctor`（TLS、磁盘、`--bundle`、安装目录变更）/ `versions` / `start` / `stop` / `core --` / `uninstall` | 3,5 |
| **6.5** | **迁移手册**（人工步骤 + CI 演练）。大纲：① 老实例停写（`noj-cli stop` 或 compose stop 应用层）② **原样携带实例级密钥**：`JWT_SECRET` / `TFA_ENCRYPTION_KEY` / `NOJ_LLM_STORE_KEY` / `NOJ_LLM_SERVICE_TOKEN` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `MINIO_ROOT_*` / `S3_*`（**换掉任何一个都会让数据"在但读不出来"**：Postgres 角色口令与数据目录绑定、TOTP secret 用 `TFA_ENCRYPTION_KEY` 加密、Provider Key 用 `NOJ_LLM_STORE_KEY` 信封加密）③ 导出：`pg_dump -Fc`、Redis `BGSAVE` 后取 `dump.rdb`、`mc mirror` 导出桶、卷 tar ④ 记录一致性时间点与导出校验和 ⑤ 新机 `deploy`（空目录）⑥ 导入：`pg_restore`、写回 `dump.rdb`、`mc mirror` 反向同步、卷解包 ⑦ 验证：关键表行数、对象条数、管理员登录、**一名启用 TFA 的用户能登录**、**一个 LLM 题能跑**、抽题提交 ⑧ 切 DNS（注意 TTL）⑨ 观察期后下线老机 ⑩ 回滚点：老机保持可启动 N 天 + 迁移前快照 | 5 |
| **7** | 发布链路：manifest 资产 + CI 四道门禁 + 用上一版 CLI 的逆向验证 | 2,3 |
| **7.5** | **文档切换**：`production-deploy.md` / `judge-workers.md` / `cli.md` / `noj-cli/README.md` + 权限与交接小节 + **15 分钟上手材料**（章节：这是什么/你需要什么/三问怎么答/看到什么算成功/学生怎么进来/第二步开启判题/出问题先跑 `doctor`） | 4,6 |

实施计划**按批次拆分**：第一份计划覆盖**批次 1–3**（含 2.5），因为 `apply` 的原子语义是承重墙；批次 4–7.5 各自成计划，可并行推进。

---

## 13. 开放问题与 follow-ups

1. **`email_provider` 运行时化**（跨模块）：把邮件配置从 `bootstrap` scope 迁到 `runtime`，让后台邮件页真正做到启动日志承诺的事；在此之前 nojctl 必须承担"邮件只能在服务器上改"的披露与引导。
2. **judge 网络收窄**（只给 redis + minio）。
3. **`JUDGE_ALLOW_HTTP_S3` 默认改 false**、**production 下禁用 `local` 下载 scheme**。
4. **`v1 → nojctl` 迁移工具**（当前只有人工手册）。
5. **恢复演练 `drill` 自动化**、**定时/异地备份**。
6. **B 模式（SSH 远端执行）**：`Runner` seam 已留。
7. **aarch64 与 Windows / macOS 产物**。
8. **`noj` 名字的收编**：容器内 `/app/bin/noj` 与宿主机 CLI 同名不同物；本次通过 `core --` 透传缓解。
9. **独立判题机 / 第二 Worker**：v1 不支持（`judge enable` 只做**同机 rootless**），只能文档化说明"实验室机器分担负载"需要另外的拓扑与后续设计。
10. **多实例**：本稿用"`.env.prod` 里的安装身份 + 项目名派生 + 标签级冲突拒绝"支持同机多安装；"一个 nojctl 管多个安装目录"记为开放问题。
11. **门禁的更强形态**（供未来评估）：若实践证明"抄全大写英文句子"成本过高，可评估"屏幕随机码"等替代；本稿按项目所有者决定保持不变（并已加三条不改形态的缓解，§5.3）。
12. **实现阶段注意事项**（第三轮复核的其余条目，不构成设计变更，但必须逐条进批次 1–3 的验收清单）：`--password-file` 的 0600 + owner 校验；密码优先经 `/dev/stdin` 不落盘、崩溃残留由 `doctor` 报告；`--dir` 相对路径规范化；CLI 生成类键的手改覆盖注记；`stopped` + 无变化时的 no-op 文案；`partial` 下 `stop` 必须允许；PREPARE 失败同属"线上未被触碰"的 6；首装失败按"迁移是否可能已推进"判 6/7；`.env.prod` 自动 `.bak`；错误提示附"搜索键名"。
