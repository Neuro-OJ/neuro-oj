# Agent Note: AI 出题 Skill 随 noj-cli 分发

Status: implemented

## Problem

P0-2「出题提效」需要一份 AI 出题 Skill，让 AI 编码助手按「选题型 →
`init --template` → 评测脚本 → 参考解答 → `problem test` → `lint` →
`pack`/`push`」的固定流程出题，并覆盖分数刻度、隐藏用例泄露、资源限制、LLM
调用预算等常见坑，且明确禁止把真实题库内容放进示例。

仓库里没有可沿用的 skill 存放约定：`.agents/skills/` 原先放的是第三方通用
skill， 已在 #385 作为「AI 工具配置产物」整体清理，AGENTS.md 也要求不提交 AI
工具配置。
更关键的是，出题人通常在独立的题目仓库或任意目录里出题，放在平台主仓库里的 skill
在那里根本不会被助手加载。

## Decision

1. **Skill 是产品内容，随 noj-cli 分发**：事实源放在
   `noj-cli/skills/noj-problem-setter/`（`SKILL.md` +
   `references/problem-types.md`）， 不重新引入主仓库的 `.agents/skills/` 目录。
2. **嵌入单二进制**：沿用 B 的做法，`noj-cli/src/problem/gen-skill.ts`
   把目录生成为 纯数据模块 `skill.generated.ts`；复用
   `noj-core/scripts/gen-problem-templates.ts` 导出的 `readTextTree` /
   `formatTs`，不再写第二份目录读取与格式化逻辑。 `--check`
   进入仓库门禁（`gate-list.ts`）。
3. **`noj-cli problem skill [dir]`**：把 Skill 写到目标目录的
   `.agents/skills/noj-problem-setter/` 与 `.claude/skills/noj-problem-setter/`
   两处（实体文件而非软链接，兼容 Windows
   与同步工具）。内容一致时报「已是最新」； 已存在且不同则不覆盖、退出码
   1，`--force` 先删除旧目录再整体写入，避免残留过期 文件。
4. **内容以仓库现状为准**：流程、命令、lint 规则名、SDK 异常类与平台上限都取自
   模板、`lint.ts` 与文档站；Skill 里不放任何具体题目，只引用五个合成模板。
5. **单测锁定契约**：嵌入一致、frontmatter 的 `name`
   与目录名一致、覆盖五个模板与
   完整流程命令、包含四类常见坑与「不要搬运真实题库内容」、`references/` 引用
   都已嵌入；安装幂等、冲突与 `--force` 行为、退出码。

6. **安装安全（复审修正）**：写入/删除前对 `.agents`、`skills`、Skill 目录逐级
   `lstat`，任何一级是符号链接即拒绝，两处都不写；新内容先写进同级暂存目录，再把
   旧目录挪作备份、整体替换，替换失败时还原，避免 `--force`
   中途失败留下半残目录。 `--force` 只允许用于
   `problem skill`，其他子命令以用法错误拒绝。
7. **不污染题目包**：Skill 可能装在题目目录里，`problem pack`（及共用规则的本地
   支持包）与 core `noj problems pack` 都排除根级 `.agents/`、`.claude/`。
8. **Skill 内容边界（复审修正）**：默认流程在本地 `pack` 处结束，`push` 只在用户
   明确授权并给出目标域后执行；评测日志会返回给选手，隐藏用例只打印 ID / 状态 /
   错误类型；「template.py 保持未实现」只针对选手可编辑的代码骨架，`ui` 题的脚本
   模板必须完整可运行；预测题公开数据一律走外部 HTTPS 链接。

## Alternatives considered

- **主仓库 `.agents/skills/` + `.claude/skills` 软链**：改动最小，但与 #385
  的清理
  方向相反，且只有在平台仓库里工作时才会被加载，覆盖不到真正的出题场景，否决。
- **仅写成文档站页面让出题人自行复制**：无法随 noj-cli
  升级，内容容易与模板漂移， 否决；文档站只保留安装与使用说明。
- **`problem init` 自动写入 Skill**：会在每道题目录里重复放置 Skill，且改变既有
  init 产物，否决；改为显式的 `problem skill` 子命令，在仓库根执行一次即可。

## Consequences

- 修改 Skill 只改 `noj-cli/skills/noj-problem-setter/`，随后运行
  `deno run -A noj-cli/src/problem/gen-skill.ts`；忘记生成会被门禁拦下。
- 新增模板或改动出题流程时，需同步更新 Skill（单测会检查五个模板名与流程命令）。
- noj-cli 升级后，出题人需执行 `noj-cli problem skill --force` 获取新版 Skill。
- 依赖 P0-2 A（`problem test`）与 B（`--template`）。
