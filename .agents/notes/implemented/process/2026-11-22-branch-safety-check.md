# Agent Note: 提交前的分支安全自检

Status: implemented

## Problem

三类事故的共同点是"本地测试全绿，只有真 CI 或人工复审才发现"：

1. `noj-ui/utils/` 按领域分目录后，`noj-tests/e2e/**` 里 10 处相对引用仍指向旧扁平
   路径，CI 的 E2E Browser 三个分片全部 `TS2307`；
2. 同一个 PR 修好后又断了一次同样的引用；
3. 把旧提交 cherry-pick 到新 `main` 时，`noj-ui/middleware/default-workspace.global.ts`
   被整段重写，静默覆盖掉 `main` 后来加的两处重定向逻辑（大小写归一化、
   `destination.query` 合并），直到 Codex 复审才发现。

这三类信息（本分支与目标分支分叉后改动的**交集**、引用路径是否还**存在**）都不在
单元测试的视野里。

## Decision

新增 `scripts/check-branch-safety.ts`（CLI，默认 base = `origin/main`，取不到退回
`main`，可用 `--base` 指定），四项检查：A 静默覆盖、B 断链引用、C 提交签名、
D 提交信息。有 error 退出码为 1，warn/info 只打印；`--json` 输出结构化结果；
`--ignore-signatures` 供没有 GPG 的环境跳过签名检查。

实现取舍：

- A 用**一次** `git log --format=... --name-only -m` 解析目标分支侧改动。逐文件跑
  `git log -- F` 语义最直观，但几千文件时是 O(文件数) 次进程启动。
- A 的分级按"本分支侧净删除行数"（`git diff --numstat -w`）：≤3 行降为 `info`
  （疑似仅重命名/路径替换），否则 `warn`；只新增行也降为 `info`。
- B 用词法扫描区分注释 / 普通字符串 / 模板插值 / 正则，不做正则硬扒。导入断链是
  `error`（构建期硬失败），字符串字面量断链只报 `warn`（基准目录有歧义）；测试
  文件只查导入、不查字符串（夹具数据会大量误报，实测全量扫描的 40 处误报全部来自
  这类夹具）；字符串按「仓库根 / 模块根 / 本文件目录」多基准探测，任一命中即算存在。
- 显式豁免：同一行或相邻行注释里写 `branch-safety: ignore`。
  `scripts/check-legacy-api-removed.ts` 的"必须不存在"清单用它说明意图。
- 检查对象一律取**提交树**：B 的文件内容与存在性来自 `git ls-tree` + `git cat-file
  --batch`（一棵树只开两个 git 进程），不读工作区。工作区有未提交改动、或停在别的分支，
  都不影响判定；刻意不提供"检查脏工作区"开关，避免两种语义混用。
- pre-push 读 git 传入的 stdin：每行
  `<local-ref> <local-sha> <remote-ref> <remote-sha>`，逐个引用算
  `remote-sha..local-sha`（新分支用 `--not --remotes`），多引用汇总、任一引用有 error
  即 exit 1。检查器新增 `--pushed-refs <文件|->`，根 `deno.json` 的
  `check:branch-safety` 任务仍是唯一入口。
- 直写的 `.git/hooks/pre-push` 是主路径（`scripts/install-git-hooks.mjs` 用 `git
  rev-parse --git-path hooks` 定位公共 hooks 目录，worktree 里也能装）。钩子入口先读当前
  检出分支的根 `deno.json`，没有 `check:branch-safety` 任务就打印一行并 exit 0——
  `.git/hooks` 被所有 worktree 共享，不能让旧分支阻断无关推送。
- `lefthook.yml` 保留同一入口：`--pushed-refs -` + `use_stdin: true`（lefthook 1.4.10+
  才有；它默认不转发 stdin）。同一时间只有一种钩子安装生效，不会两套各读一遍 stdin。
- 自测登记在 `scripts/gate-list.ts` 的 `GATE_SELF_TESTS`。

## Alternatives considered

- **只在 pre-commit 里跑全量测试**：慢，而且拿不到"目标分支分叉后改过同一文件"这类
  信息——事故 3 正是差分问题，不是测试问题。
- **只做 import 正则检查**：会命中注释里的旧路径与测试夹具数据，误报会让人直接忽略
  脚本；这也是实现里专门写词法扫描器的原因。
- **把字符串字面量断链也判 error**：字符串的基准目录（仓库根 / 模块根 / 运行时 cwd）
  无法静态确定，判 error 会阻断正常推送。
- **在 `scripts/` 下放独立 `deno.json`**：仓库根原本没有清单文件，那样 `deno task`
  就必须先 `cd scripts`，与文档、pre-push 的写法都不一致；根清单只放 tasks，并用
  `"lock": false` 避免凭空生成一个根 `deno.lock`。
- **从工作区读文件内容/判存在性**：提交范围决定"检查哪些文件"、工作区决定"文件长什么样"，
  两者不一致时既会漏报（本地删了文件）也会误报（本地新建文件冒充已提交）；已改为提交树。
- **在钩子里 `cat` 一遍 stdin 再调检查器**：多一层临时文件与清理，且 `deno task` 本来就
  继承 stdin；直接 `--pushed-refs -` 只读一次。lefthook 下用 `use_stdin: true` 是同一语义。

## Consequences

- 每次 push 多一次约 1.5 秒的检查（Deno 启动 + 180+ 个文件、300+ 处引用；提交树内容
  走 `cat-file --batch`，不随文件数增加 git 进程）。
- 一次推 N 个引用就查 N 遍；引用已包含在 base 中时直接跳过并说明。
- A 的"分叉后双方都改过"仍按整条分支（`merge-base..head`）判定，而不是只看本次新增提交：
  base 前进后首次推送整条分支时，旧提交与新 base 的覆盖风险才是真正要拦的；C/D 只查
  本次待推送范围，避免重复报已推送的旧提交。
- 测试用真实 git 临时仓库夹具（30 个用例，约 35 秒，含真实 `git push` 钩子链路与
  worktree 安装），已登记到 `GATE_SELF_TESTS`，与其他门禁自测一起跑。
- 已知盲区：重命名后语义变化的字符串引用、Vue 模板里的资源路径（`.svg` 等扩展名
  刻意不查）、非 `_test`/`.test` 命名的夹具文件；合并提交的提交信息不检查（由 git
  生成）。
- 没有 GPG 的环境必须显式 `--ignore-signatures`，否则签名检查按设计阻断推送。
