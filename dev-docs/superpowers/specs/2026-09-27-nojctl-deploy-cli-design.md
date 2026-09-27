# nojctl 部署运维 CLI 设计（Rust 重写）

Status: draft（待项目所有者审阅）
日期：2026-09-27
范围：新增 `nojctl`（Rust，musl
静态二进制）；`noj-cli`（TS 版）冻结不再演进；发布链路（`release.yml` + CI）新增 manifest
资产与四道门禁；不改动 `noj-core` / `noj-judge` / `noj-ui` / `noj-llm-gateway` 的运行时行为
基线：main @ `fc20865e`（0.10.1-beta.2）

---

## 1. 背景与目标

部署与运维是 NOJ
目前**唯一没有原子性、也最容易把非技术运营者卡住**的环节。目标受众是**没接触过服务器运维的运营者（如学校教练）**：他们能拿到一台
Linux 服务器和一个域名，但不该被迫理解 compose / env 文件 / rootless Docker / 迁移不可逆这些概念。

本设计重写部署运维 CLI（二进制名 **`nojctl`**），交付三件事：

| 编号 | 目标 | 一句话 |
| --- | --- | --- |
| **D** | 部署状态机与原子提交 | 版本切换是一个可回退的事务；失败自动回到上一世代 |
| **G** | 生成式部署描述 | compose 与挂载文件由 `nojctl` 渲染，配置只有一个真相源（`.env.prod`），"填了不生效"在结构上不可能 |
| **O** | 面向零基础运营者的交互 | `deploy` 四问向导 + rootless 引导；`apply` 一个动词解决版本与配置变更；风险在知情状态下确认 |

### 1.1 非目标（明确不做）

- **不接管任何既有安装**（v1 装的、手工搭的一律拒绝；见 §9.3）。`v1 → nojctl` 迁移工具不在本次。
- **不兼容 v1 产物**：不读 `noj-cli` 的 `snapshot-*.nojbackup`，不嗅探其 `.bootstrap-*.tmp` /
  `.env.prod.staged`。
- **不做 `config` 子命令**：`.env.prod` 由用户手写（配一份自动生成、带注释的 `.env.prod.example`
  作为文档）。
- **不做恢复演练 `drill`**、不做定时/异地备份（v1 的 `schedule`）、不做出题包管理（v1 的
  `problem`）、不做判题机独立安装、不做全屏 TUI。
- **不支持系统 Docker daemon 跑 judge**：judge 只有"同机 rootless 开"与"关"两个状态。
- **不把 judge 网络收窄、不改 `JUDGE_ALLOW_HTTP_S3` 默认值、不在 production 下禁用 `local` 下载
  scheme**（记为 follow-up，见 §13）。
- **不交付 Windows / macOS 产物**（B 模式才需要；架构已为其留 seam）。
- **不支持 SSH 远端执行**（B 模式）：只留 `Runner` 抽象与契约文档，不实现。
- **不迁移监控栈为受支持特性**：`monitoring` profile 与 4 个文件会被忠实渲染但默认关闭。

### 1.2 关键判断

1. **"原子"必须在第一次就成立**，因此不接受任何"从外来状态开始"的路径（§9.3 的目录守卫是它的前提）。
2. **升级链路不对数据负责**：`apply` 不备份、不还原、不碰数据；数据安全归 `backup` /
   `restore`，提醒由 `status` / `doctor` / `apply` 摘要承担。
3. **schema 归镜像，触发归 compose，`nojctl` 只观测**：部署链路（`deploy` / `apply` / `doctor`
   对迁移的观测）**零数据库访问**（§6.7）。备份子系统按设计就在容器内执行 `pg_dump` /
   `pg_restore`（§8），不受此约束。
4. **拿不准就失败关闭**：`deploy_format` 不认识、别名无解、资产不齐、manifest 校验不过、目录外来 ——
   一律拒绝执行并说清下一步，绝不猜测、绝不静默回落。
5. **生成物归 CLI、配置归用户**：`docker-compose.prod.yml` 与挂载文件由 `nojctl`
   生成并覆盖（文件头有声明），`.env.prod` 永远由用户拥有。

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| **`deploy_format`** | 部署描述的**格式版本**（整数，单调递增）。规定 compose + 挂载文件 + 必需配置键 + 健康语义的形状；只在"旧渲染器产不出新版本所需描述"时 +1。不是产品版本 |
| **世代（generation）** | 一次可原样复原的部署描述快照：compose + 挂载文件 + 该世代实际生效的配置快照 + manifest + hash。`current` 为 live，`previous` 供回退 |
| **`state`** | 栈的运行态：`uninitialized` / `stopped` / `running` / `partial`（另有 `last_error` 字段） |
| **`apply`** | 唯一让"实际部署与期望状态一致"的命令（版本变更、配置变更、no-op、崩溃恢复四合一） |
| **manifest** | Release 资产 `nojctl-manifest.json`：`deploy_format`、7 个镜像 digest、迁移清单摘要、`min_nojctl`、`min_source_version` |
| **别名** | `newest` / `stable` / `beta` / `alpha`：对"已发布且资产就绪"版本的**时间/渠道**选择器；解析结果是**具体 tag** |
| **资产就绪** | 该 Release 具备 `nojctl-manifest.json` 与全部镜像 digest 可校验；否则不可安装 |
| **交付自检** | 校验"`.env.prod` 里存在的键是否真的进入了容器"（对照渲染产出的 `env.delivery.json`） |
| **rootless Docker** | 以普通用户运行的 dockerd（userns + subuid），judge 通过 `/run/noj-judge/docker.sock` 使用 |

---

## 3. 现状证据（均为实测）

设计动机来自 v1 的真实缺陷，逐条留证：

