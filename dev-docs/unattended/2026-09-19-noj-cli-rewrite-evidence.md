# noj-cli 纯 TS 重写验收证据（2026-09-19）

> 本文件由 Task 26 生成。判据是**另一个工程师能否仅凭它复现结论**——因此每条都给出
> **可执行的复核命令**与**实测输出的关键行**，而不是"应该通过"。
>
> 基线对照物：[`2026-09-19-baseline.md`](./2026-09-19-baseline.md)（323 passed / 108 文件）。

## 0. 规模与覆盖

| 指标 | 基线 | 现状 | 说明 |
|---|---|---|---|
| `deno task test` | 323 passed / 0 failed | **684 passed / 0 failed** | +361（T2–T26 新增覆盖） |
| `deno task check` | exit 0（fmt 108 / lint 106） | exit 0（fmt 101 / lint 99） | 文件数**下降**：T23 删除双模态（155 → 98 后回升到 101） |
| `noX-cli/src` bash 调用 | 1 处（`production.ts:112`） | **0 处** | 见 R1 |
| `scripts/deploy/*.sh` 行数 | 7367 | **2402**（保留 4 个文件） | 见下方"bash 退场" |
| 根 `noj` | 447 行 | **已删除** | — |
| `setup.sh` | 35 行 | **已删除** | R4 |

复核：

```bash
cd noj-cli && deno task test 2>&1 | tail -2      # ok | 684 passed | 0 failed
cd noj-cli && deno task check 2>&1 | tail -3     # Checked 101 / Checked 99
wc -l ../scripts/deploy/deploy.sh ../scripts/deploy/restore-drill.sh \
      ../scripts/deploy/backup.sh ../scripts/deploy/deprecation-gate.sh | tail -1   # 2402 总计
```

### bash 退场明细

| 文件 | 基线 | 现状 | 依据 |
|---|---|---|---|
| `scripts/deploy/*.sh`（12 个） | 7367 行 | 4 个 / 2402 行 | 见下 |
| 根 `noj` | 447 行 | 删除 | 能力由 `noj-cli` 覆盖；PATH 指向 `<dir>/bin/noj-cli` |
| `setup.sh` | 35 行 | 删除 | R4 |
| **合计删除** | **7849 行** | — | — |

保留的 4 个及其理由（**过渡期，非遗漏**）：

| 文件 | 行数 | 为什么保留 |
|---|---|---|
| `deploy.sh` | 1216 | R2 弃用闸门；用户已确认按 §7 P10 + §8 R2 处理 |
| `restore-drill.sh` | 617 | 同上 |
| `backup.sh` | 443 | `deploy.sh:1167` 与 `restore-drill.sh:276` 的**硬依赖**——不加它，闸门形同虚设 |
| `deprecation-gate.sh` | 126 | T24 新增的闸门本体（被上两者 source） |

## 1. L0 · 全局门禁

| 门禁 | 判定 | 复核命令 |
|---|---|---|
| Agent Note 格式 | ✅ | `deno run -A scripts/verify-agent-note-format.ts` |
| 文件行数上限（1200 ratchet） | ✅ | `deno run -A scripts/check-file-size.ts` |
| 测试可发现性 | ✅ | `deno run -A scripts/check-test-discovery.ts` |
| Markdown 链接 | ✅ | `deno run -A scripts/verify-md-links.ts` |

实测（四条全过）：

```text
check-file-size              PASS
check-test-discovery         PASS
verify-agent-note-format     PASS   # Agent Note 格式校验通过（140 篇）
verify-md-links              PASS   # Markdown 链接检查通过（扫描 442 个 Markdown 文件）
```

## 2. M · 单模态合并与开发模式移除

