# Agent Note: #510 文档漂移治理（含撤销一条不成立的指控）

Status: implemented

## Problem

文档承诺与实现已多方不一致。这些不是"错别字"级别的偏差——**照着文档操作会失败**：

1. **安装方式已不存在**：`README.md`、`noj-cli/README.md`、`deploy/README.md`、
   `noj-docs/.../production-deploy.md`、`scripts/README.md` 都把 `setup.sh` 作为
   首选安装入口，而它（与 `scripts/deploy/install.sh`）已随 T24 删除。
2. **开发流程指向已删除的命令**：`AGENTS.md` §5.2 让开发者执行
   `noj-cli deploy init --mode dev`——该模式已在 T23 删除。
3. **最危险的一类**：`noj-docs/.../judge-workers.md` 让用户
   `curl .../judge-install.sh` 下载并执行一个**已删除的脚本**。照着做会直接 404，
   而这是"独立 Judge 节点部署"的唯一指引。
4. **命令名与文件形态已变**：备份命令、快照形态（目录 → `.nojbackup` 单文件）、
   过渡期脚本的弃用闸门，均未反映在文档中。
5. **ROADMAP 的承诺与实际不符**：既有多语言承诺（未实现），也有已实现却未勾选的项。

## Decision

按 #510 的四类分类处理，**每条先取证再改字**（单纯改字只会把错误从一处搬到另一处）：

| 类 | 处理 | 证据 |
| --- | --- | --- |
| A 已实现未勾选 | 勾选并补**代码位置** | — |
| B 承诺未实现 | **移除承诺** | `ROADMAP.md` 两条多语言条目 |
| C 已实现缺证据 | 补**端点与文件位置** | 防作弊 / 成绩单导出 |
| D 命令名已变 | 改用**新命令** | 五份文档的安装与运维段 |

具体落地：

1. **安装方式**：五份文档统一改为"从 Release 手动下载 `noj-cli-linux-amd64` +
   `.sha256` → 校验 → `install --dir <目录>`"，并说明 `install` 自己拉取部署文件
   并校验 SHA-256（R4）。
2. **两段式开发流程**（`AGENTS.md` §5.2）：`docker compose up -d`（仅基础设施）+
   各模块 `deno task dev`；**显式写出"`deploy init --mode dev` 已不存在"**。
3. **`judge-workers.md`**：改为 `noj-cli judge install-env / install / check /
   status / logs / stop / start / upgrade`，并写明"不再需要下载任何安装脚本"。
4. **过渡期说明**：文档必须说明 `deploy.sh`/`restore-drill.sh` 已废弃、需 `y` 确认、
   `NOJ_ACCEPT_DEPRECATED=1` 可跳过、非 TTY 明确报错。
5. **CHANGELOG**（新建）：破坏性变更排在最前并逐条给出**为什么**——只列"删了什么"
   不足以让人判断自己是否受影响。

## Alternatives considered

- **撤销 spec 关于 `about.vue:324` 的要求（该指控不成立）**：spec §8 P11 要求
  "移除多语言暗示"，但核对后发现原文写的是"更多语言由管理员配置评测镜像后在
  「管理后台」启用"，而这条链路**真实存在**——`judge_images` 表
  （`shared/db/schema/system.ts`）+ 管理端接口（`domains/admin/routes/system.ts`）
  + 后台页面（`noj-ui/pages/admin/judge-images.vue`）+ 题目编辑器按镜像选择运行时
  （`components/editor/CodingProblemEditor.vue:89-96`）。它是**已实现能力的准确
  说明**。已在 spec 中把该条划掉并写明依据——**执行者照做会删掉对用户有用的准确
  说明**，那才是制造漂移。
- **逐条回改 `openspec/changes/`**：#510 明确不校准历史归档。改为在
  `add-noj-cli/tasks.md` 顶部标注 **superseded**，并**只**精确标注 2.1 条与现状的
  冲突（它指引读者操作已删除的脚本）——兼顾"不重写历史"与"不误导读者"。
- **只改字不取证**：第一版我把成绩单导出的端点写成 `domains/contest/routes/`，
  `rg` 在该目录零命中；真实位置在 `domains/admin/routes/contest.ts`。
  另有一条 C 类项的勾选需要先确认实现确实存在（防作弊的相似度端点）。
  不复核就提交等于用新漂移替换旧漂移。
- **建 CHANGELOG 只列删除清单**：升级者需要的是"我是否受影响、该怎么改"，
  而不是一份变更目录。故每条破坏性变更都给出原因与迁移路径。

## Consequences

- **文档可执行性恢复**：残留检查（排除"已删除/已废弃"的说明性文字）零命中；
  `verify-md-links.ts` 通过（442 个 Markdown 文件）——删文件后最容易留下的就是
  指向已删文件的链接。
- **两份 CHANGELOG 级别的信息落地**：`CHANGELOG.md`（面向升级者）与各文档的
  "过渡期说明"（面向操作者）。
- **一处 spec 错误被更正而非执行**：`about.vue` 的多语言说明是准确的，保留；
  spec 中该条已划掉并附证据。这条记录本身也是治理产物——否则下一个人会重新
  提出同一个错误要求。
- **`ROADMAP.md` 的证据是可核对的**：C 类两项都给了**端点 + 文件行号**
  （`admin/routes/contest.ts:504` 与 `:569-760`），而不是"已实现"这样的空断言。
- **历史归档保持不变**：`openspec/changes/` 只有一处 superseded 标注与一处冲突
  行标注，其余历史条目未改（符合 #510 的"不校准历史归档"）。
- **未做的事**：未改 `dev-docs/` 下的设计与审计文档（它们是时点记录）；
  未校 `openspec/changes/` 的其余历史条目。