1. **v1 规模与形状**：`noj-cli` 源码 23,168 行 + 测试 20,668 行；最大文件 `prod/lifecycle.ts`
   2096、`cli.ts` 1517、`prod/config.ts` 1217、`prod/drill/drill.ts` 1179、`prod/cli.ts`
   1172。命令面横跨三层入口（`cli.ts` / `prod/cli.ts` / `commands.ts`）+ 7 个子系统（lifecycle /
   backup / drill / judge / problem / schedule / TUI），术语重叠（`install` / `update` / `upgrade` /
   `verify` / `config check` / `--files-only`）。
2. **迁移有三个入口**：compose 的一次性 `migrate`
   服务（`/app/bin/noj db migrate && init system`）、core 启动时的
   `fatalStep("数据库迁移")`、gateway 启动时的自迁移（它有自己的 4 个迁移文件）。失败表现为"core
   没起来"，归因困难。
3. **发布资产名耦合**（2026-09-27）：GitHub 把以 `.` 开头的资产名改写为 `default.<name>`，而 CLI
   下载原名 `.env.prod.example` → `install` / `update` 对 `0.10.1-alpha.2`、`alpha.3`、`beta.1`
   三个版本**全线 404**（修复见 #588 → `0.10.1-beta.2`）。
4. **"填了不生效"**：`.env.prod.example` 文档化 69 个键、compose 引用 108 处，交叉审计发现 **12
   个键从未被 compose 引用**；其中 7 个邮件凭据（`EMAIL_PROVIDER=aliyun` 时缺了会静默降级 mock）与 1
   个 `JUDGE_REQUIRE_ISOLATED_DOCKER`（judge 的隔离校验因此在生产上是**哑的**）属真漏。
5. **v1 不物化挂载文件**：`bootstrap` 只下载 compose + env 模板，而 compose 挂载 `deploy/` 下 6
   个文件（nginx / minio / monitoring）→ 全新安装起不了 nginx。
6. **升级后 502**：core/ui 重建后容器 IP 变化，而 nginx 自身配置未变、不会被 `up -d` 重建 → upstream
   仍指旧 IP。
7. **没有原子回退**：升级路径是原地改文件 + `up -d`；interrupted 之后留下 `.bak-*` / `.orig` /
   `.staged` 残骸，系统无法判定"上次切到哪一步"。
8. **环境事实**：目标服务器常处于受限网络（Docker Hub 直连超时、`sudo`
   需密码），因此"下载官方镜像/包"不能作为唯一路径；发布侧因此必须自带可离线验证的 manifest。

---

## 4. 架构与不变量

### 4.1 分层

| 层 | 职责 | 关键性质 |
| --- | --- | --- |
| `cli` | clap 命令面：解析、帮助、别名展开 | 零业务逻辑 |
| `ui` | 进度、交互确认、口令门禁、`--json` | 交互只在这一层；非 TTY / `--json` / `--dry-run` 一律关掉交互 |
| `state` | 状态机 + `state.json` 持久化 | **唯一状态源**；原子写（tmp+rename+fsync） |
| `plan` | 由"当前状态 + 目标 + manifest"算世代计划 | **纯函数、零副作用**；`--dry-run` 即打印它 |
| `apply` | 准备 → 单点提交 → 验证 → 失败自动回退 | 唯一改系统的地方，且只按计划改 |
| `render` | `deploy_format` solver 注册表 → 产物 | **纯函数**；黄金文件测试 |
| `manifest` | 取 manifest、判定 `deploy_format`、迁移摘要 | 联网或离线（镜像 label）；失败关闭 |
| `backup` | 还原点：DB / 对象 / 卷 / 配置快照，单文件加密 | 独立子系统，`apply` 永不调用 |
| `runtime` | `Runner` 抽象（`Local` 先实现，`Ssh` 留 seam）+ `HostFs` / `Clock` / `Net` | 所有 IO 的唯一出口 |
| `versions` | 别名解析 + 风险列 | 资产就绪过滤；为空则报错不回落 |
| `doctor` | 自检与完整性报告 | 只读 |

**执行器选择**：栈定义是 compose（`nojctl` 渲染），落地用 `docker compose` CLI，状态读取用
`docker compose ps --format json` / `docker inspect`。**不**用 bollard 自己解释 compose
语义（那要重写 `depends_on` / profiles / healthcheck / 卷 / 网络）。代价：宿主机必须有 `docker` +
`compose ≥ 2.x`，进前置检查。二进制用 `rustls`（不链 OpenSSL）+ `x86_64-unknown-linux-musl`
静态链接。

### 4.2 不变量

1. **单一状态源**：只有 `state` 能改状态；`state.json` 原子落盘；并发由 `.nojctl/lock` 拒绝。
2. **渲染是纯函数**：同输入必同输出；产物与 manifest 的镜像 digest 交叉校验，不一致即失败。
3. **计划与执行分离**：`plan` 无副作用；`--dry-run` 零写操作（用假 `Runner` 断言）。
4. **提交点唯一**：一个世代只有一次"生效"动作；失败自动回退，且**回退豁免口令门禁**。
5. **数据不经 CLI 自动改动**：`apply` 不备份/不还原/不查库（见 §6.7）；`restore`
   是唯一改写数据的命令。
6. **失败关闭**：`deploy_format` 不认识 / 别名无解 / 资产不齐 / manifest 校验不过 / 目录外来 →
   拒绝执行并说清下一步。
7. **生成物归
   CLI，配置归用户**：`docker-compose.prod.yml`、`deploy/*`、`.env.prod.example`、`backups/` 之外的
   `.nojctl/` 全由 `nojctl` 生成并覆盖（文件头带声明）；`.env.prod` 永不被覆盖。
