# Agent Note: noj-cli profile 分级、stack 合并与 Tier 3 容器包装

Status: implemented

## Problem

noj-cli 在同一二进制、同一份 help、同一层命名空间里承载两套互不相干的部署模式，
用户无法从界面分清该用哪套：

| profile | 调用方式 | 配置 | 受众 |
| --- | --- | --- | --- |
| prod | noj-cli 裸动词 | .env.prod + docker-compose.prod.yml | 部署者/运维 |
| stack | noj-cli 名词 子命令 | noj-deploy.json | 源码开发者 |

同一个词（status/logs/backup）在**两个深度、两套配置**下含义不同，
实测产生 7 条「未找到 noj-deploy.json」的错误路径。此外：

- deploy 与 maintain 的拆分无原则（up 在 deploy，logs 在 maintain）；
- 5 个「检查」类命令职责重叠，其中 verify 与 config check 的差别
  （是否验镜像签名）无法从名字推断；
- 容器管理命令需手写约 150 字符的 compose 长命令，且这类命令有 5+ 个。

## Decision

### 1. 引入 profile，且探测失败必须报错

| profile | 探测条件 |
| --- | --- |
| prod | 目录含 scripts/deploy/production.sh 且 docker-compose.prod.yml |
| stack | 目录（或祖先）含 noj-deploy.json |

优先级：--profile 显式值 > prod 探测 > stack 探测 > 报错。

**关键决策：两者同时命中、或两者都不命中时一律报错，不静默取默认值。**
猜错模式会把命令作用到错误的目标（例如对 JSON 编排目录执行生产备份），
代价远高于让用户显式传一次 --profile。

**--profile 必须真正参与分发**（评审修正）：早先它只做值校验、从不影响路由，
导致「显式生效」与「歧义报错」两条验收在真实 CLI 中不可达。
现在显式给出 profile 时会校验命令与其相容，不相容则报用法错误并给出替代命令。

### 2. stack 合并 deploy + maintain，旧名保留为别名

stack 的部署类子命令走 deploy 分支，运维类走 maintain 分支。
旧名仍可用但打印废弃提示；--help 不打印提示（避免污染帮助输出）。

**委派时必须把子命令置于首位**（评审修正）：早先直接把原始 args 转交，
下游 args[0] 会把 --dir 当成子命令，导致 stack --dir X status 丢失 status。

### 3. Tier 3 容器包装（收益最高项）

把 150 字符的 compose 调用收敛为短命令（db migrate / bootstrap first-admin /
problems build|import / search reindex 等）。实现要点：

- 参数以**数组**构造（非 shell 字符串），从结构上消除注入与转义问题；
- stdin: "inherit" 是硬要求——bootstrap first-admin 需隐藏输入密码；
- 退出码原样透传；
- --dry-run 打印将执行的 compose 命令且不实际执行；
- **CLI 自身的选项在进入容器前被剔除**，否则会被容器内的 noj 当作未知参数。

### 4. 顶层 help 按 Tier / profile 分区

help.ts 是命令清单的唯一事实源；本 issue 把 stack / --profile / Tier 3
写入 help，使新命令可被发现。

## Alternatives considered

- **静默取默认 profile**：会把命令作用到错误目标，比报错危险。
- **保留 deploy/maintain 的现有拆分**：up 与 logs 分属两处，无原则可循。
- **立即删除旧名**：面向用户的破坏性变更；改为别名 + 废弃提示 + 一个版本周期。
- **Tier 3 用 shell 字符串拼接**：引入注入与转义风险；改为参数数组。
- **让 --profile 只做值校验**（初版实现）：验收不可达，已由评审指出并修正。

## Consequences

- 两套模式在界面与语义上清晰分离；探测失败时用户必须显式选择。
- stack 覆盖原 deploy + maintain 的全部能力；旧名以别名继续可用。
- Tier 3 命令不再需要手写 compose 长命令；交互式输入与退出码语义保持一致。
- profile 判定与容器参数构造都是**纯函数**（profile.ts / container.ts），
  可被 deno task test 直接断言。
- 已知限制：--profile 的分发门控基于命令名集合，若新增命令需同步登记；
  未登记的命令在两个 profile 下都放行（保持向后兼容）。

## 评审修正（2026-09-18，PR #527）

### Problem

评审指出探测起点选错，两条 P1 都源于「容器侧参数被当成宿主机安装目录」：

1. Tier 3 只读 `parseDirArg(topRest)`，完全忽略 `--install-dir`；用户按 help
   在任意目录执行 `noj-cli db migrate --install-dir /opt/neuro-oj` 会先收到
   「未能识别 profile」，与 help 宣称的支持自相矛盾。
2. `problems import --dir <包目录>` 的**容器侧** `--dir` 被当作宿主机探测起点；
   题目包位于生产目录之外时，即使 cwd 就是生产安装目录也会报 profile 未识别。

### Decision

先计算容器匹配，再据此选择探测起点：

- 命中 Tier 3 → 只用 `--install-dir`（`--dir` 属于容器内命令，原样透传）；
- 普通命令 → `--dir` 优先，`--install-dir` 作为别名兜底。

回归测试用真实临时生产目录 + `Deno.chdir` 覆盖两条路径。

### Consequences

- Tier 3 的 `--install-dir` 语义与 help 一致，任意目录可用。
- `--dir` 的双语义冲突在**探测阶段**也被尊重，而非只在转发阶段。
3. **`--debug` 未真正剥离**：`extractProfile` 的注释声称同时剥离
   `--profile`/`--debug`，实现却只处理 `--profile`。于是前置
   `noj-cli --debug <command>` 被当成未知顶层命令（返回 2），命令后的
   `--debug` 还会透传到底层脚本/容器。

### Decision（补充）

新增 `extractGlobalFlags`，在解析命令**之前**统一剥离 `--debug`，
并把剥离结果作为布尔值传入 `handleError`；`run()` 交给 `extractProfile`
的也是剥离后的 argv。回归测试覆盖前置/后置两种写法与命令语义不受影响。

### Consequences（补充）

- 全局选项在命令前后均生效，help 声明与行为一致。
- 后续新增全局选项有唯一剥离点。
