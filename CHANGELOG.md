# Changelog

本文件记录 Neuro OJ 的**用户可见变更**，重点是**破坏性变更**（命令、配置、文件
形态、安装方式）。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 新增

- **公开赛关联题目保密**：题目被加入**公开赛**（`contests.kind='public'`，邀请赛除外）
  后，在竞赛结束时间之前，除**题目所有者**与**管理员**外，所有人访问该题目的题库页面与
  独立接口都按"不存在"处理（读取 404、独立提交/自测 403）；竞赛 `end_time` 一过自动恢复
  可见（赛后复盘、补题、题解继续可用）。所有者/管理员打开该题时会看到
  "当前题目已经被关联到竞赛 XXX，仅管理员和题目所有者可见，请注意保密工作"横幅
  （`GET /problems/:id` 新增 `contest_secrecy` 字段，只对这两类查看者下发）。
  题库与搜索列表仍保留条目（点入即 404）。

### 变更（破坏性）

- **竞赛关联题目的独立入口在赛前/赛中对所有人关闭（含参赛者）**：参赛者必须通过竞赛
  入口（`/contests/:id/problems/:label`、`/contests/:id/submit`）做题与提交；把题目
  收藏成 `/problems/<编号>` 直链在赛前/赛中会 404。携带**有效竞赛上下文**的接口
  （客观题套卷 `GET /problems/:id/questions?contest_id=`、starter code
  `GET /problems/:id/template?contest_id=`）不受影响。
- `noj-lmcc-extension` 只调用题库入口，因此被公开赛关联的题目在插件里"能搜到但无法
  提交"；LMCC 若以公开赛承载考试，需改用邀请赛或先扩展插件携带竞赛上下文。
- `GET /problems/:id/template` 补齐访问校验（此前**完全没有校验**，私有题的 starter
  code 对任意登录用户可读）：现与题目详情同口径，无权限一律 404。

---

## [0.10.1-alpha.3] - 2026-09-26

### 修复

- **生产镜像里邮件 Provider 从未被编译进二进制，所有发信链路不可用**（`0.10.1-alpha.2`
  部署实例实测）：`deno compile` 只对**字面量**动态导入做静态分析，而 `email.ts` 的装配点
  先用 `PROVIDER_MODULES[provider]` 取出模块路径字符串、再 `await import(modulePath)`，
  于是 aliyun / tencent / disabled / mock 四个 Provider 全部不在产物内。本地开发与单元
  测试跑的是源码、CI 也不执行该分支，缺陷只在生产容器里以
  `Module not found: file:///tmp/deno-compile-noj-server/src/domains/system/services/email-providers/aliyun.ts`
  暴露（管理后台测试邮件 503、注册邮箱验证与找回密码 500）。改为字面量加载器
  `PROVIDER_LOADERS`（`() => import("./email-providers/x.ts")`），保留惰性加载与
  `resetEmailProvider()` 语义。
- **阿里云 DirectMail 请求字段大小写错误，SDK 静默丢弃全部字段**：`@alicloud/dm20151123`
  的请求模型只识别 camelCase 属性（再由模型 `names()` 映射为 wire 上的 `AccountName` 等），
  原实现传 PascalCase，服务端因此只报
  `MissingAccountName: AccountName is mandatory for this action`——该报错看似"发信地址
  未配置"，实为字段名不被识别。改为 camelCase，并抽出 `buildSendMailParams()` 供契约测试。
- **腾讯云 SES 用 `btoa` 编码邮件正文，中文模板必然抛错**：`btoa` 只接受 Latin-1 字符，
  而本站邮件正文含中文，调用即抛 `InvalidCharacterError`。改为对 UTF-8 字节做 base64
  （`@std/encoding/base64`），并抽出 `encodeHtmlBase64()`。该修复仅静态验证（无腾讯云凭据）。

### 新增