8. **传输无关**：所有 IO 经 `Runner` / seams；状态可序列化、可在远端重建（B 模式的前提）。
9. **确认前零写入**：向导/摘要在用户确认之前不落任何盘。
10. **世代保留**：默认保留上一个可回退世代（`keep_generations`，缺省 1）；verify
    通过前不清理被替换的世代。

---

## 5. 命令面与交互

### 5.1 命令（8 条 + `--version`）

| 命令 | 语义 |
| --- | --- |
| `deploy` | 首装：前置探测 → 配置向导 → rootless 引导（judge 开启时）→ 渲染与空转 → 摘要确认 → 执行 → 完成页 |
| `apply [版本\|别名]` | 唯一的"让实际与期望一致"：版本变更 / 配置变更 / no-op / 崩溃恢复 |
| `versions` | 版本表：每个 tag 的渠道、是否资产就绪、`deploy_format`、迁移摘要、本机是否装得了；四个别名 → 解析到的具体 tag（空显示 `—`）；当前部署；最近备份时间 |
| `status` | 当前世代、容器与健康、版本、`deploy_format`、世代/备份磁盘占用、**配置漂移提示** |
| `logs [服务]` | `compose logs` 薄封装（`--follow` / `--tail` / `--since`） |
| `doctor` | 只读自检：docker/compose 版本、judge socket 与 gid 自洽性、磁盘、`.env.prod` 权限与校验、**生成物与 state 是否漂移**、镜像 digest 与 manifest 一致、容器健康、备份新鲜度、旧文件残留 |
| `backup create\|list\|verify\|restore\|prune` | 独立还原点子系统（§8） |
| `uninstall` | 默认停栈 + 移除生成物，保留数据卷 / `.env.prod` / 备份；`--purge` 才删数据 |

全局：`--dir`（缺省当前目录）、`--dry-run`、`--json`、`-v/--quiet`。`apply`
额外：`--acknowledge-risk`（非 TTY
门禁）。`backup restore`：`--acknowledge-restore`、`--skip-safety-snapshot`。`uninstall`：`--acknowledge-purge`。

**别名语义**（四个都过资产就绪过滤；为空则报错不回落）：

| 别名 | 解析为 |
| --- | --- |
| `stable` | 最新**非预发布**且资产就绪 |
| `beta` | 最新 beta 渠道 |
| `alpha` | 最新 alpha 渠道 |
| `newest` | 最新**任意渠道**且资产就绪 |

别名解析的排序规则：**按语义化版本比较取最大**（预发布版本小于其对应的正式版，如
`0.10.1-beta.2 < 0.10.1`），并在候选集内只保留**资产就绪**者。

`deploy` 的默认别名是 `stable`；若 `stable` 为空则**不静默给 beta**，而是以**退出码 5**
报错并明确写出"最近可安装版本为 `X`（beta 渠道），确认使用请加 `--version X`"。`nightly`
作为**未来保留**（自动构建开发版通道，本仓库目前不产出），不占用现有语义。

### 5.2 退出码（稳定契约）

| 码 | 含义 |
| --- | --- |
| 0 | 成功（含 no-op） |
| 1 | 运行期失败（未分类） |
| 2 | 用法错误（clap 默认） |
| 3 | 前置/配置不合法（docker 缺失、`.env.prod` 校验失败、目录外来等） |
| 4 | 门禁未通过（口令错、缺 `--acknowledge-*`、用户拒绝） |
| 5 | 目标不可安装（`deploy_format` 太新、别名无解、资产不齐） |
| 6 | 失败但**系统处于干净的已知状态**（已回退到上一世代且健康，或已清理到未安装） |
| 7 | 失败且留下 `partial` 状态，**需要人工介入**（含"回退也失败"） |

### 5.3 门禁（口令）

| 触发命令 | 口令（全大写、逐字、去首尾空白） | 非 TTY 参数 |
| --- | --- | --- |
| `apply`（目标版本 ≠ 当前版本） | `I UNDERSTAND THE RISK AND HAVE BACKED UP` | `--acknowledge-risk` |
| `backup restore` | `I UNDERSTAND THIS WILL OVERWRITE CURRENT DATA` | `--acknowledge-restore` |
| `uninstall --purge` | `I UNDERSTAND THIS DELETES ALL DATA` | `--acknowledge-purge` |

规则：① 有 TTY 时**先打印完整风险信息，再要求输入**（知情状态下确认）；② 最多 2 次尝试，失败退出
4；③ 无 TTY 时直接报错退出 4 并给出对应参数；④ **不支持环境变量绕过**（CI
里一个全局变量会让门禁形同虚设）；⑤ **豁免**：失败自动回退、`--dry-run`、`apply` 的 no-op
与仅配置变更（后者用 `[Y/n]`）、所有非破坏性命令。

### 5.4 `--json` 契约

stdout 只含一个 JSON 文档，人话走 stderr，字段只增不改：

```jsonc
{
  "schema": 1,
  "command": "apply",
  "ok": false,
  "exit_code": 6,
  "from": "0.10.1-beta.2",
  "to": "0.10.1-beta.3",
  "deploy_format": 3,
  "data": {},
  "warnings": [],
  "next_steps": []
}
```

`next_steps` 为可执行建议（如 `nojctl doctor`），脚本可忽略。`config`
类密钥永远掩码，不落日志/管道。

### 5.5 `deploy` 交互编排

