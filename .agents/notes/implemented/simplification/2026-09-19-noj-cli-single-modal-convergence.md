# Agent Note: 双模态收敛为单模态（M1–M7）

Status: implemented

## Problem

`noj-cli` 承载两套**互不相干**的部署模式，同一个词在两个深度上含义不同：

| profile | 配置来源 | 受众 | 运行环境 |
| --- | --- | --- | --- |
| `prod` | `.env.prod` + `docker-compose.prod.yml` | 部署者/运维 | 宿主机（无需 Deno） |
| `stack` | `noj-deploy.json` + `noj-secrets.json` | 源码开发者 | 需 Deno |

spec §2.7 的三条证据表明 `stack` 模态**已不再工作且从未被使用**：

1. **从未被使用**：全盘查找 `noj-deploy.json` 仅命中 `/tmp` 与 `~/.cache`
   （测试临时目录）；仓库、文档、CI、e2e **零个真实配置**，`.gitignore` 亦未忽略它。
2. **已损坏**：`devTemplate` 把 `server` 定义为 `method: process` +
   `binary: noj-server`，而该二进制存在于**生产安装目录**，源码目录中不存在；
   `ui` 的 `dev_command: deno task dev` 亦无真实启动实现。
3. **真实开发流程是另一条路径**：`docker compose up -d`（只起基础设施）+
   各模块 `deno task dev`，已在 `AGENTS.md` §5.3 记录。

因此这不是"删掉一个能用的功能"，而是**删掉一套半成品**——留着它会让
M1/M2/M4 的重复以 TS 形式再固化一遍。

## Decision

按 spec §2.6 的 M1–M7 逐条收敛，**先抢救、后删除**（顺序不可颠倒）：

1. **抢救清单（先搬）**：`prod/` 在 T17–T22 之后**仍依赖 6 个旧模块**，因此
   删双模态不是 `rm -rf`：
   - `maintain/backup_index.ts` / `backup_list.ts` → `prod/backup/{index,list}.ts`
     （纯逻辑，与模态无关；**对应测试一并搬**，否则 T18 的 prune 安全默认会
     随删除一起失去覆盖）；
   - `maintain/drill.ts` 的两个校验 → `prod/drill/plan.ts`（T19 已登记的
     carry-forward）；
   - `init/secrets.ts` 的 `randomKey` → `util/random.ts`（只搬它；
     `generateSecrets`/`SecretsConfig` 属于 `noj-secrets.json` 路径）；
   - `init/non_interactive.ts` → `prod/advice.ts`（**文案改写**：原文案指引
     用户"预先手写 noj-deploy.json"，而那个文件已删除）；
   - `config/types.ts` 的 `DeployState` → `core/state.ts`（M1 要求"一套状态机"，
     而状态的**类型**却定义在另一份已删除的配置模态里，是明显的遗留错位）。

2. **命令面收敛（M5）**：删 `stack`/`deploy`/`maintain`/`run-server`/`doctor`。
   旧名走**迁移提示**（`removedCommandNotice`）而非静默失败，返回退出码 2
   （命令不存在是用法错误），并给出**可直接粘贴**的替代命令。
   原 `deprecationNotice` 的措辞是"已合并为 stack，旧名将在后续版本移除"——
   现在旧名确实已移除，继续用"提示"口吻会误导用户以为命令仍可用。

3. **删除实现（M1–M4/M6/M7）**：`deploy/**`、`maintain/**`、`config/**`、
   `init/{templates,wizard,secrets,non_interactive}.ts`、`state/machine.ts`、
   `doctor/**`、`runtime/{process,pidfile}.ts`、`util/find_deploy_dir.ts`。
   共约 6300 行非测试 + 3000 行测试。

4. **profile 收敛**：`PROFILE_NAMES` 只剩 `["prod"]`；删 `STACK_MARKER`/
   `isStackDir` 与"两者同时命中即 ambiguous"分支——只剩一个模式时，
   "猜错模式"的风险不复存在。`CommandContext.deployDir` 同步移除（它由查找
   `noj-deploy.json` 得到）。

5. **残留门禁**：新增 3 个用例断言**行为面**（命令注册表与 help 不含旧名、
   不出现旧分区与旧配置文件名、每个使用的 tier 都有分区标题），而不是依赖
   一次性 `rg`。只靠一次性 grep 无法防止后来者复制粘贴一段旧代码。

6. **顺带接线 T19 的原生 drill**：`backup drill` 原先经 `maintain/drill.ts`
   的 bash 薄包装（R1 违例），改用 `prod/drill/drill.ts` 的原生实现。

## Alternatives considered

- **保留 `stack` 作为别名一个版本周期**：#518 曾采用"先加法后改名 + 别名保留"
  的过渡策略。但过渡的目的已达成（配置真相源统一为 `.env.prod`），继续保留会让
  "`status`/`logs`/`backup` 各有两个含义"的混乱永久化——而那正是 spec §2.3 要
  根治的问题。
- **直接 `rm -rf` 旧模块**：会连带打断已验收的 `prod/` 路径（它仍 import 6 个旧
  模块）。实测会立刻在 `deno check` 上炸出一串 `Cannot find module`。
- **把 `DeployState` 留在 `config/types.ts` 并只保留那一个类型文件**：会让一个
  空的、以"JSON 配置"命名的模块长期存在——"prod 依赖了已删除的模态"这种错觉
  正是本次治理要消除的东西。
- **让 `findDeployDir` 改查 `.env.prod`**：`findProductionDir()` 已经做这件事，
  且更完整（按 `PRODUCTION_MARKERS` 判定 + 检查已安装二进制位置）。留着两个
  做同一件事的函数就是再造一次"同一件事两个入口"。
- **残留检查只用文档约定**：不会被遵守，且失效时无声。门禁化后重新引入旧名会
  立刻转红。

## Consequences

- **单模态**：配置真相源唯一（`.env.prod` + `docker-compose.prod.yml`），
  一套状态机（`core/state.ts`）、一套配置 schema（`core/config-schema.ts`）、
  一条部署路径（`prod/compose.ts`）、一份 compose（受版本管理的
  `docker-compose.prod.yml`）。
- **文件数 155 → 98**；测试 805 → 669（删掉的是已不存在行为的用例）。
- **迁移影响（诚实标注）**：曾用 `deploy init --mode dev` 启动全套进程的开发者
  需改回两段式流程（`docker compose up -d` + 各模块 `deno task dev`）。
  该模式实测未被使用，且新命令的迁移提示直接给出替代命令。
- **R1 仍未完成**：`src/production.ts:112` 仍调用 `bash production.sh` 转发生产
  命令——那是 **T24** 的范围（删 bash + 命令接线）。本任务只收敛模态，
  不动那条转发路径，否则会把"删实现"与"接线"两种风险叠在一次提交里。
- **命令接线仍是转发**：生产命令（`install`/`start`/`stop`/…）目前仍经
  `runProduction` 转发给 bash。它们的原生实现在 T12–T21 已交付，
  接线同样归 T24——T23 只保证"不再有两套模态"。
- **防漂移门禁的锚点已改**：`topLevelDispatchNames()` 靠行首匹配
  `removedCommandNotice` 来界定 `dispatchCommand` 正文。改名必须同步改那个正则，
  否则门禁会以"声明落空"的方式变红（这层保护是有意的）。
