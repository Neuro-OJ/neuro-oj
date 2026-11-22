# noj-cli

Neuro OJ 部署与运维 CLI（纯 TypeScript，Deno 运行时；生产二进制支持 Linux
amd64）。

> **单一配置真相源**：`.env.prod` + `docker-compose.prod.yml`。 早期版本还有一套
> JSON 编排模式（`noj-deploy.json` + `noj-secrets.json`）与
> `deploy`/`maintain`/`stack`/`run-server`/`doctor`
> 命令，已实测从未被使用且已损坏， 现已全部移除。若目录里仍有那两个 JSON
> 文件，可直接删除。
>
> 注意：P1d（2026-10-20）重新引入的 `maintain` 是**全新的 Tier 3 容器命令**
> （维护模式/排空，见下文「维护模式与自动排空」），与已删除的 JSON 编排
> `maintain` 无关。

## 首次安装

**不再有自举脚本**（`setup.sh` / `scripts/deploy/install.sh` 已移除）。生产主机
无需 Deno：从 Release 下载 `noj-cli-linux-amd64` 与 `.sha256`，校验后执行
`install`， 它会自己补齐所需的 Compose 文件。

```bash
# 1) 下载并校验二进制（Release 资产含 .sha256）
VERSION=v0.10.6   # 替换为目标 Release 标签
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64"
curl -fsSLO "https://github.com/Neuro-OJ/neuro-oj/releases/download/$VERSION/noj-cli-linux-amd64.sha256"
sha256sum -c noj-cli-linux-amd64.sha256
chmod +x noj-cli-linux-amd64

# 2) 安装到目标目录（空目录亦可：install 自己拉同版本 compose/example 并校验 SHA-256）
./noj-cli-linux-amd64 install --dir /opt/neuro-oj --ref "$VERSION"

# 3) 安装成功后 PATH 注册指向 <dir>/bin/noj-cli，可直接使用
noj-cli status
```

安装过程会：拉取同版本 `docker-compose.prod.yml` / `.env.prod.example` 并校验
SHA-256 → 生成 `.env.prod`（600，含自动生成的强随机密钥）→ 在 TTY 下进入配置向导
（网站地址、邮件、Judge）→ 校验镜像签名 → 拉取镜像并等待健康检查 →
记录部署元数据 → 注册 PATH。

> Release 必须同时包含 CLI
> 二进制、校验文件与两个部署文件；缺少资产时**明确报错**， 不会混用不同版本。

> **兼容范围（重要）**：compose / `env.prod.example` 资产自 **0.10.1-beta.2**
> 起才 以可用的名字纳入 Release（更早的 v0.9.5 没有这两个资产；0.10.1-beta.1
> 及之前的 `.env.prod.example` 被 GitHub 改名为
> `default.env.prod.example`，同样不可用）。
>
> **省略 `--ref` 时**，`install` / `update --latest` 选择最新的非 draft、非
> prerelease 且资产齐备的 Release。发布流水线只在全部校验通过后才把**稳定版
> （`vX.Y.Z`）**转正为正式 Release；自 `v0.11` 起，带 SemVer 预发布后缀的标签
> （如 `v0.11.0-rc.1` / `-beta.N` / `-alpha.N`）在资产就绪后仍保持
> `prerelease=true`，不会被 `install`（省略 `--ref`）或 `update --latest`
> 自动选中，安装/验证候选版本请显式 `--ref <标签>`。历史已转正的预发布标签 （如
> `v0.10.4-rc.1`）仍保持兼容；**0.10.4 及更早**的 CLI 仍只认纯 `X.Y.Z`
> 标签，使用这些版本的二进制时请显式 `--ref <标签>`。推荐始终用 `--ref`
> 指定与二进制一致的版本。

> **运行时依赖（重要）**：二进制是**动态链接 glibc** 的，因此需要 glibc 系统
> （Debian / Ubuntu / RHEL / CentOS 等）。**Alpine 等 musl 发行版不能运行**
> （实测报 `not found`）——若目标主机是 Alpine，请在宿主机或 glibc 容器内执行。

## 日常运维

```bash
noj-cli check                  # 配置、依赖校验与分区磁盘余量/低空间告警
noj-cli verify                 # check + 镜像签名验证
noj-cli config check           # 只做本地配置校验
noj-cli status                 # 状态（含 compose ps 表与安装/Docker 分区磁盘余量）
noj-cli logs core --follow     # 日志（着色契约 + 实时跟随）
noj-cli start | stop | restart # 启停（stop 不删数据卷）
noj-cli update                 # 按 .env.prod 的版本升级（先做数据+镜像空间预检，再自动备份与排空）
noj-cli update --latest        # 升级到最新的资产就绪正式 Release（已是最新则 no-op）
noj-cli maintain status        # 维护模式/排空状态（blockers、队列与在途任务）
noj-cli maintain enter | wait | exit   # 人工进入 / 等待排空 / 退出维护模式
noj-cli backup create          # 创建 .nojbackup 单文件快照（流式降峰，启动前清理崩溃残留并按数据量预检空间）
noj-cli backup verify <快照> --deep
noj-cli backup list | prune    # prune 默认 dry-run，--confirm 才真正删除
noj-cli backup restore <快照> --dry-run   # 只规划并校验（等价于省略 --confirm）
noj-cli backup restore <快照> --confirm   # 真实恢复（不可逆）
noj-cli backup drill <快照>    # 隔离环境真实恢复演练（分钟级、需专用 Docker daemon）
noj-cli backup schedule install --schedule '15 2 * * *'
noj-cli uninstall              # 保留数据卷、配置与备份
noj-cli uninstall --all --yes  # 连数据卷与安装目录一起删除（需确认）
```