| # | 屏 | 内容 |
| --- | --- | --- |
| 0 | 前置探测 | 静默：docker/compose 版本、架构、磁盘、**目录守卫**（§9.3）、能否连 GHCR；失败退出 3 |
| 1 | 配置向导 | 逐问的行内提示（`inquire`/`dialoguer` 风格，**不做全屏 TUI**），只问 4 件事：① 对外地址（域名或 IP + 端口，默认 8080）② 是否启用 judge ③ 邮件 Provider（disabled/aliyun/tencent + 凭据掩码输入，或"稍后再配"）④ 首个管理员（可选，调容器内 `/app/bin/noj bootstrap first-admin`，跳过则打印可复制命令） |
| 2 | 推导与生成（不问） | 由 ① 推导 `APP_URL` / `CORS_ALLOWED_ORIGINS` / `DOMAIN`；`TRUSTED_PROXIES` 由我们生成的 compose 网络子网确定性算出；`S3_*` 与内网端点固定；`JWT_SECRET` / `TFA_ENCRYPTION_KEY` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `MINIO_ROOT_*` / S3 凭据**密码学强随机生成**；日志/保留期/资源上限取生产默认 |
| 3 | rootless 引导 | judge 开启时：打印发行版自适应的**幂等脚本** → **等待回车** → 探测 7 项（socket 存在且是 socket；gid 与将写入的 `JUDGE_DOCKER_SOCKET_GID` 一致且组有 rw；能 `docker -H … info`；确认是 rootless/userns 且 `Docker Root Dir` 在家目录，并与 `JUDGE_REQUIRE_ISOLATED_DOCKER=true` 自洽；`loginctl` linger 已开；**家目录**剩余空间；通过该 daemon 预拉评测镜像）→ 失败可重试或输入 `skip`（置 `JUDGE_ENABLED=false` 继续，并提示后续补装路径）。**向导不调用 sudo、不改宿主机** |
| 4 | 渲染 + 空转 | 渲染世代 → `compose config -q` → 端口占用 → 磁盘；任何一项不过 → **零写入**，退出 3 |
| 5 | 摘要 + 确认 | 版本/渠道/`deploy_format`、对外地址、服务清单、启用的 profile、生成密钥数、需下载镜像体积、迁移情况（见 §6.7：目标版本声明的迁移摘要）、`[Y/n]` |
| 6 | 执行 | ① 写 `.env.prod`（0600）+ 世代目录 ② 拉镜像（逐镜像进度）③ `up -d`（含 compose 内的 `migrate` 一次性服务，见 §6.7）④ 等健康 ⑤ 建首个管理员（若选） |
| 7 | 完成页 | URL、登录方式、**备份口令提示（请抄写，丢了就恢复不了）**、下一步建议（`versions` / `doctor` / `backup create`） |

失败语义：中断或失败 → `state=partial`，`deploy` 重跑**幂等续跑**（不重拉已缓存镜像），退出码
6（已清理到干净状态）或 7（需人工）。

非交互等价：`--domain`、`--port`、`--judge=on|off`、`--email=none|aliyun|tencent`、`--admin-email`、`--admin-username`，以及快路径
`deploy --domain oj.school.edu --yes`（未指定项取推导值/默认值/生成密钥）。

### 5.6 `apply` 交互编排

| 情形 | 期望状态来源 | 动作 | 门禁 |
| --- | --- | --- | --- |
| `apply beta` | 参数解析出的**具体 tag** + 当前 `.env.prod` | 完整事务 | 口令 |
| `apply`（配置变更） | `.env.prod` 的 `NOJ_VERSION` + 当前配置 | 完整事务（版本不变，容器重建） | 摘要 + `[Y/n]` |
| `apply`（无变化） | 同上，渲染 hash 与 `current` 一致 | **no-op**，退出 0 | 无 |
| `apply`（残留 journal） | 上次被中断的事务 | **恢复**：目标世代产物完整且镜像已在本地则续做提交，否则回退上一世代，然后验证 | 无 |

规则：① **别名只作一次性意图**：`apply beta` 成功后把解析出的具体 tag 写入 `.env.prod` 的
`NOJ_VERSION`，绝不写入别名（否则以后一次 `apply` 会静默漂移到未来某个 beta）；② 未初始化 →
报错并指向 `deploy`（退出 3），不自动进向导；③ 门禁规则一句话：_目标版本 ≠ 当前版本 → 要口令_；④
崩溃后**重跑 `apply` 即可**（自动判定续做或回退），不需要专用恢复命令；⑤ 栈处于 `stopped`
时摘要注明"切换后会启动"，然后照常启动。

摘要示例（**先信息、后门禁**）：

```
期望状态：0.10.1-beta.3（beta 渠道，deploy_format 3）
  · 变更：版本 0.10.1-beta.2 → 0.10.1-beta.3；配置无变化
  · 迁移：目标版本声明 95 条（本工具不查库，见 §6.7）
  · 镜像：4 个需下载（约 1.2 GB）
  · 最近备份：3 天前 ⚠ 建议先执行 nojctl backup create
  · 失败处理：验证不通过会自动切回 0.10.1-beta.2（应用层，数据不动）
请输入确认口令（全大写）：I UNDERSTAND THE RISK AND HAVE BACKED UP
```

### 5.7 `.env.prod` 与生成物（无 `config` 命令）

- **`.env.prod` 是唯一配置真相源**（0600，用户手写、向导首装生成）。`nojctl`
  只在向导补键时写入，否则永不覆盖。
- **`.env.prod.example` 由同一份 schema
  自动生成并带注释**（`# [必需] 交付给 core`、`# [可选] 默认 false`、`# [仅 nojctl 使用]`），不再从
  Release 下载 → 永不与真实键集漂移。
- **校验发生在 `deploy` / `apply` 的前置**（PREPARE），失败零写入、退出 3，错误信息指向**具体键名 +
  文件行号**（如"`EMAIL_PROVIDER=aliyun` 但 `ALIBABA_FROM_EMAIL` 为空（`.env.prod:134`）"）。
- **交付自检**（§7.4）：存在但无人接收的键 → 警告并列出；必需但缺失 → 失败。
- **`status` 报配置漂移**：比对 `current` 世代的配置快照与当前 `.env.prod` → "配置自 07:12
  起已变更，3 个键尚未应用；运行 `nojctl apply` 生效"。
