# Changelog

本文件记录 Neuro OJ 的**用户可见变更**，重点是**破坏性变更**（命令、配置、文件
形态、安装方式）。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

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