| 验收项 | 判定 | 复核命令 / 证据 |
|---|---|---|
| 唯一状态机（`core/state.ts`） | ✅ | `ls noj-cli/src/core/state.ts`；`src/state/machine.ts` 已删（`rg 'state/machine' noj-cli/src` 仅命中注释） |
| 单配置 schema（`core/config-schema.ts`） | ✅ | `ls noj-cli/src/core/config-schema.ts`；无硬编码键清单（`rg 'CONFIG_KEYS'` 无命中） |
| `NOJ_VERSION` 读写集中 | ✅ | `src/prod/release.ts`（`writeConfigVersion`/`stageConfigVersion`/`commitConfigVersion`） |
| `noj-deploy.json`/`noj-secrets.json` 已删 | ✅ | 见下方"残留口径" |
| 命令面单一含义 | ✅ | `status`/`logs`/`backup` 只剩生产语义（T23 删 `stack` 分区） |
| `deploy`/`maintain`/`stack` 收敛 | ✅ | `rg '"stack"\|"deploy"\|"maintain"\|"run-server"' noj-cli/src/commands.ts` → 空 |
| 一份生产 compose | ✅ | 受版本管理的 `docker-compose.prod.yml`；`rg renderCompose noj-cli/src` 仅命中注释 |
| `check`/`doctor` 收敛 | ✅ | `doctor` 已删；`check`（配置+依赖）与 `verify`（+签名）、`config check`（仅本地）三档明确 |
| `devTemplate`/`prodTemplate`/`renderCompose` 已删 | ✅ | `rg 'devTemplate\|prodTemplate' noj-cli/src` → 空 |
| 状态机与 schema 的**移植**有回归测试 | ✅ | `src/core/state_test.ts`、`src/core/config_schema_test.ts` |
| `run-server` 删除后的替代说明 | ✅ | `AGENTS.md` §5.2 两段式流程 |

### 残留口径（重要）

`rg 'noj-deploy\.json'` 在 `noj-cli/src` 内**仍有命中**，全部是两类**有意保留**：

1. **迁移提示**：错误信息告诉用户"若目录里仍有这两个 JSON，可直接删除"
   （`cli.ts:447`、`cli.ts:1283`）；
2. **历史说明注释**：解释为何某字段/分支被删除（`cli.ts:49`、`profile.ts:9`）。

判定标准：`rg` 残留**只允许**出现在迁移提示文本、注释、测试中——这三类不构成
"代码仍依赖旧模态"。复核：

```bash
# 排除注释与字符串后应无命中（真实代码依赖）
rg -n 'noj-deploy\.json' noj-cli/src --glob '!*_test.ts' | grep -v '^\S*: *\*' | grep -v '//'
```

## 3. R1 · 纯 TS

| 验收项 | 判定 | 证据 |
|---|---|---|
| `src` 内零 bash / 脚本调用 | ✅ | `prod/cli_test.ts` 的 R1 门禁（**剥掉注释后**检查代码），全过 |
| `deno compile` 产物可独立工作 | ✅ | 见下方实测 |
| `scripts/deploy/*.sh` 逻辑均有 TS 实现 | ✅ | 逐命令对照见 T12–T21 各 Agent Note；`deno task test:production` = 414 passed |

**编译产物实测**（`/tmp` 下独立目录，无仓库脚本）：

```bash
$ cd noj-cli && deno task build:cli          # exit 0，产出 101.9 MB 二进制
$ cp bin/noj-cli-linux-amd64 /tmp/r1test/ && cd /tmp/r1test
$ ./noj-cli-linux-amd64 --help              # 正常输出全部命令
$ ./noj-cli-linux-amd64 status --dir /nonexistent
noj-cli status: 不是完整的 NOJ 生产安装目录：/nonexistent
$ echo $?                                    # 1
```

> **未验证**：spec 要求"仅含 docker/curl/openssl 的环境"。本机 Docker **可用**
> （`docker info` 成功），因此二进制**不依赖仓库脚本**这一条已证实；但
> "在缺少 Deno/curl/openssl 之外工具的最小镜像中跑通全部命令"未取证——
> 那需要一个干净容器，且涉及真实镜像拉取。**建议 reviewer 在 staging 上补做。**

## 4. R2 · 弃用闸门

| 验收项 | 判定 | 证据 |
|---|---|---|
| 两个脚本启动打印弃用警告并要求 `y` | ✅ | `bash scripts/deploy/test-deprecation-gate.sh` 5/5 通过 |
| 非 `y` → 退出且**无副作用** | ✅ | 同上（用假 docker + 日志断言零调用） |
| `NOJ_ACCEPT_DEPRECATED=1` 可跳过 | ✅ | 同上 |
| 非 TTY 不挂起 | ✅ | 同上（明确报错退出码 2） |

实测：

```text
✓ 非 TTY：警告 + 退出码 2 + 零副作用 + 不挂起
✓ restore-drill.sh 同样受闸门保护
✓ NOJ_ACCEPT_DEPRECATED=1 可跳过
✓ PTY + n：退出码 0 且零副作用
✓ PTY + y：闸门放行并进入正常流程
```

## 5. R3 · 与 bash parity