- 生成文件头部声明示例：`# 本文件由 nojctl <版本> 生成（世代 <id>，deploy_format N，<时间>）。请勿手工编辑：任何修改都会在下次 deploy/apply 时被覆盖。`

---

## 6. 状态机与原子提交

### 6.1 状态与 `state.json`

`<dir>/.nojctl/state.json`（0600，tmp+rename+fsync）。状态收敛为 4
个：`uninitialized | stopped | running | partial`，另有 `last_error {at, kind, message}`。

```jsonc
{
  "state_schema": 1,
  "install_dir": "/opt/neuro-oj",
  "current": {
    "generation": "g-20260927-0712-3f9c",
    "version": "0.10.1-beta.2",
    "deploy_format": 3,
    "artifact_hash": "…",
    "image_digests": {},
    "applied_at": "…"
  },
  "previous": {},
  "journal": { "phase": "commit", "target": "g-…", "started_at": "…" },
  "last_verify": { "at": "…", "ok": true, "checks": [] },
  "last_restore": { "at": "…", "backup_id": "…" },
  "keep_generations": 1
}
```

### 6.2 世代布局

`<dir>/.nojctl/generations/<id>/`：渲染出的 compose、被挂载的 6
个文件、`env.delivery.json`、`manifest.json`、`artifact_hash`，以及**该世代实际生效的配置快照（0600）**——快照是"回退后配置也真的回到那一版"的前提，代价是多一份含密钥的文件（认可）。

`artifact_hash` 对 canonical 化产物（键排序、空白归一）取 hash，用于 no-op 判定与漂移检测。

### 6.3 事务三阶段

| 阶段 | 做什么 | 失败/中断后果 |
| --- | --- | --- |
| **PREPARE**（对线上零影响） | 渲染 → `compose config -q` → 校验 manifest digest → 交付自检与必需键校验 → 拉镜像 → 写世代目录 → 算 hash | 干净中止，线上原样，退出 6 |
| **COMMIT**（唯一提交点） | 先写 journal → 原子替换 live 文件 → `state.current` 前移、旧世代记为 `previous` → **一次** `up -d`（**显式 `--force-recreate nginx`**；judge 开启时带 `--profile judge`） | 崩溃落在此处 → journal 留在 `commit`，下次任何命令都能判定方向 |
| **VERIFY** | §6.6 | 失败 → 自动回退 |
| **FINALIZE** | `state=running`、写 `last_verify`、按 `keep_generations` 清理旧世代（verify 通过前不清理） | — |

**失败 → 自动回退**：恢复 `previous` 的文件与配置 → `up -d` → 再验证。回退成功 → 退出
6，输出"已自动回到 `X`，站点正常；原因：…"；回退失败 → 退出
7，`state=partial`，打印恢复步骤与建议备份 id。

**Ctrl-C**：提交窗口内屏蔽 SIGINT（跑完当前原子步再退出）；窗口外中断都留下可判定状态。

### 6.4 崩溃恢复

`apply` 重跑即恢复：读 journal → 目标世代产物完整且镜像已在本地 → **续做提交**；否则 →
**回退上一世代** → 验证。不需要专用命令，帮助文本直接写"上次 `apply` 若被中断，再跑一次 `apply`
即可"。

### 6.5 并发锁

`.nojctl/lock`（pid / hostname / command / started_at）。并发运行拒绝（退出 3）；同机且 pid 消失 →
视为陈旧锁自动清理；否则拒绝并说明。

### 6.6 VERIFY 的检查集（**不含数据内容校验**）

1. 期望容器集合齐全且 healthy（judge 无 healthcheck → 运行中 + 日志新鲜）；
2. HTTP 经 nginx：`/` 200、`/api/v1/problems` 200、`/healthz` 200；
3. **运行镜像 digest == manifest digest**；
4. `migrate` 一次性服务退出码为 0，且日志中无迁移错误（§6.7）；
5. `state.current` 与运行世代一致，无游离文件；
6. 启动后 core / judge / gateway 日志中无致命模式。

时间预算：PREPARE 单镜像 ≤ 20 min（可配）、总计 ≤ 45 min；COMMIT ≤ 5 min；VERIFY 总 ≤ 120 s（单检查
15 s、健康轮询 5 s）；回退路径同等预算，最坏 ≤ 10 min。

### 6.7 数据库迁移的责任边界（**A + A1**）

**内容与触发保持在镜像 + compose 里，`nojctl` 不执行、不查库，只观测。**

- **内容所有权**：服务端镜像（drizzle 迁移烤进 `noj-server`）；gateway 拥有自己的 4
  个迁移文件并在启动时自迁移。
- **触发**：生成的 compose 保留一次性 `migrate`
  服务（`/app/bin/noj db migrate && /app/bin/noj init system`）与
  `core.depends_on: migrate: service_completed_successfully`；这条不变量用**黄金文件测试**钉住，且对**任何入口**（`nojctl`
  或手动 `docker compose up -d`）都成立。**不为 gateway 增加一次性迁移服务。**
- **观测（A1）**：`nojctl` 在部署链路**零数据库访问**（`deploy` / `apply` / `doctor`
  都不连库、不执行 SQL）。归因来自 compose 事实——`migrate` 服务的退出码与日志：

  | `up -d` | `migrate` 服务 | 归因与动作 |
  | --- | --- | --- |
  | 成功 | 退出 0 | 迁移与应用都成功 → 继续 VERIFY |
  | 失败 | 退出 ≠ 0 | "**迁移未完成**（日志停在 `<迁移号>`）"→ 应用层未起 → 切回上一世代，退出 7（库可能停在中间点） |
  | 失败 | 退出 0 | "**迁移成功，应用层未起**"→ 切回上一世代，退出 6 |

