# Agent Note: 独立 Judge 部署的共享 socket 拒绝与宿主 daemon 边界

Status: implemented

## Problem

`judge-install.sh`（951 行）部署**独立 Judge Worker**：一个连接 noj-core 的 Redis
队列、用专用 rootless Docker socket 起评测容器的服务。它有两类必须保住的约束，
而两者在 bash 里都只是**运行时检查**（`fail` 之后进程退出），无法被静态断言：

### 1. 共享 Docker socket 是容器逃逸级别的权限提升

`JUDGE_DOCKER_SOCKET` 不得是 `/var/run/docker.sock` 或 `/run/docker.sock`。这两个
socket 是**应用宿主机**的 daemon：挂进 Judge 容器后，**题目作者提供的** evaluator /
solution 镜像就能创建、删除、`exec` 宿主机上的**任意容器**——包括 noj-core、数据库，
以及其他租户的服务。

关键在于它的**触发条件是正常使用功能**：选手提交一份代码，评测容器在挂载的
socket 上发一个 `POST /containers/create`，就完成了提升。不需要攻击者做任何"异常"
操作，因此这条约束不能只写在文档里。

还有一个更隐蔽的变体：即使 `JUDGE_DOCKER_SOCKET` 配对了，
`JUDGE_DOCKER_HOST` 若写成默认的 `unix:///var/run/docker.sock`，容器内的 Judge
就会去连宿主的 daemon——**约束被绕过，而配置看起来完全正常**。

### 2. 自动安装 Docker daemon 与评测隔离互相矛盾

该工具**不安装、不替换、不配置**宿主 Docker daemon。这不是"暂时没做"：自动安装
daemon 需要一个拥有 root 的安装器，而那正是评测隔离要防的东西。同样地，服务器面板
（宝塔）只做**探测 + 提示**，不调用其 API。

## Decision

新增 `noj-cli/src/prod/judge/`，三个模块分层，两条约束都变成**可断言**的性质：

1. **`config.ts`：`assertDedicatedSocket` 做三层判定**，缺一不可：
   - 字面比较（bash `:699-701` 的两个已知路径）；
   - **realpath 归一**（`/var/run` 常是 `/run` 的符号链接；`//run/docker.sock`、
     `/run/./docker.sock` 这类等价形式只比字面等于给绕过留门）；
   - 绝对路径且不含 `:`（含冒号意味着写成了 TCP endpoint）。

   **拒绝发生在任何配置写入之前**：`writeJudgeEnv` 在 `writeEnvFileAtomic` 之前
   调用它，因此拒绝时**零文件残留**（测试直接断言配置文件不存在）。
   另外单独校验 `JUDGE_DOCKER_HOST` 必须等于容器内专用 endpoint
   `unix:///run/noj-judge/docker.sock`（`assertJudgeDockerHost`），堵住上面那个
   "配置看起来正常"的变体。

2. **`FORBIDDEN_HOST_COMMANDS` + `findForbiddenHostCalls`**：把"绝不碰宿主 daemon"
   变成测试可断言的性质（`systemctl`/`apt`/`yum`/`dockerd`/`service` 等），
   而不是靠"读代码相信它"。测试走一遍全部动作后断言该清单为空。
   清单本身也断言非空——避免"断言空转"这种假绿。

3. **渲染是纯函数**（`compose.ts:renderJudgeCompose`）：bash 用 heredoc 生成 YAML，
   安全选项内联在文本里，要验证只能起容器或逐行 diff。做成 `(env) => string` 后，
   `socket :ro`、`cap_drop: ALL`、`no-new-privileges:true`、`read_only` + `tmpfs`、
   非 root user、**无 `ports:`** 这些属性都可以用字符串断言直接锁住，且测试无需
   docker。渲染前**再校验一次** socket——防线不依赖调用方的纪律。

