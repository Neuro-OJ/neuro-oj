# noj-cli

Neuro OJ 部署与运维 CLI（纯 TypeScript，Deno 运行时；生产二进制支持 Linux
amd64）。

> **单一配置真相源**：`.env.prod` + `docker-compose.prod.yml`。 早期版本还有一套
> JSON 编排模式（`noj-deploy.json` + `noj-secrets.json`）与
> `deploy`/`maintain`/`stack`/`run-server`/`doctor`
> 命令，已实测从未被使用且已损坏， 现已全部移除。若目录里仍有那两个 JSON
> 文件，可直接删除。

## 首次安装

**不再有自举脚本**（`setup.sh` / `scripts/deploy/install.sh` 已移除）。生产主机
无需 Deno：从 Release 下载 `noj-cli-linux-amd64` 与 `.sha256`，校验后执行
`install`， 它会自己补齐所需的 Compose 文件。

```bash
# 1) 下载并校验二进制（Release 资产含 .sha256）
curl -fsSLO https://github.com/Neuro-OJ/neuro-oj/releases/download/v0.9.5/noj-cli-linux-amd64
curl -fsSLO https://github.com/Neuro-OJ/neuro-oj/releases/download/v0.9.5/noj-cli-linux-amd64.sha256
sha256sum -c noj-cli-linux-amd64.sha256
chmod +x noj-cli-linux-amd64

# 2) 安装到目标目录（空目录亦可：install 自己拉 compose/example 并校验 SHA-256）
./noj-cli-linux-amd64 install --dir /opt/neuro-oj

# 3) 安装成功后 PATH 注册指向 <dir>/bin/noj-cli，可直接使用
noj-cli status
```

安装过程会：拉取同版本 `docker-compose.prod.yml` / `.env.prod.example` 并校验
SHA-256 → 生成 `.env.prod`（600，含自动生成的强随机密钥）→ 在 TTY 下进入配置向导
（网站地址、邮件、Judge）→ 校验镜像签名 → 拉取镜像并等待健康检查 →
记录部署元数据 → 注册 PATH。

> Release 必须同时包含 CLI
> 二进制、校验文件与两个部署文件；缺少资产时**明确报错**， 不会混用不同版本。

> **运行时依赖（重要）**：二进制是**动态链接 glibc** 的，因此需要 glibc 系统
> （Debian / Ubuntu / RHEL / CentOS 等）。**Alpine 等 musl 发行版不能运行**
> （实测报 `not found`）——若目标主机是 Alpine，请在宿主机或 glibc 容器内执行。

## 日常运维

```bash
noj-cli check                  # 配置与依赖校验（只读）
noj-cli verify                 # check + 镜像签名验证
noj-cli config check           # 只做本地配置校验
noj-cli status                 # 状态（含 compose ps 表）
noj-cli logs core --follow     # 日志（着色契约 + 实时跟随）
noj-cli start | stop | restart # 启停（stop 不删数据卷）
noj-cli update                 # 按 .env.prod 的版本升级（升级前自动备份）
noj-cli update --latest        # 升级到最新稳定 Release（已是最新则 no-op）
noj-cli backup create          # 创建 .nojbackup 单文件快照（整包加密）
noj-cli backup verify <快照> --deep
noj-cli backup list | prune    # prune 默认 dry-run，--confirm 才真正删除
noj-cli backup restore <快照> --dry-run
noj-cli backup drill <快照>    # 隔离环境真实恢复演练（分钟级、需 Docker）
noj-cli backup schedule install --schedule '15 2 * * *'
noj-cli uninstall              # 保留数据卷、配置与备份
noj-cli uninstall --all --yes  # 连数据卷与安装目录一起删除（需确认）
```

`upgrade` 是 `update` 的别名。升级序列为：同步部署文件 → **备份** → 拉取镜像 →
等待健康检查 → 记录元数据；任一阶段失败即中止且不宣称成功。

**备份是 `.nojbackup` 单文件**（tar.zst + 整包 GPG AES-256，manifest 标
`payload_layout=prod-raw`），同级 `.sha256` 为校验文件。包内含 `postgres.dump`
（原始二进制）、`redis.rdb`、`minio/` 与加密后的 `.env.prod`。

`backup drill` 会起**独立 Compose 项目**（默认 `noj-drill`）、独立子网，且
**不映射宿主机端口**；RPO/RTO 超限视为演练失败（退出码 1），资源不足为 2。

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
```

## 题目包管理

```bash
noj-cli problem init <slug> [--type P|U] [--difficulty easy|medium|hard]
noj-cli problem lint <目录>
noj-cli problem pack <目录> --out <目录>
```

`problem init` 在 TTY 下进入交互引导（含校验与回退，输入 `:b` 退回上一步）； 非
TTY 或 `--no-interactive` 需显式给出参数。

## 开发与验证

```bash
cd noj-cli
deno task check           # fmt + lint + 类型检查
deno task test            # 全部 TS 测试
deno task test:production # 生产侧（prod/）+ 弃用闸门测试
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
  - `cli.ts`：上述实现到 CLI 的接线层
- `src/core/`：配置 schema、`.env.prod` 原子读写、状态机
- `src/output/`：`--json` 通道与表格/状态符号渲染
- `src/problem/`：题目包 init/lint/pack
- `src/runtime/`：命令执行、二进制下载、日志文件
- `src/util/`：参数、颜色、随机密钥、文件工具

## 过渡期说明

`scripts/deploy/deploy.sh` 与 `restore-drill.sh`
仍在仓库中，但**已废弃**：每次执行 会打印警告并要求输入 `y` 确认（自动化可用
`NOJ_ACCEPT_DEPRECATED=1` 跳过；非 TTY
且未设置该变量时**明确报错**而非挂起）。请改用
`noj-cli`；这两个脚本将在后续版本删除。
