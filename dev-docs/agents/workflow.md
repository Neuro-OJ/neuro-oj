# 分支、PR 与提交流程

> 根 [`AGENTS.md`](../../AGENTS.md) 的 workflow 落点：分支与集成分支、jj 操作、
> PR、提交信息、GPG、Agent Notes 与 CI/CD。

## 1. 分支与集成分支

- 集成分支**不写死**：以 `git branch -r` 与最近 tag 为准。2026-11 时仓库里没有
  `rc/*` 分支，集成分支就是 `main`（= tag `v0.11.0`）。换线时只改这一段。
- **禁止直接推送 `main` 与 rc 分支**：所有变更（功能、缺陷修复、文档）一律从当前
  集成分支派生主题分支，通过 Pull Request 合入当前集成分支。
- 合入前必须完成相关检查与验收，并等待 CI 通过。
- 集成分支必须始终保持可部署状态；发布从已验证提交或版本标签构建。
- AI 工具配置、编辑器配置、临时日志、备份文件等本地产物不得提交。

本地用 jj：`jj describe` 设提交信息、`jj new` 新提交、`jj squash` 压回、
`jj git push` 推送、`jj undo` 回退。

## 2. PR 工作流（所有变更）

- **PR 描述必须按模板填写**：开 PR 前先读
  [`.github/pull_request_template.md`](../../.github/pull_request_template.md)，完整保留
  其章节结构（关联 Issue、变更摘要、变更类型、影响范围、验证清单）并如实勾选。使用
  `gh pr create --body` / `--body-file` 会直接覆盖网页端默认模板，**不得省略模板或改用
  自由格式**（无关联 Issue 填「无」，不适用项保持未勾选或注明原因）。

下例用 `<base>` 占位集成分支，先 `git branch -r` 确认（2026-11 时为 `main`）。

```bash
jj git fetch
jj new <base>@origin
jj describe
jj git push --named <branch-name>=@      # 首次推送时创建同名 bookmark
gh pr create --draft --base <base> --head <branch-name>
# 迭代：在新提交上修改后压回，再推送（jj 自带 force-with-lease 式安全检查，无需 --force）
jj new
jj squash
jj git push -b <branch-name>
```

### 大规模变更：先报后果，再动手（2026-11-22）

用户提出「全仓统一 X」「重排整个目录」「批量重命名」这类**最终结果是全仓或大面积**
**改动**的任务（通常指预计波及 >50 个文件或跨 ≥3 个模块的批量机械改动；已有确认
方案的功能开发除外）时，**不要立刻施工**。先用实测数据把后果讲清楚，再等确认：

- **影响面**：实际涉及多少文件、多少模块。用 `rg -l` / `git diff --stat` 数出来，
  不要估。
- **并行冲突面**：当前有多少活跃分支在改同一批文件；main 最近多久动一次。
- **评审与迭代成本**：这种 diff 能不能被 review、每次 rebase 多久、要重跑哪些门禁。
- **同类先例**：2026-11 尝试全仓缩进 2→4 格（2,100+ 文件），两小时内冲突从 28 涨到 72，
  合入后被 #784 整笔回滚——根因是全仓格式化顺带改了引号、换行与分号等风格，diff 里
  混进大量无关改动。

数据给完、用户确认后再动手；若用户仍要求执行，把「已知后果」写进 PR 描述。

## 3. 提交信息

- 格式：`<type>(<scope>): <中文描述>`
- type：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci`
  `build`
- scope：模块 `core` `ui` `judge` `gateway` `cli` `lmcc` `docs`（noj-docs）
  `tests`（noj-tests）；横切 `root`（根目录与 `scripts/`、`dev-docs/`
  等）、`ci`、
  `deps`（依赖升级）。多模块用英文逗号分隔、不加空格：`feat(core,ui): ...`

### 提交粒度（2026-11-21）

**默认：一个提交 = 一个完整变更。** 同一变更的返工（bug 修复、评审意见、补测试）不新增
`fix:`，直接折回原提交：

- 最新一条：`git commit --amend`
- 更早但仍在最近几条内：`git commit --fixup=<sha>` 再 `git rebase -i --autosquash <base>`
- jj 等价：`jj squash` 折回、`jj describe` 改信息

**例外：原提交已经隔了很多条，单独做 `fix:` 提交，不要回滚重写。** 判据：

| 情况                          | 做法                                           |
| ----------------------------- | ---------------------------------------------- |
| 原提交就是上一条（中间 0 条） | `--amend`                                      |
| 中间 1 条且改动同一语义       | `--fixup` + `--autosquash`，或并入相邻那条     |
| 中间已隔 2 条以上             | **单独 `fix:` 提交**                           |
| 原提交已推送                  | **单独 `fix:` 提交**（改写会让别人的分支变基） |
| 折回需解决大量冲突            | **单独 `fix:` 提交**                           |

两种做法要满足同一个结果：**单个提交读起来是一次做完的**，不是「先写一版、再补一刀」。
区别只在于「这一刀折回去代价小，还是新起一条更清楚」。

推送前自查：`git log --oneline <base>..HEAD` 里不应出现 `fixup!`、`squash!`、`wip`，
也不应出现「按评审意见修改」这类补丁式提交——除非它确实满足上面的例外条件。

## 4. 语言与签名

中文：提交描述、注释、文档、PR/Issue；英文：代码标识符。 **所有提交必须 GPG
签名**，AI 修改代码前必须确认签名可用。

## 5. Agent GPG 检查

```bash
gpg --list-secret-keys --keyid-format LONG
git config --global user.signingkey
git config --global commit.gpgsign
jj config get signing.key
```

## 6. Agent Notes（决策记录）

非平凡变更必须在 `.agents/notes/implemented/<分类>/yyyy-mm-dd-topic-title.md`
新增或更新记录。分类：`feature` / `bug-fix` / `simplification` / `architecture`
/ `process` / `testing`。

格式：`# Agent Note: <标题>`、`Status: implemented`，以及 `## Problem` /
`## Decision` / `## Alternatives considered` / `## Consequences` 四节。

校验与约定：

```bash
deno run -A scripts/verify-agent-note-format.ts
```

细则见 [`.agents/notes/README.md`](../../.agents/notes/README.md)。

## 7. CI/CD

| 工作流                 | 作用                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `ci.yml`               | 静态检查、测试、构建（按模块路径过滤）                                                          |
| `e2e.yml`              | 跨模块全链路 E2E + judge 沙箱                                                                   |
| `security.yml`         | 依赖漏洞审计（dependency-review / cargo-audit / osv-scanner）与 CodeQL；PR 按路径过滤，定时全量 |
| `release.yml`          | 预发布 Release：构建镜像、`noj-cli` 二进制与部署文件（附 `.sha256`）                            |
| `test-performance.yml` | 性能基准门禁：每日定时 + 候选发布固定 SHA 调用，不用来阻断普通 PR                               |
| `lint-workflows.yml`   | actionlint                                                                                      |

CI 同时检查文档链接（`scripts/verify-md-links.ts`）与 Agent Note 格式
（`scripts/verify-agent-note-format.ts`）。

## 8. 故障排查

生产问题先用 `noj-cli status --dir <安装目录>` 拿到状态，再对照
[常见问题](https://docs.noj.xyber-nova.space/intro/faq.html)。
