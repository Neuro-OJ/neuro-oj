# Agent Note: 题目包管理 CLI（problem init / lint / pack）

Status: implemented

## Problem

出题人维护题目包的体验**分散且脆弱**，与 vite / create-react-app 那种「一条命令起步」相去甚远：

| 能力 | 实现前状态 |
| --- | --- |
| init | 已存在，但只在 noj-core/scripts/ 下、绑定主仓库导入映射 |
| build | 已存在，但**直接调用系统 zip 命令** |
| lint | **完全缺失**（rg lint noj-core/scripts/*.ts 无命中） |
| TUI 引导 | 基座已有（PromptIO + input/confirm/select），但只用于部署配置 |
| 脱离主仓库运行 | **不可能** |

由此产生的真实问题：

1. **打包依赖系统 zip**：Windows、精简容器、CI 均可能没有；脚手架的 README
   甚至教用户先 mkdir -p data/packages 绕开首次失败。
2. **校验只在服务端、只在导入时**：出题人无法在本地知道自己写的 problem.json
   能不能过。
3. **质量规范无人执行**：quality.md 明确「不阻止导入」，模板不得含可满分实现、
   隐藏用例不得泄露等规则**全凭自觉**。
4. **出题人不在主仓库工作**：正式题目源在独立仓库，其打包方式是**手写 bash**，
   每个题各写一份。

第 4 条是核心矛盾：**已有能力存在于错误的位置**。

## Decision

在 noj-cli 新增 noj-cli problem 子命令，同时服务 TUI 引导与自动化两种模式：

    noj-cli problem init <slug> [--type U|P] [--difficulty d] [--no-interactive]
    noj-cli problem lint [dir] [--strict] [--json]
    noj-cli problem pack [dir] [--out build/] [--json]

### 1. 打包改为纯 JS（移除系统 zip 依赖）

用 fflate 在内存中打包（与 noj-core 同版本 ~0.8.3），排除规则与原 zip 实现对齐：
submission*（参考实现）、__pycache__、.git、打包脚本。

**实测往返一致**：problem pack 的产物能被 noj-core 的 parseBundleZip 成功解析；
参考实现与字节码确认被排除。

### 2. 校验逻辑**复制两份**，并用共享 fixture 契约补偿漂移风险

这是 issue 明确接受的取舍（noj-cli 不新增共享包/workspace，保持零外部依赖）。
复制引入**已知漂移风险**——两套实现并存后行为可能分叉（#513 记录的正是同类教训）。
因此同时交付三层补偿：

1. **注释警示**：noj-cli/src/problem/vendor/*.ts 文件头写明「本文件是 noj-core 的
   刻意副本，修改必须同步 <路径>」。
2. **共享 fixture 契约测试**（关键）：fixtures/problem-bundle-manifest.json 放在
   **仓库根**，两侧测试（noj-cli/src/problem/contract_test.ts 与
   noj-core/src/domains/catalog/tests/types/problem-bundle-contract.test.ts）
   都对它断言正例与反例。**任一实现漂移即红灯**，而不是等出题人踩坑。
3. **复制成本的记录**：原文件通过域门面导入，门面同时导出 DB 耦合服务，直接复制会
   解析失败。实测需要 2 处导入修正（../index.ts → 具体文件、
   ../../objective/index.ts → 具体文件）。复制后导入关系**变简单**，不再经过门面。

### 3. SHOULD 层只告警不阻断，--strict 才计入退出码

质量规则（runQualityRules）实现三条可静态判定的规则：

- 模板文件疑似含完整实现（有 def 与 return，且无 TODO/占位）→ 出题人可能把
  参考答案写进了 template.py，选手可直接提交拿满分；
- 隐藏用例内容出现在可见文件中 → 泄题；
- README 仍有未完成待办。

### 4. 退出码沿用 #517 的分层

0 通过 / 1 校验失败 / 2 用法错误。为此把退出码常量抽到 src/exit_codes.ts，
避免 cli.ts 与 problem/command.ts 循环依赖。

### 5. 命令名统一到单数 problem

noj-core 的 problems（复数）收敛为 problem，**保留 problems 作为别名**
（通过 cliffy 的 .alias()），避免破坏既有 deno task problems:build 等脚本。

## Alternatives considered

- **跨目录直连 noj-core 代码**：会让 noj-cli 绑定主仓库的导入映射，无法脱离主仓库运行，
  正是要解决的问题。
- **抽共享 workspace 包**：issue 已决策不做（保持 noj-cli 零外部依赖）；
  且会牵动构建与发布流程。
- **复制但只靠注释警示**：issue 明确指出「若不做共享 fixture 契约测试，
  复制两份实际上等于放弃一致性保证」。因此 fixture 契约是必须项，已实现。
- **lint 做 --fix 自动修复**：issue 明确不做（静态分析难以安全地改写出题人代码）。
- **执行 evaluate.py 验证真评测**：需双容器沙箱，属 noj-judge 职责，明确不做。
- **在线导入**：需 DB 与鉴权，属 noj-core 服务端职责，明确不做。

## Consequences

- 出题人可在**本地、离线**完成 init → lint → pack 全流程，不再依赖系统 zip 或主仓库环境。
- noj-cli 体积可接受：新增闭包体积远小于 Deno 运行时本身（issue 的 spike 已实测）。
- **两份校验实现并存**是真实的维护成本。缓解措施是共享 fixture 契约测试 ——
  漂移会立即红灯，但修复仍需人工同步两处。
- lint 只能做**静态**检查：「evaluator 是否真的不泄露隐藏数据」「模板是否真的拿不到分」
  这类问题静态分析只能给出启发式警告，不能替代真实评测。
- problem 与 problems 双名并存至下一个版本周期。

## 评审修正（2026-09-18，PR #532）

### Problem

评审 P1（Windows）：`problem pack` 用 `dir.split("/")` 取 slug。Windows 上
`resolve` 返回反斜杠路径（`C:\work\problems\a-plus-b`），切分结果是整条路径，
`join(outDir, slug + ".zip")` 因而把盘符与分隔符带入输出路径，产物写入错误位置。
本 PR 的卖点之一正是「Windows 无系统 zip 依赖」，该缺陷直接推翻使用场景。

### Decision

抽出 `bundleSlug(dir)`：同时按 `/` 与 `\` 切分、丢弃空段、取最后一段；
盘符根（`C:`）不构成合法 slug，回退为 `bundle`。回归测试覆盖 Windows、
POSIX、尾随分隔符与盘符根四种输入。

### Alternatives considered

- **`@std/path` 的 `basename` / `win32.basename`**：当前 `@std/path@1` 的
  `win32` 子模块不可用（实测 `basename("C:\\a\\b")` 在 Linux 上返回整条路径），
  `Deno.build.os` 分支又依赖运行时平台；显式双分隔符切分无需平台分支即可在
  任意宿主上对任意写法给出确定结果，且可被单测直接覆盖。

### Consequences

- 任意平台、任意路径写法下产物名都只是题目目录名。
- slug 推导成为纯函数，可脱离文件系统单测。
