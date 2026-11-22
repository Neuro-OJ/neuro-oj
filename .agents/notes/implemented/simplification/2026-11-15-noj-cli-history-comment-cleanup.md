# Agent Note: 清理 noj-cli 的迁移历史注释并拆分超大生命周期测试

Status: implemented

## Problem

noj-cli 由 bash 部署脚本逐步重写而来，源码与测试里沉积了约 1300 处迁移期痕迹：
任务号（T2–T26、R1–R7）、已删除脚本的行号对照（`deploy.sh:684`、
`production.sh:437` 等）、"逐字对照 bash"、"评审发现"标签与 carry-forward 记录。
这些脚本早已删除，注释描述的是过程而非现状，读者需要额外推断哪些约束仍然有效；
部分说法已经过时（如 `restorePlan` 声称"真实恢复本任务不实现"、`schedule.ts` 的
`backupScript` 缺省值描述错误、`start-stop.ts` 末尾残留一段孤立的 update 注释）。
用户可见文案里也带着任务号（演练报告的"T17 起单文件容器……"、升级前备份未注入时的
"备份子系统由 T17–T19 交付"）。另外 `prod/lifecycle_test.ts` 有 5624 行，
`src/cli_test.ts` 存在一个完全重复的测试用例。

## Decision

- 注释只描述现状：删除任务号、脚本行号、bash 对照与评审标签；保留其中仍然成立的
  约束与理由（为什么要这样做、反过来会出什么问题），"评审发现"类分节改为"回归："。
- 测试名去掉 `T\d+:` 前缀；`commands_test` 中名不副实的用例
  （名为"不得声称支持 schedule"、实际断言 schedule 存在）改名。
- 用户可见文案去掉任务号；修正上述过时描述，删除孤立注释并把升级序列说明移到
  `lifecycle/update.ts` 头部。
- `prod/lifecycle_test.ts` 按命令族拆成 8 个测试文件（install / install 守卫 /
  start-stop / logs / uninstall / update / update 失败路径 / update 升级序列），
  被多个文件使用的夹具放在 `prod/lifecycle_fixtures.ts`，单文件专用的夹具留在原处；
  133 个用例全部保留。删除 `cli_test.ts` 中重复的用例。
- 合法用法保留：`cli_test` 的"src 内零 bash / 生产脚本调用"门禁、
  `JUDGE_COMMAND_WHITELIST` 中的 `bash`、"逐字节"等。

## Alternatives considered

- 只做机械替换：大量注释在删掉任务号后语义残缺，需逐段改写成现状描述。
- 把所有夹具都放进共享模块：约 700 行且大部分只服务单个命令族，按使用方就近
  放置更易读。
- 同时清理 `dev-docs/unattended/` 中引用旧测试文件名的文档：那些是带日期的历史
  快照，保持原样。

## Consequences

- 历史引用由约 1300 处降为 0（剩余命中均为上述合法用法），迁移过程仍可从 git 历史
  与 Agent Note 追溯。
- 两处用户可见文案改变：演练报告不再提 T17，升级前备份缺失时提示
  "升级前备份不可用；为安全起见已中止升级"。
- 生命周期测试按命令族定位；新增用例放进对应文件，共享夹具从
  `lifecycle_fixtures.ts` 导入。
