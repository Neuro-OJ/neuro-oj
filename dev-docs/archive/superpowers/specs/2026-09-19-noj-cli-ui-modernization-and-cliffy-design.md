# noj-cli 界面现代化与框架迁移设计（Cliffy 两阶段）

> ⚠️ **本 spec 已被取代（2026-09-19）**：新要求改为**纯 TS 重写并直接采用 Cliffy**（不再分两阶段，阶段二的 D4 前置随之消失）。详见 `2026-09-19-noj-cli-pure-ts-rewrite-design.md`。本文件保留作为历史决策记录（其 spike 验证结论仍有效）。

Status: approved
日期：2026-09-19
执行者：AI Agent（无人值守自主执行）
批准人：项目所有者（人在回路讨论后批准）
基线：`b3e99199e7cc95361b6049c08681f974557f8611`（= `main@origin`）

**关联 spec**：`2026-09-19-noj-cli-production-unification-design.md`（生产运维统一 #513/#515/#516/#518 + 文档漂移 #510）

---

## 1. 问题

`noj-cli` 的界面观感与 help 可维护性均已到达瓶颈，且**已经开始漂移**。

### 1.1 实测：help 已在漂移（本 spec 的直接动因）

```text
$ noj-cli backup --help
生产备份；子命令 create/verify/restore/drill          ← 漏了 list/prune
```

但 `list`/`prune` 是 #515 **已合入**的真实能力。根因不是笔误，是**同一份文案维护在 4+ 处**：

| 位置 | backup 子命令列表 | 一致性 |
| --- | --- | --- |
| `help.ts:52` | `create/verify/restore/drill/list/prune` | ✅ |
| `cli.ts:1064` | `create/verify/restore/drill` | ❌ |
| `cli.ts:1567` | `create/verify/restore/drill` | ❌ |
| `cli.ts:1640` | `create/verify/restore/drill` | ❌ |

**8 个 help 渲染函数**各自手写文案：`printHelp`(`cli.ts:571`)、`renderHelp`(`help.ts:154`)、`renderCommandHelp`(`help.ts:189`)、`renderDrillHelp`(`cli.ts:925`)、`renderProductionCommandHelp`(`cli.ts:1556`)、`renderDeployHelp`(`cli.ts:1583`)、`renderMaintainHelp`(`cli.ts:1612`)、`renderProblemHelp`(`problem/help.ts:6`)。

这正是 #517 根因表记录的：「help 文本**手写**且与实现分离，易漂移」。

### 1.2 实测：现状被夸大的与真实的

| 诉求 | 实测结论 |
| --- | --- |
| "加 ANSI 颜色" | **大部分已存在**：`util/color.ts`(112 行) 已实现 `NO_COLOR`/`LOG_COLOR`/`--color=auto|always|never`、非 TTY 自动关色、`prefixLine`(含 SGR 边界处理) |
| "富文本与排版" | **真实缺口**：无表格、无分组对齐、无进度/状态符号 |
| "成熟框架" | **真实缺口**：1 个命令分发函数 527 行（`dispatchCommand` `cli.ts:1011-1538`），`cli.ts` 共 1648 行 |
| "现代化" | **品牌缺口**：`noj-design-tokens.md` 定义了完整 token，但**无 CLI/终端 section**（`rg 'CLI|终端|ANSI'` 零命中）；现调色板是任意 8 色 ANSI |

### 1.3 与既有决策的冲突（必须摊开）

| 出处 | 立场 |
| --- | --- |
| `2026-08-31-noj-cli-design.md:437` | 「TUI 使用 Deno 生态的交互库（**如 Cliffy**）实现命令解析与表单引导，ANSI 颜色用于状态和日志展示」 |
| **#518「明确不做」** | 「**不迁移到 Cliffy**：`parseProductionArgs` 的"只消费 `--dir`、其余原样转发"透传语义与 Cliffy 的解析模型冲突（见 #517）」 |

即：**原始设想 → 中途因透传冲突放弃 → 本 spec 重新开启**。重新开启必须证明障碍已消失，否则是回退。

---

## 2. 关键验证（spike 实测，非推测）

针对 #518 的反对理由与最大风险，已用真实 Cliffy 1.2.1 spike 验证：

**Spike 1 — 透传语义是否真的冲突？结论：不冲突。**

```ts
new Command().globalOption("--dir <dir:string>").allowEmpty()
cli.command("install").allowEmpty().arguments("[args...:string]")
// 输入: --dir /opt/neuro-oj install --port 8080 --panel baota extra
```

实测输出：
```text
INSTALL opts={"dir":"/opt/neuro-oj"}
INSTALL args=["--port","8080","--panel","baota","extra"]
```

**未知旗标被收集进可变参数而非报错**，同时全局 `--dir` 被正确解析。透传语义可表达。