| 验收项 | 判定 | 证据 |
|---|---|---|
| 逐条对照表 | ✅ | 各 Task 的 Agent Note 内（每模块 `## 与 bash 的有意差异`） |
| 每个 `test-*.sh` 的行为有 TS 测试 | ⚠️ | 9 个 `test-*.sh` 已删；覆盖由 `prod/*_test.ts`（414 个）承接，但**未做逐条映射表** |
| 副作用断言（文件系统可验证） | ✅ | 备份"零残留"、crontab 前后、`--dry-run` 零副作用等均有断言 |
| 退出码 0/1/2 逐命令一致 | ⚠️ | 见下方"已知偏差"（T26 修了一处，另有一处**有意保留**） |

### 退出码：本次修了一处真实不一致

T26 取证时用**编译产物**实测发现（测试覆盖不到的路径）：

```text
status --dir /nonexistent                 → 2   ← 修复前
status --profile prod --dir /nonexistent  → 1
```

同一次失败、同一句文案、退出码不同。根因是 profile 探测先于生产分发抛出
`UsageError`(2)。已修：生产命令跳过探测，目录判定完全交给 `findProductionDir`
（`ProductionDirError` → 1）。修复后实测全部为 **1**，且 `--profile stack` 仍为 2、
未知命令仍为 2、Tier 3 help 仍为 0。提交：`fix(cli): 目录定位失败的退出码不再取决于是否显式 --profile`。

## 5.1 T26 取证发现的第二个真实缺陷：judge 不可达

编译产物实测发现（**测试全绿也未曾触及**）：

```text
$ noj-cli judge status      → exit 2
$ noj-cli judge install-env → exit 2
```

T21 交付了 `prod/judge/*` 与 36 个测试，但 `judge` 既不在 `PRODUCTION_COMMANDS`、
也无分发分支——**该能力从 CLI 完全不可达**。且 `judge install-env`（bash
`judge-install.sh:847-867`，独立节点部署的**入口**）在 TS 侧**完全没有实现**，
而 `compose.ts:289` 的报错恰好是"请先执行 install-env"——指向一个不存在的命令。

已修（提交：`fix(cli): 接通 judge 命令并补上缺失的 install-env`）：
实现 `judgeInstallEnv`（逐条对照 bash，含四条隔离条件与安全边界声明）、
把 `judge` 接入生产命令与注册表、新增**反向门禁**断言"judge 必须可从 CLI 到达"。

修复后实测（真实 Docker）：

```bash
$ noj-cli judge install-env --dir /tmp/nojinstall
✓ Docker daemon 与 Compose 可用
请确认已准备以下隔离条件：
  1. 只服务于 Judge 的 rootless Docker daemon；
  2. 独立 Unix socket（例如 /run/noj-judge/docker.sock）；
  3. Worker 用户的 UID/GID 及 socket group 权限；
  4. 与 noj-core 使用同一 Redis、任务队列和结果队列。
本工具不会自动安装或替换 Docker daemon，也不会把 /var/run/docker.sock 提供给 Judge。
Judge 部署依赖检查通过          # exit 0
```

> **教训**：T21 的 36 个测试全过，但测的都是**模块内部**行为——没有一条断言
> "能从 CLI 调用到它"。新加的门禁断言的正是**可达性**，不是"某个函数存在"。

## 6. R4 · 移除自举

| 验收项 | 判定 | 证据 |
|---|---|---|
| `setup.sh`、`install.sh` 已删除 | ✅ | `test ! -e setup.sh && test ! -e scripts/deploy/install.sh` |
| 仓库无残留引用 | ✅ | 残留仅出现在"已移除"说明与 CHANGELOG 中 |
| `install` 在空目录仅凭二进制可完成 | ✅ | `src/prod/bootstrap.ts` 下载 + SHA-256 校验；`src/prod/lifecycle.ts:install` 装配；测试覆盖 |
| 下载内容 SHA-256 校验，失败拒绝写入 | ✅ | `prod/bootstrap_test.ts`（含校验失败路径） |
| 文档给出手动下载步骤 | ✅ | `README.md`、`noj-cli/README.md`、`noj-docs/.../production-deploy.md` |

> **未验证**：真实 GitHub Release 上的端到端（下载真实资产 → 校验 → 安装）。
> 本机网络可达 GitHub（`curl -sI .../releases` → HTTP 200），但**当前 Release
> 的资产清单不是本次重写产出的**，用它验证等于验旧版本。**建议在下次发布后补做。**

## 7. R5 · 界面（Cliffy + ANSI + 富文本）