- 仓库级门禁 `scripts/verify-compile-safe-imports.ts`（含 7 条自测，已注册进
  `scripts/gate-list.ts`）：扫描 `deno compile` 产物对应的源码根（`noj-core/src`、
  `noj-core/scripts`、`noj-cli/src`），禁止 `import(<非字面量>)`。门禁自带正/反例控制断言，
  解析规则失效即失败；对修复前的同一份代码会报出 2 处违规，可直接复现该故障。
- `tests/shared/email-providers.test.ts` 新增两条离线契约测试：阿里云请求字段必须能被 SDK
  模型映射为 wire 参数、腾讯云中文正文 base64 必须可还原为原始 UTF-8 字节。

### 变更

- 版本号同步为 `0.10.1-alpha.3`（noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge + CLI `VERSION` 常量与断言；`Cargo.lock` 由
  `cargo metadata` 重新生成，仅版本行）。

---

## [0.10.1-alpha.2] - 2026-09-25

### 修复

- **网关运行镜像的 dev 依赖仍未清除（`0.10.1-alpha.1` 的修法不充分）**：把 `drizzle-kit`
  移出 `imports` 并不够——`nodeModulesDir: "auto"` 安装的是 **`deno.lock` 中解析出的整个
  npm 包集合**，而 alpha.1 的 lock 仍把 dev 链（`drizzle-kit` → Go 编写的 `esbuild`）
  解析在内，于是镜像里依旧出现 18 个 `@esbuild*` 目录、6 个 Go 二进制，Trivy 门禁继续失败
  （已在本地完整复现 CI 的镜像内容）。
  本版把 lock 收敛到**非 dev 图**（`src/main.ts`、`src/mod.ts`、`tests/*.ts`、`scripts/*.ts`，
  排除 `drizzle.config.ts`）：25 262 B → **3 662 B**，dev 链 0 处提及；并给 `db:generate`
  任务加 `--no-lock`，避免开发者运行生成迁移时把 dev 链写回 lock。
  实测（同一 Dockerfile 构建）：镜像内 Go 二进制 **0 个**、`/app/node_modules` 仅
  `drizzle-orm` / `hono` / `ioredis` / `postgres`、Trivy 同参数复扫**退出码 0**、
  `--network none` 启动**无任何下载**、镜像 432 MB → **254 MB**。

### 变更

- 版本号同步为 `0.10.1-alpha.2`（noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge + CLI `VERSION` 常量与断言）。

---

## [0.10.1-alpha.1] - 2026-09-25

### 修复

- **生产镜像发布链路阻塞（网关运行镜像混入构建期依赖）**：`noj-llm-gateway` 的
  `deno.json` `imports` 里登记了**仅构建期使用**的 `drizzle-kit`（只服务
  `drizzle.config.ts` 与 `db:generate`），而 `nodeModulesDir: "auto"` 会把它整棵树
  装进运行镜像；其传递依赖 `esbuild` 由 Go 编写，触发发布流水线 Trivy 门禁的
  49 项 HIGH/CRITICAL Go stdlib CVE。
  影响不止该镜像缺 `v0.10.0` 标签：`build-and-gate` 矩阵失败使 `verify-release` /
  `publish-cli` / `publish-release` 全部不执行，Release 因此**没有 `noj-cli` 二进制，
  也没有 `docker-compose.prod.yml` / `.env.prod.example` 资产**；而 `noj-cli install`
  第 1 步会无条件从同版本 Release 下载这两个文件并校验 SHA-256，导致**任何版本、
  任何 ref 的 `install` 都在 bootstrap 步骤 404**（`v0.9.5` 的 Release 缺同样资产，
  同一个原因）。
  修法：把 `drizzle-kit` 移出 `imports`，`drizzle.config.ts` 改用完整 URL 说明符，
  使运行期依赖图不再包含该链。镜像 432 MB → **254 MB**，容器启动不再联网补装依赖。

### 变更

- 版本号同步为 `0.10.1-alpha.1`：noj-cli / noj-core / noj-llm-gateway / noj-ui /
  noj-lmcc-extension / noj-judge，以及 CLI 的 `VERSION` 常量与其断言测试。

---

## [0.10.0] - 2026-09-25

### 破坏性变更

