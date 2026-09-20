# noj-cli 纯 TS 重写 · 待人工 review 清单（2026-09-19）

> 本文件由 Task 26 生成。每条给出**可执行的判定动作 + 期望结果 + 不通过意味着什么**，
> 而不是需要 reviewer 自行猜测的判断题。
>
> 配套证据见 [`2026-09-19-noj-cli-rewrite-evidence.md`](./2026-09-19-noj-cli-rewrite-evidence.md)。
> 基线对照见 [`2026-09-19-baseline.md`](./2026-09-19-baseline.md)。

## A. 高优先级：需要判断"裁决是否合理"

这三条**不是**"实现对不对"，而是"在信息不全时的取舍是否可接受"。它们最需要人判断。

### A1. **spec 自相矛盾之一**：`deploy.sh`/`restore-drill.sh` 该删还是该留？

- **背景**：spec 自身矛盾——§3.3 删除清单与 §10「不保留任何 bash 实现路径（R1 是硬要求）」
  要求**删除**；§7 P10 与 §8 R2 验收要求**保留并加弃用闸门**。
- **已作裁决**：**保留 + 闸门**（已与项目所有者确认）。
- **动作**：
  ```bash
  ls scripts/deploy/*.sh
  wc -l scripts/deploy/*.sh
  bash scripts/deploy/test-deprecation-gate.sh
  ```
- **期望**：4 个脚本（`deploy.sh`/`restore-drill.sh`/`backup.sh`/`deprecation-gate.sh`），
  闸门测试 5/5 通过。
- **请判断**：
  1. 保留 3 个可执行脚本（2515 行含闸门）是否可接受？R1 的"硬要求"是否要求**立即**清零？
  2. `backup.sh` 是前两者的硬依赖，**必须**跟着留。是否接受"为了保留闸门而保留被闸门
     保护的依赖"这一逻辑？
  3. 删除时机：下一个 minor 版本删除？还是要求本次就删（则 R2 整条作废）？
- **不通过的后果**：若判定"必须立即删除"，则 R2 验收项全部作废，且
  `scripts/deploy/` 只剩校验脚本——那是与 R1 更一致、但与 §7/§8 冲突的选择。

### A2. **spec 自相矛盾之二**：`about.vue:324` 的多语言说明该不该删？

- **背景**：spec §8 P11 要求"`about.vue:324` 移除多语言暗示"。T25 核对后发现
  **该指控不成立**——原文写的是"更多语言由管理员配置评测镜像后在「管理后台」启用"，
  而这条链路**真实存在**。
- **已作裁决**：**不删**，并在 spec 中划掉该条、附上证据。
- **动作**（逐处确认链路存在）：
  ```bash
  rg -n "judge_images" noj-core/src/shared/db/schema/system.ts
  rg -n "judge-images" noj-core/src/domains/admin/routes/system.ts
  ls noj-ui/pages/admin/judge-images.vue
  rg -n "judgeImages|evaluatorImage" noj-ui/components/editor/CodingProblemEditor.vue | head
  ```
- **期望**：四处都有命中（表 + 接口 + 后台页 + 题目编辑器）。
- **请判断**：认可"该指控不成立"的结论，还是认为措辞仍会让用户误以为**开箱即多语言**、
  因而仍需调整文案？
- **不通过的后果**：若认为措辞需调整，请给出目标文案；改 `about.vue` 属 UI 变更，
  应单独提交（本次未动 UI）。

### A3. `update` 的"升级前必须备份"是否达到设计意图？

- **背景**：T16 把 `UpdateOptions.backup` 设计为**必填注入点**（未注入即明确失败），
  以防"某条路径绕过备份"。T24 接上了真实实现。
- **动作**：
  ```bash
  rg -n "backup" noj-cli/src/prod/lifecycle.ts | rg -n "opts.backup|备份" | head -20
  cd noj-cli && timeout 120 deno test -A src/prod/lifecycle_test.ts 2>&1 | rg -i "备份|backup" | head
  ```
- **期望**：备份失败 → 升级**中止**，且**不**执行 `pull`/`up`。
- **请判断**：
  1. 是否所有升级入口（`update` / `upgrade` / `--latest` / 固定版本）都经过该注入点？
  2. 备份产物的**校验**是否也在中止判据内（只"跑过备份"不等于"备份可用"）？
- **不通过的后果**：存在绕过路径 → 升级可能在不具备可回滚备份时进行，
  属**安全相关缺陷**，应优先修。

## B. 中优先级：需要核对边界与遗漏

### B1. judge 的共享 socket 拒绝是否有遗漏的等价路径？

- **背景**：judge 必须用**专用 rootless socket**；禁止 `/var/run/docker.sock`
  与 `/run/docker.sock`。T21 做了三层判定（字面量 / realpath / 非 TCP）。