4. **`status` 脱敏用白名单而非黑名单**：`REDIS_URL` 里嵌着口令，而 `status` 的输出
   常被贴进 issue / 工单 / 聊天窗口。白名单（只列显式允许展示的键）优于黑名单
   （"排除含 password 的键"）——后者会随新键悄悄漏掉，例如
   `NOJ_LLM_SERVICE_TOKEN` 里并没有 "password" 字样。URL 类值再经 `redactUrl` 兜一层。

5. **Redis 回退路径的口令经 `--env-file` 而非 argv**（bash `:739-747` 正是如此）：
   argv 会出现在 `ps` 输出里，等于把 Redis 口令广播给同机所有用户。
   错误信息也只含主机名（`redisHostOf` 逐条剥掉协议/认证段/路径/端口）。

6. **"显式改版本"与"首装写什么"是两个字段**（`updateVersion` vs `values`）：
   `install` **绝不覆盖既有配置**（bash `:517-523`）。混在一个字段里的话，任何把
   `NOJ_VERSION` 放进 `values` 的调用（例如复用一份基线配置对象）都会静默覆盖用户
   既有版本。这个缺口是实现过程中被测试抓出来的。

## Alternatives considered

- **只做字面比较（照抄 bash 的两个 `case` 分支）**：`//run/docker.sock` 与符号链接
  都能绕过。符号链接那条尤其现实——运维常把 socket 软链到"更整洁"的路径。
- **把 socket 校验放在写配置之后**：那会留下一个含共享 socket 的配置文件，即使随后
  报错也要靠人工清理。顺序反过来才能保证"拒绝 ⇒ 零副作用"。
- **黑名单脱敏（排除含 `password`/`secret` 的键）**：会漏掉命名不含这些词的敏感键。
  白名单的代价是新增展示项要显式加进去——这个代价是**想要的**。
- **把 `checkStandaloneJudgeSocket` 也叫 `checkJudgeSocket`**：`prod/config.ts` 已有
  同名导出（校验生产 compose 里的 judge socket 挂载），同名会让包入口再导出撞名。
  加 `Standalone` 前缀显式区分并注明——撞名本身是双模态遗留问题的表征，不该靠
  "少导出一个"掩盖。
- **`stop` 用 `compose down`**：`down` 删容器与网络（`-v` 还删卷）。停止评测服务
  不该丢掉缓存卷内容；`stop` 完全够用。测试断言 stop 路径既无 `down` 也无 `-v`。
- **自动选最新版本升级**：与 T16 的取舍一致——自动选版需要网络查询与可信源，
  属于生产侧 `update --latest` 的职责。judge 的 `upgrade` 用配置里的 `NOJ_VERSION`。

## Consequences

- **36 个用例**，全部注入 runner/探针/时间，**不起容器、不碰真实 Docker socket**。
- **共享 socket 的拒绝有完整证据链**：字面路径、等价写法、realpath 归一三条路径
  都被拒；`install` 路径上还断言"零 compose 调用 + 配置文件不存在"。
- **"不碰宿主 daemon"可回归**：任何新增的 `systemctl`/`apt`/`dockerd` 调用都会让
  对应断言转红，而不是静默通过 review。
- **`--dry-run` 的零副作用可断言**：收敛为一个显式分支后，"零 runner 调用、
  零文件写入"是直接断言的性质（bash 里是散落各处的 `((DRY_RUN)) && return 0`）。
- **socket 探针必须注入**：CI 无法建真实 Unix socket 与 GID，故
  `probeSocketGid`/`probeSocketMode`/`probeIsSocket`/`probeReadWritable` 四个探针
  可替换。字段名刻意不用 `socketGid`——那在本模块里已经是**配置值**（字符串），
  撞名会让类型系统无法区分"要写入的值"与"要读取的探针"（这是编译期就暴露的问题，
  已通过重命名解决）。
- **`judge-install.sh` 仍在**（T24 删除）：`cli.ts` 目前仍把 judge 相关命令路由到
  脚本；本次交付的是可注入的原生实现与其结果形状，命令面接线随 T24 落地。
- **不做的事有明确清单**：不安装/配置宿主 daemon、不调宝塔 API、不改 `noj-judge`
  自身的运行时代码、不实现 systemd timer。