#### 1. 首次安装不再有自举脚本

- **删除**：`setup.sh`、`scripts/deploy/install.sh`。
- **现在**：从 Release 手动下载 `noj-cli-linux-amd64` 与 `.sha256`，校验后执行
  `noj-cli install --dir <目录>`。`install` 自己从同版本 Release 拉取
  `docker-compose.prod.yml` / `.env.prod.example` 并校验 SHA-256，
  再生成 `.env.prod`（600，含自动生成的强随机密钥）、校验配置、拉镜像并等待健康检查。
- **为什么**：自举脚本存在的唯一理由是"CLI 尚未安装"，而它带来了两条并存的安装路径
  （`install.sh` 的 `--files-only` / `install-env` 等）与一处版本漂移面
  （CLI 与部署文件取自不同来源）。

#### 2. 移除 JSON 编排模式与开发部署模式

- **删除的命令**：`deploy`、`maintain`、`stack`、`run-server`、`doctor`。
- **删除的配置**：`noj-deploy.json`、`noj-secrets.json`（若目录里仍有，可直接删除）。
- **删除的命令面**：`noj-cli deploy init --mode dev` 等开发部署入口。
- **现在**：配置真相源唯一 —— `.env.prod` + `docker-compose.prod.yml`。
- **源码开发**是两段式：`docker compose up -d`（仅基础设施）+ 各模块
  `deno task dev`。
- **为什么**：该模式实测**从未被使用**（全仓零个真实 `noj-deploy.json`）且**已损坏**
  （`devTemplate` 指向源码目录中不存在的二进制）。保留它会让"同一个词
  （`status`/`logs`/`backup`）在两个深度上含义不同"的混乱永久化。

#### 3. 备份形态统一为 `.nojbackup` 单文件

- **旧**：`snapshot-<ts>/` 目录，其中只有 `env.prod.gpg` 加密，
  `postgres.dump` / `redis.rdb` / `minio/` 均为**明文**。
- **新**：`snapshot-<ts>.nojbackup` 单文件 + 同级 `.sha256`，**整包** GPG AES-256
  加密；包内 `manifest.json` 标 `payload_layout=prod-raw`，
  `postgres.dump` 与 `redis.rdb` 为**原始二进制**（经文件重定向采集，不经字符串）。
- **为什么**：目录形态有两个后果——搬迁会漏文件；"加密备份"名不副实
  （能读目录的人就拿得到全库转储）。
- **迁移**：旧目录快照已不受支持。请用旧版工具恢复/导出后重新创建备份。

#### 4. `backup` 子命令与默认行为

| 命令 | 说明 |
| --- | --- |
| `backup create [--retention-days N] [--min-free-mb N]` | 产出单个 `.nojbackup`（+ `.sha256`）；采集前校验可用空间，成功后按保留天数清理过期快照 |
| `backup verify [--deep] [--payload-sha]` | 三档校验：文件完整性 / 结构可解析 / 摘要比对 |
| `backup list` / `backup prune` | `prune` **默认 dry-run**，`--confirm` 才真正删除；legacy 目录默认保留 |
| `backup restore --dry-run` | 只规划并校验，**零副作用**（不触 docker、不改配置） |
| `backup drill` | 隔离环境真实恢复演练：独立 Compose 项目/子网、**不映射宿主机端口**；RPO/RTO 超限 = 失败(1)，资源不足 = 2 |
| `backup schedule install\|status\|remove` | crontab **标记区块**（只动自己那几行） |

> `prune` 两个条件都不给时**不删任何东西**；这是刻意的安全默认。

> **口令文件**：`--passphrase-file` > `NOJ_BACKUP_PASSPHRASE_FILE`（进程环境）>
> `.env.prod` 中的同名键。`verify`/`restore`/`drill` 都按此顺序解析——
> `--no-encrypt` 只关闭**整包**那一层加密，包内 `env.prod.gpg` 恒为加密，
> 因此这些命令始终需要口令。

#### 5. 命令接线改为纯 TS（不再有 bash 转发）