- **动作**：
  ```bash
  rg -n "FORBIDDEN|assertDedicatedSocket|realpath|tcp://" noj-cli/src/prod/judge/config.ts | head -20
  cd noj-cli && timeout 120 deno test -A src/prod/judge/ 2>&1 | rg -i "socket|拒绝" | head
  ```
- **期望**：字面量、realpath 等价、`tcp://` 三类都被拒；测试覆盖三类。
- **请判断**：是否存在**未覆盖**的等价写法？例如：
  - 通过 `/proc/self/fd/N` 或绑定挂载的**另一路径**指向同一 inode；
  - `DOCKER_HOST` 指向远程 daemon（`tcp://` 已覆盖，但 `ssh://` 呢？）；
  - socket 位于**符号链接链**中段（realpath 只解析终态）。
- **不通过的后果**：判据可被绕过 → 评测代码获得宿主全部容器的控制权（**高危**）。

### B2. drill 的隔离性在具体实现上是否真实成立？

- **背景**：T19 声明演练用独立 Compose 项目、独立子网，且**不映射宿主机端口**。
- **动作**：
  ```bash
  rg -n "ports|project-name|subnet" noj-cli/src/prod/drill/ | head -20
  cd noj-cli && timeout 120 deno test -A src/prod/drill/ 2>&1 | rg -i "端口|隔离|清理" | head
  ```
- **期望**：覆盖文件不含 `ports:`（或显式清空）；项目名禁止含 `prod`。
- **请判断**：`docker compose` 的 override 语义下，**基础 compose 文件里已有的
  `ports:`** 是否会被 override 真正取消？（`ports: []` 与"不写"语义不同，需核对。）
- **不通过的后果**：演练环境可能与生产**抢端口**，或在共享子网上互相干扰。

### B3. `test-*.sh` 到 TS 测试的覆盖映射是否完整？

- **背景**：R3 要求"每个 `test-*.sh` 覆盖的行为都有 TS 测试（覆盖清单可核对）"。
  9 个 `test-*.sh` 已删除，覆盖由 `prod/*_test.ts`（411 个）承接，但**未做逐条映射表**。
- **动作**：
  ```bash
  git show 3fab63a5:scripts/deploy/test-deploy.sh | rg -n "^test_|^# " | head -30
  # 对照 TS 侧
  cd noj-cli && timeout 120 deno test -A src/prod/lifecycle_test.ts 2>&1 | tail -3
  ```
- **期望**：bash 用例名能一一对应到 TS 用例名或明确标注"有意不覆盖 + 理由"。
- **已补做**（T26 收尾）：产出
  [`2026-09-19-noj-cli-bash-parity-map.md`](./2026-09-19-noj-cli-bash-parity-map.md)，
  从基线提交机器提取全部 **150 条** bash 断言并逐条定位 TS 对应。
- **请判断**：该表的判定是否可信——特别是三处**有意语义反转**
  （drill 快照形态、生产目录特征、备份形态）与"监控/告警属其他模块"的范围划定。
- **不通过的后果**：若某条被判定为"其实未覆盖"，需补测——那正是 parity 的缺口。

### B4. 退出码契约是否还有别的不一致？

- **背景**：T26 用编译产物实测发现 `status --dir /nonexistent` 因 profile 探测
  抢先而返回 **2**（应为 1），已修。**同类问题可能还有**——凡"探测/预检查先于命令
  本体"的路径都有风险。
- **动作**：
  ```bash
  cd noj-cli && deno task build:cli
  B=bin/noj-cli-linux-amd64
  for a in "status --dir /nope" "check --dir /nope" "uninstall --all --yes --dir /nope" \
           "backup create --dir /nope" "backup verify /nope" "logs --dir /nope"; do
    $B $a >/dev/null 2>&1; echo "$a → $?"
  done
  ```
- **期望**：目录类错误一律 **1**；参数/用法错误一律 **2**；未知命令 **2**。
- **请判断**：上表中是否有"应为 1 却给 2"（或反之）的项？
- **不通过的后果**：调用方（脚本/CI）无法据退出码区分"环境不对"与"参数错"，
  自动化编排会误判。

### B5. judge 的接线与 `install-env` 是否完整？（T26 发现后已修，需复核修复质量）

- **背景**：T21 交付 `prod/judge/*`（36 测试）但**未接线**——`judge` 不在
  `PRODUCTION_COMMANDS`、无分发分支，`judge install-env` **完全未实现**。
  测试全绿也没发现，因为它们只测模块内部行为。
- **已修**：实现 `judgeInstallEnv` + 接入注册表/分发 + 新增**可达性门禁**。
- **动作**：
  ```bash
  cd noj-cli && deno task build:cli
  B=bin/noj-cli-linux-amd64
  $B judge --dir /tmp/nojinstall          # 非法/缺子命令 → 2，并列出可选值
  $B judge install-env --dir /tmp/nojinstall   # 真实 Docker：打印指引，exit 0
  rg -n 'name: "judge"' src/commands.ts
  rg -n '"judge"' src/production.ts
  ```