**Spike 2 — 退出码契约是否兼容？结论：兼容。**

```text
$ spike nonexistent-cmd   →  EXIT=2（与 #517 E9 的"用法错误 2"一致）
$ 错误信息: error: Unknown command "nonexistent-cmd". Did you mean command "sub"?
```

**Spike 3 — JSON 契约能否保住？结论：能，但必须显式接管。**

- ⚠️ **默认行为会污染**：错误路径把 usage/help 写到 **stdout**，导致 `--json | jq` 解析失败（实测 `JSONDecodeError`）。
- ✅ **`.throwErrors()` 后完全可控**：错误转为异常（`exitCode=2`），stdout **零污染**，由我们决定输出去向。

> 这印证了「`--json` 必须走独立通道」的硬保证不是可选项——**框架默认行为会破坏它**。

---

## 3. 目标与边界

### 3.1 目标

两阶段交付：**阶段一**在**不换框架**的前提下消除 help 漂移、对齐品牌、提升排版，并把参数 schema 显式化；**阶段二**在参数已显式建模后**迁移到 Cliffy**。

### 3.2 关键决策（人在回路确认）

| 决策 | 结论 |
| --- | --- |
| 目标取向 | **两者都要，分阶段**：先界面，后框架 |
| 阶段二形态 | **直接承诺迁移到 Cliffy**（非"仅评估"） |
| 参数 schema | **顺带显式化**，为阶段二铺路 |
| `--json` 契约 | **硬保证**：独立通道，stdout 绝不含装饰 |
| 交付物 | **独立 spec 文件**（本文件），与生产运维统一 spec 互相引用 |

### 3.3 阶段二的硬前置：D4 必须先落地

#518 的反对理由是**透传**。而 `2026-09-19-noj-cli-production-unification-design.md` 的 **D4** 正是把 `deploy.sh` 生命周期迁进 CLI，**删除 bash 透传**。

- 在 D4 完成前迁移 Cliffy → 要为"半透传"状态做两次适配
- D4 完成后，12 个 `PRODUCTION_COMMANDS`（`production.ts:5`）变为原生实现，参数 schema 天然显式

**因此阶段二排在 D4 之后，不并行。**

### 3.4 明确不做（YAGNI）

- ❌ 在 D4 完成前引入 Cliffy
- ❌ 用框架渲染 `--json` 输出（JSON 走独立通道）
- ❌ 阶段一引入超过 1 个新运行时依赖（目标为零）
- ❌ 改动命令名与功能语义（纯界面/结构，不改行为）
- ❌ 重写已工作的颜色治理（`NO_COLOR`/`LOG_COLOR`/`--color` 契约保留）

---

## 4. 阶段一：界面现代化（不换框架）

| # | 交付物 | 内容 |
| --- | --- | --- |
| S1 | **help 单一事实源** | 8 个渲染函数收敛为一份声明式命令元数据；**消除已证实的 list/prune 漂移** |
| S2 | **参数 schema 显式化** | 把散落在 `parseDeployArgs`/`parseMaintainArgs`/`parseBackupArgs` 的旗标建模为可查询的 schema（为 S1 与阶段二共用） |
| S3 | **品牌对齐** | `noj-design-tokens.md` 补 **CLI/终端 section**；`color.ts` 按 token 取色（替换任意 8 色） |
| S4 | **排版** | 子命令表、`backup list` 表格、分组与对齐、状态符号（成功/警告/错误） |
| S5 | **JSON 契约硬化** | `--json` 独立通道 + 回归测试（断言 stdout 逐字节为合法 JSON） |

---

## 5. 阶段二：Cliffy 迁移（依赖 D4）

| # | 交付物 | 内容 |
| --- | --- | --- |
| T1 | Cliffy 依赖接入 | `@cliffy/command`（+ 评估 `table`/`prompt`）；更新 `deno.json`/`deno.lock` |
| T2 | 命令树迁移 | 用 Cliffy 重建命令树；**透传用 Spike 1 验证的 `[args...:string]` 模式** |
| T3 | 错误与退出码接管 | `.throwErrors()` + 现有 `run()` 兜底；保持 `0/1/2` 分层 |
| T4 | help 由框架生成 | 删除手写渲染函数（S1 的元数据成为框架定义） |
| T5 | 测试迁移 | 72 条 `cli_test.ts` 断言迁移与回归 |

---

## 6. 验收标准（CI 金标准）

### L0 · 全局门禁

| 门禁 | 命令 | CI 落点 |
| --- | --- | --- |
| CLI 静态 + 单测 | `cd noj-cli && deno task check && deno task test` | `ci.yml` → `production-cli` |
| 生产集成 | `deno task test:production` | 同上 |
| 仓库级门禁 | `deno run -A scripts/check-ci.ts` | `ci.yml` → `root-gates` |
| 签名 / 规范 | 中文 Conventional Commits + GPG；Agent Note 格式校验 | `root-gates` |