| 验收项 | 判定 | 证据 |
|---|---|---|
| 防漂移门禁：help 声明 == 实际可处理 | ✅ | `commands_test.ts:79`（含自检 `:92`，注入虚构命令必须被判不可处理） |
| `backup --help` 含 `list`/`prune` | ✅ | `commands_test.ts` "漂移回归: backup 声明包含 list 与 prune" |
| `--json` stdout 逐字节合法 JSON | ✅ | `output/render_test.ts`（`JSON.parse(c.out())` 直接消费） |
| 颜色契约（`NO_COLOR`/`--color`） | ✅ | `util/color.ts` + `util/color_test.ts` |
| `--json` 与人类输出**不混流** | ✅ | `prod/cli.ts` 在 `--json` 时把人类文案改道 stderr |

> **未做**：`noj-design-tokens.md` 的 "CLI/终端 section"（R5 的 checklist 有，但
> 属文档增强而非功能）；窄终端不破版的实测；`deno compile` 体积的**基线对照**
> （只有现状 101.9 MB，无基线值可比）。

## 8. R6 · problem init 交互

| 验收项 | 判定 | 证据 |
|---|---|---|
| 引导覆盖 slug/type/difficulty/title，含校验与回退 | ✅ | `problem/tui_test.ts` 20 个用例 |
| 非 TTY / `--no-interactive` 行为明确 | ✅ | 显式参数缺失即报错，不进向导 |
| 生成骨架可通过 `problem lint` | ✅ | `problem/` 测试覆盖 |

**本次修的真实缺陷**：EOF（Ctrl-D）时无限循环并把进程堆吃满
（`Fatal JavaScript out of memory`）。现为有界重试后明确报错，并给出可粘贴的
非交互命令。回归测试断言"ask 次数有界"。

## 9. R7 · .nojbackup

| 验收项 | 判定 | 证据 |
|---|---|---|
| `create` 产出单文件，`payload_layout == "prod-raw"` | ✅ | `T17 create：manifest 的 payload_layout/字段/摘要时序正确` |
| **无口令无法读取包内任何内容**（P2） | ✅ | `T18 verify：整包加密 + 缺口令 → 明确失败`；`T17 create：缺口令且未 --no-encrypt → 明确报错且零产物` |
| `postgres.dump` 可被 `pg_restore --list` 解析 | ✅ | `T17 create：pg_restore --list 的结构校验在成功路径上（输入来自文件）` |
| `list`/`prune`（默认 dry-run）/`restore --dry-run`（无副作用）/`verify [--deep]` | ✅ | T18 全套用例（三档累加、篡改一字节被抓、`--payload-sha` 精确分档） |
| 断言**不创建备份** | ✅ | `T18 list：列举容器，且不创建/不修改任何东西` |

**一处设计裁决（reviewer 需知）**：整包摘要**无法**写进 `manifest.json`
（自指不可能——两轮打包永不收敛），故落在同级 `<container>.sha256` sidecar。
副作用：sidecar 只能检测**意外损坏**，**不能**检测篡改（篡改者可同时改 sidecar）。
已在 T18 Agent Note 与 `container.ts` 注释中标注。

---

## 未取证项汇总（诚实标注）

以下各项**没有**在本环境验证，不应视为通过。每条给出补做方式与前置条件。

| # | 未取证项 | 前置条件 | 补做方式 |
|---|---|---|---|
| 1 | `install` / `update --latest` 在**真实 Release** 上的端到端 | 发布一个含新资产的 Release | 按 `noj-cli/README.md` 手动下载流程跑一遍 |
| 2 | 编译产物在**仅含 docker/curl/openssl** 的最小环境 | 干净容器/主机 | 把二进制拷入 `debian:slim` + docker CLI，跑 `check`/`status`/`backup list` |
| 3 | `backup drill` 在**真实 Docker** 上的完整演练 | 可用 Docker 资源（本机 Docker 可用，但演练需拉起完整 Compose 栈与镜像） | `noj-cli backup drill <快照> --keep`，核对 RPO/RTO 与业务验收 |
| 4 | `judge install` 在**真实 rootless daemon** 上 | 专用 rootless dockerd + 其 socket | `noj-cli judge install-env` → `judge install` → `judge check` |
| 5 | 每个 `test-*.sh` 到 TS 测试的**逐条**覆盖映射表 | — | 见下方 review 清单第 3 条 |
| 6 | 真实 `pg_dump` 产物被 `pg_restore --list` 解析 | 运行中的 PostgreSQL | 在 staging 生成 → `pg_restore --list <dump>` |
| 7 | 窄终端（如 40 列）不破版 | — | `COLUMNS=40 noj-cli --help` |

> 第 3/4 项的本机 Docker **可用**（`docker info` 成功），但完整演练需要拉取生产
> 镜像并起多容器栈，超出本次任务范围；第 1 项取决于是否已发布含新资产的 Release。