- **期望**：8 个子命令全部可达；`install-env` 打印四条隔离条件 + 安全边界声明。
- **请判断**：
  1. `judge install-env` 的**退出码 1**（daemon 不可连）是否接受？bash
     `judge-install.sh:51-54` 的 `fail()` 也是 1，故按逐命令 parity 取 1——
     但这与 `judge` 模块内"2 = 前置错误"的通用分层不同，是有意的例外。
  2. `judge upgrade` 不接受 `--version`（版本取自配置文件）——是否符合预期？
     bash 侧 `upgrade_worker` 也从环境文件读版本。
  3. 是否还有其他"模块已交付但未接线"的能力？建议用可达性思路再扫一遍。
- **不通过的后果**：能力存在但用户无法使用——T21 的 36 个测试给了虚假的安全感。

## C. 低优先级：文档与呈现

### C1. `ROADMAP.md` 的证据引用是否可核对？

- **动作**：
  ```bash
  rg -n "anti-cheat/similar-submissions" noj-core/src/domains/admin/routes/contest.ts
  rg -n "ranking-snapshots" noj-core/src/domains/admin/routes/contest.ts | head -5
  ```
- **期望**：两处均有命中（T25 断言的行号 `:504` 与 `:569-760`）。
- **请判断**：行号会随代码变动而漂移——是否接受"行号 + 端点"的引用方式，
  还是要求改为只引用端点（更稳）？

### C2. CHANGELOG 的破坏性变更描述是否足以让升级者判断影响？

- **动作**：读 `CHANGELOG.md` 的"破坏性变更"六条，对照自己关心的使用场景。
- **期望**：能回答"我是否需要改操作方式"。
- **请判断**：是否遗漏了对你重要的迁移信息（例如旧备份目录的处理步骤是否够具体）。

### C3. 过渡期文案是否会让用户困惑？

- **背景**：T24 后既有"已移除命令"的迁移提示，又有"已废弃脚本"的闸门警告。
- **动作**：
  ```bash
  cd noj-cli && deno run -A src/cli.ts deploy status 2>&1 | head -5
  cd noj-cli && deno run -A src/cli.ts status --profile stack 2>&1 | head -5
  NOJ_ACCEPT_DEPRECATED=1 bash scripts/deploy/deploy.sh status 2>&1 | head -3
  ```
- **期望**：三条都给出**可粘贴的替代命令**，不出现"请改用 --profile stack"这类
  指向已删模式的提示（T23 修过一处）。
- **请判断**：文案是否清楚区分了"命令已删除"与"脚本已废弃（仍可用）"两种状态。

## D. 已在本轮修复、建议复核 diff 的缺陷

T26 取证过程中发现并**单独提交**的修复（未混入证据文档）：

| # | 缺陷 | 提交 | 复核方式 |
|---|---|---|---|
| 1 | 目录定位失败退出码随 `--profile` 显隐而变（2 vs 1） | `fix(cli): 目录定位失败的退出码不再取决于是否显式 --profile` | 见 B4 的动作 |
| 1b | **judge 从 CLI 完全不可达**，且 `judge install-env` 未实现 | `fix(cli): 接通 judge 命令并补上缺失的 install-env` | 见下方 B5 |

前序 Task 中修复的**真实缺陷**（均有独立提交与回归测试）：

| # | 缺陷 | 发现方式 |
|---|---|---|
| 2 | `problem init` EOF 时无限循环 → OOM 崩溃 | T22 实现时实测 |
| 3 | 定时备份 cron 指向**已删除**的 `backup.sh` → 静默失败 | T24 的 R1 门禁 |
| 4 | `uninstall --all` 因完整性判据含已删脚本而**永久自锁** | T24 的 R1 门禁 |
| 5 | 错误文案指引执行**已删除**的 `backup.sh` | T24 的 R1 门禁 |
| 6 | `manifest.sha256` 自指不可能（两轮打包永不收敛） | T17 实现时实测 |
| 7 | 帮助声称 `backup` 支持 `schedule`（实际不支持/位置不同） | T25 核对 E5 时 |

> 第 3–5 条是**同一次门禁**抓出来的——说明"把验收写成可执行门禁"比"人工核对"更有效。
> 第 3 条若不修，**定时备份会在无人察觉的情况下停止工作**（cron 失败只落日志）。

## E. 建议的 review 顺序

1. **B4 + B1**（退出码一致性、socket 拒绝）——影响自动化与安全，成本低；
2. **A1 + A2**（两处 spec 矛盾裁决）——需要你表态，可能改变交付范围；
3. **A3 + B2**（备份门禁、演练隔离）——安全相关，需读实现；
4. **B3**（parity 映射表）——决定是否要补一份文档；
5. **C1–C3**（文档）——可批量处理。