- **摘要里的迁移信息**来自 manifest（目标版本声明的迁移摘要），**不含"新增 N
  条"这个精确增量**（那需要查库）。此为 A1 的已知代价。
- **follow-up**：将来由镜像提供 `noj db status --json`，`nojctl` 通过 `compose run` 去问——把"谁知道
  schema 状态"留在镜像里，而不是让 CLI 学会查库。

---

## 7. 生成器与 `deploy_format`

### 7.1 渲染是纯函数

```
render(deploy_format, config, probe) -> Artifacts
  probe = docker/compose 版本、架构、judge socket 探测结果、judge/monitoring 开关
  Artifacts = { docker-compose.prod.yml, deploy/{nginx,minio,monitoring}/*,
                env.delivery.json, artifact_hash }
```

无 IO、无时钟（时间戳参数注入）。被挂载的文件**总是物化**（含 monitoring 4 个，即使 profile
默认关闭）。

### 7.2 Solver 注册表与选择（失败关闭）

```rust
trait Solver { fn deploy_format(&self) -> u32; fn render(&self, cfg, probe) -> Result<Artifacts>; }
```

| 情形 | 行为 |
| --- | --- |
| manifest 声明 `deploy_format = N`，N 在支持集合 | 用对应 solver（**老 `nojctl` 照旧能装新版本**，只要格式没变） |
| `N >` 已知上限 | 退出 5："该版本需要 nojctl ≥ x.y" |
| `N <` 支持下限 | 退出 5："该版本使用已停止支持的部署格式 N" |

`deploy_format` 的来源两条路收敛到同一结构：① Release 资产 `nojctl-manifest.json`；② **镜像 label**
`org.noj.deploy-format`（离线时对本地镜像 `docker image inspect`）。两条都拿不到 → 失败关闭。

### 7.3 manifest 与 CI 不变量

```jsonc
{
  "manifest_schema": 1,
  "version": "0.10.1-beta.3",
  "deploy_format": 3,
  "min_nojctl": "0.1.0",
  "min_source_version": "0.9.0",
  "images": { "noj-server": "ghcr.io/…@sha256:…" /* 7 个 */ },
  "migrations": {
    "server": { "count": 95, "last_tag": "0094_…", "last_hash": "…" },
    "gateway": { "count": 5, "last_tag": "0004_…", "last_hash": "…" }
  },
  "published_at": "…"
}
```

- `migrations` 只存**最小可验证集**（计数 + 末条 tag + hash），不塞完整清单：迁移的权威在数据库的
  `__drizzle_migrations` 表。
- **跨多版本升级**不需要中间版本的 manifest，也不需要升级路径链：drizzle 从当前位置按 journal
  顺序**补齐**，目标镜像带着全量迁移文件；`deploy_format` 也只看目标版本。CI 已有
  `check-migration-safety.ts` 与 journal 一致性门禁守着这个前提。
- `min_source_version`（可选，缺省=无限制）：给"必须经由某个中间版本"的未来场景留的护栏；老 `nojctl`
  遇到时会拒绝盲跳。

**CI 三条不变量**（缺一条，前向兼容就会开始撒谎）：

1. manifest 里 7 个 digest 与实际推送的镜像一致；
2. 用**发布版 `nojctl`** 渲染目标版本 → `docker compose config -q` 通过；
3. 用渲染产物**真起栈 e2e**。

### 7.4 "文档化的键必进容器"两层

1. **构建期（CI 门禁）**：schema 里每个键，要么出现在某服务的 `environment`/`env_file`，要么显式标记
   `nojctl-only`。**"文档化但无交付目标" = CI 失败**（今天那 12 个键的永久防线）。
2. **运行期（`deploy`/`apply` 前置）**：`.env.prod` 存在的键对照 `env.delivery.json`——存在但无人接收
   → 警告并列出；必需但缺失 → 失败（退出 3，指出键名 + 行号）。

### 7.5 模板与测试

- 模板用 `include_str!` 的文本模板 + 受控的最小替换/条件块；渲染后**双重结构校验**（YAML 解析 +
  `docker compose config -q`）。
- **黄金文件**：每个 `deploy_format` × 代表配置（最小 / judge 开 / judge 关 / monitoring 开 / 域名
  vs IP / 自定义端口）。
- **确定性**：同输入两次渲染 `artifact_hash` 相同；键顺序无关。
- **兼容性**：每个"声称支持的 `deploy_format`"都跑 §7.3 的第 2、3 条。

### 7.6 bump `deploy_format` 的规则

判据清单：服务/profile
增删改、卷与网络集合变化、挂载文件集合变化、**必需配置键增删或语义变化**、健康检查/就绪语义变化、镜像名集合变化。**只有"旧
solver 产不出新版本所需描述"时才
+1**；纯镜像版本升级、注释与文案变化一律不动。这份清单同时是发布检查表的一项。

---

## 8. 备份与还原

### 8.1 产物：单文件、加密、自描述

```
snapshot-20260927-0712-<应用版本>.nojbackup      # tar → zstd → GPG 对称加密
├─ manifest.json    # schema、nojctl 版本、应用版本、deploy_format、迁移摘要、
│                   # 各组成部分大小与 sha256、关键表行数、对象清单摘要、创建时间
├─ postgres.dump    # pg_dump --format=custom
├─ objects/         # MinIO 桶内容（mc mirror 导出）
├─ volumes/         # noj-packages、noj-storage（存在则含）
└─ .env.prod        # 加密内含（没有它恢复不出可运行的实例）
```

- **默认强制加密**：没有 passphrase 就拒绝创建（内容是全部学生数据 + 密钥）。`deploy` 时自动生成随机
  passphrase 存 0600，完成页**显著提示抄写**；`doctor` 常驻检查该文件存在与权限。丢失 passphrase =
  备份不可恢复。