### S1 · help 单一事实源

- [ ] 8 个渲染函数收敛为**单一命令元数据源**（实测清单见 §1.1）
- [ ] `noj-cli backup --help` **包含 `list` 与 `prune`**（当前漂移的回归断言）
- [ ] `maintain backup`、`stack`、顶层 help 的 backup 子命令列表**三处一致**
- [ ] 新增一条**防漂移门禁**：help 中声明的子命令集合 == 实际 `switch/分发` 可处理的集合（不一致即失败）
- [ ] 每个 help 的 `--help` 仍**严格只读**（#517 E2 回归：不建目录、不读配置）

### S2 · 参数 schema 显式化

- [ ] `parseDeployArgs`/`parseMaintainArgs`/`parseBackupArgs` 的旗标均由显式 schema 驱动
- [ ] `--dir X` 与 `--dir=X` 在两处语义一致（#517 E6 回归）
- [ ] 缺值报错而非静默 `undefined`（#517 E4 回归）
- [ ] schema 可被 S1 的 help 生成与阶段二共用（单一事实源）

### S3 · 品牌对齐

- [ ] `noj-design-tokens.md` 新增 **CLI/终端 section**：语义色映射（成功/警告/错误/信息/强调）与降级规则
- [ ] CLI 语义色来自 token，**不新增任意 ANSI 调色板**
- [ ] `NO_COLOR` / `LOG_COLOR` / `--color=auto|always|never` 契约**不变**（回归断言）
- [ ] 非 TTY 自动关色仍成立

### S4 · 排版

- [ ] `backup list` 用表格呈现（列对齐；宽度按内容自适应）
- [ ] 长文本按终端宽度换行，窄终端不破版
- [ ] 状态符号与语义色配对（成功/警告/错误）

### S5 · JSON 契约硬化

- [ ] `--json` 的 **stdout 逐字节为合法 JSON**（无 usage/装饰/颜色码）
- [ ] `--json` 下**人类可读信息不写 stdout**（走 stderr 或省略）
- [ ] 覆盖 `backup list/prune --json`、`drill --json`、`problem lint/pack --json`
- [ ] `jq` 管道回归测试（模拟 CI 用法）

### T1–T5 · 阶段二（依赖 D4 完成）

- [ ] Cliffy 依赖接入且 `deno.lock` 受控
- [ ] 命令树覆盖全部命令；**透传语义与 Spike 1 一致**（未知旗标进可变参数）
- [ ] `0/1/2` 退出码语义**完全保持**
- [ ] `--json` 契约保持（Spike 3 的 `.throwErrors()` 接管，**不依赖框架默认行为**）
- [ ] 72 条 `cli_test.ts` 断言全部迁移或等价覆盖
- [ ] 阶段一新增的防漂移门禁仍通过（help 与实际能力一致）

---

## 7. 风险与处置

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| **框架默认把 help 写 stdout → 污染 `--json`** | 高（静默） | Spike 3 已证实；`.throwErrors()` 接管 + S5 逐字节断言 |
| 在 D4 前迁移 Cliffy → 两次适配 | 高 | 阶段二硬前置 D4，不并行 |
| 手写 help → 框架 help 的文案回归 | 中 | 阶段一先建单一事实源，阶段二只换渲染后端；逐条对照 |
| 显式化 schema 触碰 72 条测试 | 中 | 阶段一分步提交，保持 `0/1/2` 与既有断言语义；每步 CI 绿 |
| Cliffy 依赖膨胀（48 包 / 300KB） | 中 | 阶段一零新增依赖；阶段二只引入 `command`，实测产物体积变化并记录 |
| 品牌 token 与终端观感不一致 | 低 | S3 先补 token 文档再取色，避免凭感觉配色 |

---

## 8. 与既有工作的关系

- **与生产运维统一 spec（2026-09-19）**：阶段二**依赖其 D4**（删除 bash 透传）。本 spec 的 S2（参数 schema 显式化）为其 D4 后的 CLI 提供结构基础。两者均涉及 `cli.ts`，需**串行**避免冲突。
- **与 #518**：本 spec **推翻**其「不迁移到 Cliffy」结论，依据是 Spike 1 证明透传语义可表达；且 D4 完成后该理由整体消失。已在 §1.3 记录冲突与原决策。
- **与 #517（ergonomics）**：其修复（`--help` 只读、退出码分层、`--dir` 统一）是本 spec 的**回归基线**，全部保留。
- **与原始设计稿（2026-08-31:437）**：本 spec 回到其原本的 Cliffy 意图，并补上当时缺失的可行性验证。