`upgrade` 是 `update` 的别名。升级序列为：同步部署文件 → **备份** → 拉取镜像 →
**验签** → **进入维护并等待排空** → 启动并等待健康检查 → **退出维护** →
记录元数据； 任一阶段失败即中止且不宣称成功。

### 维护模式与自动排空（P1d）

`update` 默认在**验签通过之后、启动目标栈之前**调用 core 的内部排空 API：

1. `maintain enter`：进入维护模式（此后写请求返回 503 `MAINTENANCE`）；
2. `maintain wait`：轮询直到在途评测、judge/result 队列全部清空 （默认间隔 5
   秒、超时 1800 秒，可用 `--drain-timeout <秒>` 调整）；
3. 启动目标栈并通过健康检查后 `maintain exit`，恢复写请求。

进入/等待失败会**中止升级**（不启动目标栈、不提交暂存配置）并尽力退出维护模式，
同时给出可操作提示；退出失败则显式报告半完成（服务已启动但仍在维护模式），
此时请执行 `noj-cli maintain exit` 恢复写请求。

内部 API 需要 `.env.prod` 中的服务凭据（可选 bootstrap 配置）：

```bash
# 生成并写入 .env.prod（随后重启/重建 core 容器使其生效）
openssl rand -hex 32    # → NOJ_INTERNAL_SERVICE_TOKEN=<上一步输出>
```

- **未设置该变量**：drain 端点返回 503，自动排空不可用，`update` 会中止并提示；
  过渡期可用 `--skip-drain` 显式跳过自动排空（跳过前请自行确认没有在途任务）。
- **首次从尚无该 API 的旧版本升级**：旧 Core 返回 `endpoint_unavailable`，
  `update` 会打印告警并**继续升级**（一次性切换）；升级完成后设置该变量即可
  让后续升级启用自动排空。若仍希望显式跳过，用 `--skip-drain`。
- 人工干预：`noj-cli maintain enter|status|wait|exit`（Tier 3，容器内执行； 支持
  `--json`、`--timeout`、`--interval` 透传）。

**备份是 `.nojbackup` 单文件**（通过 `tar | zstd | gpg` 流式管道整包 AES-256
加密，不落中间 `.tar.zst` 并在打包后立即清理 staging；manifest 标
`payload_layout=prod-raw`），同级 `.sha256` 为校验文件。包内含
`postgres.dump`（原始二进制）、`redis.rdb`、`minio/` 与加密后的
`.env.prod`。`backup create` 启动前会按 `.nojbackup-create.lock` 与 PID
存活检查清理崩溃残留的临时文件，并结合 PostgreSQL / Redis / MinIO 数据量与
`--min-free-mb` / `NOJ_BACKUP_MIN_FREE_MB` 兜底下限执行空间预检。

`backup drill` 会起**独立 Compose 项目**（默认 `noj-drill`）、独立子网，且
**不映射宿主机端口**；必须用 `--docker-host` 或 `NOJ_DRILL_DOCKER_HOST`
指定专门的 Docker daemon socket，禁止把生产默认 `/var/run/docker.sock` 交给演练
命令。daemon 应使用独立 data root 和网络，准备方式见
`dev-docs/engineering/architecture-remediation-p8.md`；RPO/RTO 超限视为演练失败
（退出码 1），资源不足为 2。

## 目录定位

查找顺序：`--dir` → 当前目录及祖先 → 安装后二进制所在目录。未加入 PATH 时可直接
运行 `/opt/neuro-oj/bin/noj-cli status`。管理多个安装时显式指定：

```bash
noj-cli status --dir /opt/neuro-oj
noj-cli logs core --dir /opt/neuro-oj --follow
```

## 独立 Judge Worker

Judge 需要**只服务于它的 rootless Docker socket**——禁止使用应用宿主机的
`/var/run/docker.sock` 或
`/run/docker.sock`（挂载它等于把评测代码提升到能操作宿主
全部容器）。本工具**不安装、不替换、不配置**宿主 Docker daemon，宝塔类面板只做
探测与提示。

```bash
noj-cli judge install-env      # 检查依赖并输出 rootless 准备指引
noj-cli judge install          # 首次配置并启动独立 Judge
noj-cli judge check            # 配置 / Redis / 专用 socket / 镜像架构
noj-cli judge status | logs | stop | start | upgrade
noj-cli judge reset-config --group <资源组> [--ai-tasks 6] [--restart]
                               # 排空后解除资源组容量锁（可同时调整并发并重建）
```

## 题目包管理