- 单文件的好处：`scp` 一个文件即可异地保存；一个 sha256 即可校验；不会"目录里坏了一半"。

### 8.2 命令

| 命令 | 语义 | 门禁 |
| --- | --- | --- |
| `backup create` | **不需要停机**（`pg_dump` 事务一致；对象 `mc mirror` 应用层一致）→ 打包 → **自动 verify 一次** → 打印 id/大小/耗时；任一步失败即删除半成品 | 无 |
| `backup list` | id / 时间 / 应用版本 / `deploy_format` / 大小 / 最近一次 verify 结果 / 磁盘占用 | 无 |
| `backup verify <id>` | **不需要栈运行**：sha256、GPG 可解、tar 可读、`pg_restore -l` 可解析、manifest 自洽、对象清单匹配、关键表行数与 dump 记录一致 | 无 |
| `backup restore <id>` | 唯一改写数据的命令（§8.3） | 最强口令 |
| `backup prune` | **默认 dry-run（零删除）**，`--confirm` 才真删；保留最近 N（默认 7）+ 至少 1 个已验证；**永不删"最近一个验证通过的"** | 需 `--confirm` |

### 8.3 `restore` 序列

1. 前置：`verify <id>` 必须通过，否则拒绝开始；备份的应用版本与当前部署不同 → 警告"恢复后建议
   `apply` 到匹配版本"，**不自动切版本**。
2. 门禁：`I UNDERSTAND THIS WILL OVERWRITE CURRENT DATA`。
3. **安全网**：自动给"当前数据"打一份快照（同机制）；若因磁盘不足失败，必须显式
   `--skip-safety-snapshot` 才能继续。
4. 停写入者：停应用层（core/ui/judge/llm-gateway/nginx）；**postgres 保持运行**（要接收还原）；**停
   minio**（对象卷不能边写边解包）。
5. 还原 DB：`pg_restore --clean --if-exists --no-owner --exit-on-error`（失败即整体回滚，不留半套
   schema + 半套数据）。
6. 还原对象与卷：解包回 minio / packages / storage 卷（辅助容器），再起 minio。
7. 起应用层 + **VERIFY（唯一做数据核对的地方）**：容器健康 + HTTP + **关键表行数与备份 manifest
   一致** + 对象条数一致。
8. 收尾：记 `state.last_restore`；打印"数据已恢复到 `<备份时间>`（id `<id>`）"+
   建议（`doctor`；若版本不同则 `apply <该版本>`）。

### 8.4 边界

`apply` 永不调用 backup/restore；`restore` 永不自动切版本；`backup` 永不改部署描述。备份放
`<dir>/backups/`，`doctor` 报告占用与磁盘余量；异地拷贝 = 一行 `scp`（文档说明，不做命令）。

---

## 9. 分发、目录与共存

### 9.1 分发模型：独立二进制

- **不软链、不写 PATH、不改 `~/.profile`、不把自己复制进 `<dir>/bin/`**；v1 的
  `path.ts`（全局目录优先、权限不足回落、同名命令冲突检测、源码运行模式告警）整块消失。
- 调用模型：`nojctl [--dir <安装目录>] <命令>`，`--dir`
  缺省为当前目录；二进制放在哪里由用户决定，**安装目录里只有数据与生成物，没有二进制**。
- `uninstall` 明确输出"工具二进制不归我管，请自行删除"。
- 该模型同时是 B 模式（将来由本地驱动远端）的天然形状。

### 9.2 目录布局与所有权

```
<install_dir>/
├── .env.prod                 用户所有（0600，手写）；nojctl 永不覆盖
├── docker-compose.prod.yml   nojctl 生成（头部声明）
├── deploy/                   nojctl 生成（nginx / minio / monitoring）
├── .env.prod.example         nojctl 生成（带注释的键清单）
├── .nojctl/                  nojctl 独占：state.json / lock / generations/
└── backups/                  单文件快照
```

### 9.3 目录守卫（拒绝外来目录）

- `deploy` 只接受**空目录或不存在的目录**（不存在则创建）。空 = 没有任何条目。
- 其余**写操作**要求存在 `.nojctl/state.json`；没有状态但目录里有内容 → **拒绝**（退出
  3）并列出外来条目。
- **只读命令**（`status`/`doctor`/`logs`/`versions`/`backup list`）可在外来目录运行，但输出置顶
  `⚠ 该目录不是 nojctl 管理的，本工具不会改动它`。
- `uninstall`（默认保留 `.env.prod` / `backups/`）提示"目录里仍留有 `.env.prod` 与
  `backups/`；要重新 `deploy` 请先移走它们，或使用 `--purge`"。

**两个结论**：① 原子性在第一次就成立（受管部署永远至少有一个世代，任何 `apply` 都有 `previous`）；②
**`nojctl` 不接管任何既有安装**，从旧实例迁移由用户自行决定（`v1 → nojctl` 迁移工具记为
follow-up）。

### 9.4 漂移守卫

live 文件与 `current` 世代的 `artifact_hash` 不一致（被手改、被 v1 覆盖等）→ **破坏性操作
fail-closed**，提示"部署文件不是 `nojctl` 生成的/已漂移，请先 `nojctl apply`
恢复受管状态"；`status`/`doctor` 照常报告差异与差异清单。文档一句话："别同时用两个 CLI
操作同一安装目录。"

### 9.5 卸载与交接

- `uninstall`（默认）：停栈 + 移除 `.nojctl/` 与生成物；**保留** `.env.prod`、数据卷、`backups/`。
- `--purge`：额外删数据卷 + `.env.prod` + 备份（口令 `I UNDERSTAND THIS DELETES ALL DATA`）。
- **永不自动删除**：数据卷、备份、`.env.prod`（`--purge` 例外）。

---

## 10. 测试与验收