- **旧**：`noj-cli status` → `bash scripts/deploy/production.sh status` → `deploy.sh`。
- **新**：`noj-cli status` → `src/prod/lifecycle.ts` → `docker compose ps`。
- **删除的脚本**：根 `noj`、`production.sh`、`backup-schedule.sh`、
  `judge-install.sh`，以及 `test-*.sh`（9 个，其覆盖由 `noj-cli` 的 TS 测试承接）。
- **效果**：`noj-cli` 的编译产物在**仅含 docker/curl/openssl** 的环境即可完成全部
  命令，不再需要仓库脚本。

#### 6. 过渡期：两个脚本已废弃

`scripts/deploy/deploy.sh` 与 `restore-drill.sh` 暂时保留，但**每次执行都会**：

1. 打印弃用警告并给出替代命令；
2. 要求输入 `y` 确认（输入其它内容 → 退出且**无副作用**）；
3. 自动化环境需显式设置 `NOJ_ACCEPT_DEPRECATED=1` 跳过；
4. **非 TTY 且未设置该变量 → 明确报错退出**（不会挂起）。

这两个脚本（及其依赖 `backup.sh`）将在后续版本删除。

### 新增

- `noj-cli backup drill`：隔离恢复演练（独立项目/子网、不映射端口、失败也清理）。
- `noj-cli backup schedule`：crontab 标记区块管理（幂等、危险表达式拒绝）。
- `noj-cli judge *`：独立 Judge Worker 部署。**强制**专用 rootless Docker socket，
  拒绝 `/var/run/docker.sock` 与 `/run/docker.sock`；不安装/不替换宿主 Docker daemon。
- `noj-cli problem init` 交互引导：含字段校验、回退（`:b`）与进度提示；
  EOF/连续无效输入**有界报错**而非挂死。
- `--json` 通道：所有生产命令的 stdout 在 `--json` 下**逐字节**为合法 JSON。
- 三档备份校验、`prune` 默认 dry-run、`restore --dry-run` 零副作用。

### 修复

- **`problem init` 在 Ctrl-D（EOF）时无限循环**并把进程堆吃满：现在有限次后
  明确报错，并给出可直接粘贴的自动化命令。
- **定时备份会静默失败**：cron 条目原先指向 `scripts/deploy/backup.sh`（已删除），
  现指向 `<安装目录>/bin/noj-cli backup create`。
- **`uninstall --all` 永久自锁**：完整性判据原含已删除的 `deploy.sh`，
  现改为"CLI 二进制 + 两个生产特征文件"。
- **迁移 `0000` 系列的跨 schema 外键**与 judge 结果竞态（见历史提交）。
- **`noj-cli judge` 此前完全不可用**：该命令的子命令已实现并有 36 个测试通过，
  但未接入命令表与分发——调用会得到"未知命令"。现已接通全部 8 个子命令，
  并补上缺失的 `judge install-env`（依赖检查 + rootless 隔离指引）。
- **`--help` 在窄终端（≤40 列）下破版**：26 行溢出到 80 列，且部分内容重复打印。
  现在按终端宽度自适应（`COLUMNS=30` 起零溢出）。
- **`--help` 曾承诺 `--profile <prod|stack>`**，而 `stack` 已被拒绝
  （报"无效的 --profile: stack；可选值: prod"）——help 与实现自相矛盾。已改为 `--profile <prod>`。
- **`noj-cli status --dir <不存在>` 的退出码随 `--profile` 显隐而变**（2 / 1）。
  现统一为 1（运行失败），与 `--profile` 是否显式无关。

### 文档

- `AGENTS.md` §5.2 改写为**两段式开发流程**，并标明已删除的命令与脚本。
- `noj-cli/README.md`、`noj-docs` 的生产部署与运维文档按现状重写。
- `ROADMAP.md` 校准：移除未实现的多语言承诺；补上已实现项的代码证据与端点。
- 新增 CHANGELOG（本文件）。

---

## 历史版本

`v0.9.5` 及更早版本见 GitHub Releases：
<https://github.com/Neuro-OJ/neuro-oj/releases>