```bash
noj-cli problem init <slug> [--judge-type dual|oi] \
  [--difficulty easy|medium|hard]
noj-cli problem init <slug> --template code|prediction|llm|objective|ui
noj-cli problem lint <目录>
noj-cli problem test <目录> [--solution <文件|目录>[@名称]]... [--expect good=100]... [--json]
noj-cli problem pack <目录> --out <目录>
noj-cli problem migrate <目录>   # 将旧格式 problem.json 原地改写为格式 3
noj-cli problem import --domain school --dir <题包目录>
noj-cli problem push <目录或zip> --server https://noj.example.com --domain school
noj-cli problem push <目录或zip> --server https://noj.example.com --domain school --publish
noj-cli problem skill [目录] [--force]   # 写入 AI 出题 Skill
```

`problem init` 生成格式 3 最小题包（`kind` 声明题型，AI 题 `runtime_config`
由平台缺省值补全）。`lint` / `pack` 直接复用 noj-core 的校验实现：格式 1 P
题包与格式 2 题包会自动转换并提示升级，`pack` 输出格式 3；`migrate`
用同一转换把源 `problem.json` 改写为格式 3，不写入平台缺省值。题包中的数字
`number` 可选，目标 Domain 通过 `problem import --domain <slug>` 传给 core
容器，省略时使用默认域 `main`。LLM 包只保留单次 `max_calls` / `max_tokens`
预算，Provider 和模型由使用域配置。

`problem init` 在 TTY 下进入交互引导（含校验与回退，输入 `:b` 退回上一步）； 非
TTY 或 `--no-interactive` 需显式给出参数。

`problem test` 先跑 lint，再经 `noj-judge run-local`（与线上 Worker 同一评测
入口）在本地 Docker 沙箱逐个评测参考解答（缺省读取 `submissions/` 与
`submissions/expect.json`），退出码 0 通过 / 1 校验或断言失败 / 2 用法错误。默认
不联网，LLM 题默认离线 mock；详见文档站「出题人 → 本地验题」。

`--template` 从五类**可验题模板**生成（代码题、预测提交题、LLM 工程题、客观题、
界面题）：每个模板自带评测脚本、满分解 / 错解 / 空解与
`submissions/expect.json`， 生成后可直接 `problem test` 验题，再按模板 README
改造。模板事实源在 `noj-core/scripts/problem-templates/`，与
`noj problems init --template` 共用。

`problem skill` 把 AI 出题 Skill（`noj-problem-setter`）写入目标目录（缺省当前
目录）的 `.agents/skills/` 与 `.claude/skills/`，AI 编码助手在出题仓库里即可按
「选题型 → 模板 → 评测脚本 → 参考解答 → 验题 → lint → pack/push」的流程出题。
已存在且内容不同时不覆盖，加 `--force` 整体替换。Skill 事实源在
`noj-cli/skills/noj-problem-setter/`，由 `src/problem/gen-skill.ts`
嵌入单二进制。

`--judge-type oi` 会生成 C99/C++11 传统 OI 题包骨架（`testdata/`、default
checker 与子任务配置），不生成双容器题所需的 `evaluate.py`。

## 开发与验证

```bash
cd noj-cli
deno task check           # fmt + lint + 类型检查
deno task test            # 全部 TS 测试
deno task test:production # 生产侧（prod/）测试
deno task build:cli       # 交叉编译 Linux amd64 → bin/noj-cli-linux-amd64
```

> **R1 约束**：`src/` 内**零** bash / 仓库脚本调用——全部运维能力均为 TS 实现。
> 由 `src/prod/cli_test.ts` 的门禁断言（剥掉注释后检查代码）。

## 目录

- `src/cli.ts`：命令分发、参数解析、退出码映射
- `src/prod/`：**生产域**（唯一模态）
  - `lifecycle.ts` /
    `lifecycle/steps.ts`：install/start/stop/restart/status/logs/
    update/uninstall 的实现与共享步骤
  - `compose.ts`：`docker-compose.prod.yml` 调用封装（不引入运行时渲染）
  - `bootstrap.ts` / `release.ts`：Release 资产下载与版本解析
  - `config.ts`：配置校验、向导、口令、镜像验签
  - `backup/`：`.nojbackup` 容器、prod-raw 驱动、verify/list/prune/restore
  - `drill/`：隔离恢复演练（原生）
  - `schedule.ts`：crontab 标记区块
  - `judge/`：独立 Judge 部署
  - `maintain.ts`：维护模式/排空的 Tier 3 容器包装（`noj-cli maintain …`）
  - `lifecycle/drain.ts`：`update` 自动排空（enter/wait/exit 的默认实现与解析）
  - `cli.ts`：上述实现到 CLI 的接线层
- `src/core/`：配置 schema、`.env.prod` 原子读写、状态机
- `src/output/`：`--json` 通道与表格/状态符号渲染
- `src/problem/`：题目包 init/lint/pack
- `src/runtime/`：命令执行、二进制下载、日志文件
- `src/util/`：参数、颜色、随机密钥、文件工具

## 生产入口

生产部署、备份、恢复与演练统一使用 `noj-cli`；仓库不再保留 Bash
部署入口或弃用闸门。