### 10.1 故障注入矩阵（证明"原子"不是口号）

| 注入点 | 断言 |
| --- | --- |
| PREPARE：渲染失败 / digest 不符 / 拉镜像失败 | 线上零改动；退出 6；live 文件与 `current` 一致 |
| COMMIT：`up -d` 非零 / `migrate` 非零 / `SIGKILL` | 要么"旧世代且健康"（6），要么"`partial` + journal 可判定"（7）；**永不出现混合状态** |
| VERIFY：健康超时 / HTTP 非 200 / digest 不符 | 自动回退触发；回退后退出 6 且站点可用 |
| 回退本身失败 | 退出 7；`state=partial`；报告含恢复步骤与建议备份 id |

绝大多数用注入的 `Runner`（假 docker）跑；关键路径用真 docker 跑少量（含提交窗口内 `SIGKILL` 后重跑
`apply` 的崩溃恢复用例）。**新增不变量测试**：任何注入后必须满足"live hash == `current`
hash"或"`state=partial` 且 journal 可判定"。

### 10.2 幂等与零副作用

`apply` 两次 → 第二次 no-op（退出 0、零写操作）；`deploy` 中断后重跑幂等；`--dry-run` 用假 `Runner`
断言**没有任何写调用**；`doctor` 纯只读。

### 10.3 生成器测试

黄金文件（每个 `deploy_format` × 代表配置，含 §6.7 的 `migrate` + `depends_on`
不变量）；确定性（同输入同 hash）；双重结构校验；§7.4 第 1 层的 CI 门禁。

### 10.4 契约测试

退出码表每个码至少一个用例；`--json` schema 快照 + "字段只增不改"守卫；门禁三条路径（TTY
口令错/对/两次失败；非 TTY 报错与参数；豁免路径）；目录守卫（外来目录被拒、只读命令可跑）。

### 10.5 e2e（真 docker，CI）

空目录 `deploy` → 健康 → `doctor` 通过 → `backup create` + `verify` → **仅配置变更**的 `apply` →
**换版本**的 `apply` → 注入失败版本断言自动回退 → 目录守卫用例。

### 10.6 发布门禁

发布 workflow 增补四步：① manifest 的 7 个 digest 与实推镜像一致；② 发布版 `nojctl` 渲染 +
`config -q`；③ 真起栈 e2e；④ **用上一版 `nojctl` 装这个新版本**（前向兼容的逆向验证）。

---

## 11. 验收口径

- [ ] `deploy` 在空目录上从零到可用（含 rootless 引导），全程无需用户理解 compose / env / Docker
- [ ] `apply` 覆盖四种情形（版本变更 / 配置变更 / no-op / 崩溃恢复），门禁规则与退出码符合 §5.2–5.3
- [ ] 任一注入点失败后系统要么回到上一世代且健康（退出 6），要么 `partial` 且可判定恢复（退出
  7）；无混合状态
- [ ] `versions` 显示四个别名解析到的具体 tag（空显示 `—`）、当前部署、最近备份
- [ ] 生成器：黄金文件 + 确定性 + 双重结构校验通过；"文档化的键必进容器"CI 门禁通过
- [ ] 备份：单文件加密、`verify` 可不依赖运行中的栈、`restore` 前自动安全网、`prune` 默认 dry-run
- [ ] 目录守卫与漂移守卫按 §9.3–9.4 生效
- [ ] 本设计不改动 core / judge / ui / gateway 的运行时行为

---

## 12. 交付批次

| 批次 | 内容 | 依赖 |
| --- | --- | --- |
| **1** | 骨架：`Runner`/seams、`state` + `state.json`、`cli`/`ui`（`--json`/退出码）、目录守卫 | — |
| **2** | `render` + `deploy_format` 注册表 + 黄金文件 + manifest 取数与校验 | 1 |
| **3** | `plan` + `apply` 事务（PREPARE/COMMIT/VERIFY/回退/崩溃恢复）+ 故障注入测试 | 2 |
| **4** | `deploy` 向导 + rootless 引导子流程 + 非交互等价 | 3 |
| **5** | `backup` / `restore`（含加密、verify、安全网） | 1 |
| **6** | `status` / `logs` / `doctor` / `versions` / `uninstall` | 3,5 |
| **7** | 发布链路：manifest 资产 + CI 四道门禁 + 用上一版 CLI 的逆向验证 | 2,3 |

实施计划**按批次拆分**（而非一份覆盖全部）：建议第一份计划覆盖**批次 1–3**（骨架 → 渲染/manifest →
事务与回退），因为 `apply` 的原子语义是整个设计的承重墙；批次 4–7 各自成计划，可并行推进。

---

## 13. 开放问题与 follow-ups

1. **judge 网络收窄**（只给 redis + minio）——本次不做，但它是降低横向面最值钱的一步。
2. **`JUDGE_ALLOW_HTTP_S3` 默认改 false**、**production 下禁用 `local` 下载 scheme**。
3. **镜像提供 `noj db status --json`**，让 `nojctl` 能给出精确迁移增量（仍不查库）。
4. **`v1 → nojctl` 迁移工具**（当前明确不接管既有安装）。
5. **恢复演练 `drill` 自动化**、**定时/异地备份**。
6. **B 模式（SSH 远端执行）**：`Runner` seam 已留，需补 SSH 传输、远端状态、断线重连语义。
7. **aarch64 与 Windows/macOS 产物**（B 模式与跨平台受众的前提）。
8. **`noj` 名字的收编**：容器内 `/app/bin/noj`（`db`/`init`/`bootstrap`/`problem`）与宿主机 CLI
   同名不同物；将来若统一为 `noj`，需先给容器内 CLI 改名（本次不动）。
9. **监控栈**：`monitoring` profile 被忠实渲染但不算受支持特性。
