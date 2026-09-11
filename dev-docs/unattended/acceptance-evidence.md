# 无人值守交付验收证据

> 目标与验收标准见 `dev-docs/superpowers/specs/2026-09-11-unattended-24h-objective-design.md`。
> 进度留痕见 `dev-docs/unattended/progress-log.md`。
>
> **本文件的所有数字均为实测输出**，命令附在每节。凡未实测者均明确标注为「未验证」。

- 执行日期：2026-09-11
- 交付约定：分支 + Draft PR，**未推送 main、未合并任何 PR**
- 仓库：`Neuro-OJ/neuro-oj`（平台）、`Neuro-OJ/noj-problems`（题库）

---

## 1. PR 清单

### 平台仓库（Neuro-OJ/neuro-oj）

| PR | 标题 | 类型 | CI（Draft PR 结论） |
|---|---|---|---|
| [#485](https://github.com/Neuro-OJ/neuro-oj/pull/485) | docs(root): 无人值守 24h 目标设计与验收标准 | 栈底文档 | 通过（docs-only，模块 job 按路径过滤跳过） |
| [#486](https://github.com/Neuro-OJ/neuro-oj/pull/486) | fix(core,judge): 基线转绿——分片迁移、评测结果竞态、镜像权限、测试产物 | **核心修复** | **39 pass / 0 fail** |
| [#487](https://github.com/Neuro-OJ/neuro-oj/pull/487) | docs(root): 无人值守执行工作日志（含平台 E2E 实测证据） | 文档 | 通过 |
| [#488](https://github.com/Neuro-OJ/neuro-oj/pull/488) | fix(judge): 每用户评测并发限制改为跨 worker 分布式 claim | **真实缺陷修复** | **23 pass / 0 fail** |
| [#489](https://github.com/Neuro-OJ/neuro-oj/pull/489) | feat(core): 新增题目脚手架 `noj problems init` | 新功能 | **26 pass / 0 fail** |
| [#490](https://github.com/Neuro-OJ/neuro-oj/pull/490) | feat(core): 新增竞赛代码相似度检测 | **新功能（空白项）** | **2 pass / 0 fail** |
| [#491](https://github.com/Neuro-OJ/neuro-oj/pull/491) | feat(core,ui): 成绩单导出补全 | 新功能 | **2 pass / 0 fail** |
| [#492](https://github.com/Neuro-OJ/neuro-oj/pull/492) | fix(judge): SDK 测试镜像按内容哈希判断陈旧 | 测试基础设施 | **7 pass / 0 fail** |

### 题库仓库（Neuro-OJ/noj-problems）

| PR | 标题 | 类型 | CI 结论 |
|---|---|---|---|
| [#1](https://github.com/Neuro-OJ/noj-problems/pull/1) | feat(problems): trial-snowy-manor 反刷分加固、剧本校验器与出题工具链 | WIP 固化 | 当时该仓库**无 CI** |
| [#2](https://github.com/Neuro-OJ/noj-problems/pull/2) | ci(problems): 新增题库仓库 CI | **CI 基础设施** | **题库检查 pass** |
| [#3](https://github.com/Neuro-OJ/noj-problems/pull/3) | feat(problems): 新增原创题「解码采样器的实现」 | 新题 | 由 #2 的 CI 校验 |
| [#4](https://github.com/Neuro-OJ/noj-problems/pull/4) | feat(problems): 新增原创题「BPE 分词器的训练与编码」 | 新题 | 同上 |
| [#5](https://github.com/Neuro-OJ/noj-problems/pull/5) | feat(problems): 新增原创题「LLM 评测指标的实现」 | 新题 | 同上 |
| [#6](https://github.com/Neuro-OJ/noj-problems/pull/6) | feat(problems): 新增原创题「带引用的检索问答」（LLM 工程题） | 新题 | 同上 |

> 栈结构（每个 PR 的 base 指向前一个，逐个可独立 review/回退）：
> `observability-domain (#484)` → `#485` → `#486` → `#487` → `#488/#489` → `#490` → `#491` → `#492`
> 题库：`main` → `#1` → `#2` → `#3` → `#4` → `#5` → `#6`

---

## 2. D0 基线转绿 —— 修复前后对比

| 指标 | 修复前 | 修复后 | 命令 |
|---|---|---|---|
| core 分片测试 | `905 passed / **5 failed**` | **`910 passed / 0 failed`** | `cd noj-core && deno task test:parallel` |
| `e2e_abnormal`（Docker E2E） | `3 passed / **2 failed**` | **`5 passed / 0 failed`** | `NOJ_RUN_E2E=1 cargo test --test e2e_abnormal -- --ignored` |
| judge E2E 全量（8 binary） | 1 个 binary 失败 | **`42 passed / 0 failed`** | 逐个 `cargo test --test <t> -- --ignored` |
| judge 单元 | — | **`341 passed / 0 failed`** | `cargo nextest run --all-targets` |
| `test:domain contest`（干净环境） | `34 passed / **4 failed**` | **`38 → 46 passed / 0 failed`** | `env -u JWT_SECRET -u DATABASE_URL bash scripts/test-domain.sh contest` |
| 仓库门禁 | — | **全部检查通过** | `deno run -A scripts/check-all.ts` |

### 4 个根因（均为实测定位）

1. **迁移文件跨 schema 硬编码 `"public".` 前缀** —— 3 个迁移文件，分片下 FK 指向
   `public` 而表建在 `test_db`，父行永远无法满足约束。**确定性失败**，
   此前被误判为「分片并发竞态」（因为 `test:domain` 单跑全绿）。
   证据：`pg_constraint` 查询在 `test_db` 内恰有 3 个跨 schema FK。
2. **judge RESULT payload 竞态（真实产品缺陷）** —— 阶段 2 的守卫
   `result_payload.is_none()` 在「已见标记、payload 待读」时（`Some("")`）为 false，
   导致阶段 2 被整体跳过，payload 永不读取 → 合法结果被误判为 `SystemError`。
   **选手的正确答案会被报为系统错误**。新增回归测试把竞态确定化（修复前稳定复现）。
3. **镜像权限未归一化** —— 容器以非 root 运行，`COPY` 保留本地文件模式；
   本地 `sdk/common/noj_sdk_common/*.py` 为 `600` → 非 root 无法 import → 打挂整个双容器套件。
   git 只跟踪可执行位，CI 全新检出为 644 故只在本地复现。
4. **`.test-storage/` 产物被误提交** —— 已被 `.gitignore` 却仍被跟踪，
   而 `test:parallel` 每次清空 `db/`，导致每次跑测试产生 6 个删除 diff，
   使干净基线不可达、污染每个 PR。

> 另有 `test-domain.sh` 本地缺 `JWT_SECRET`（与 CI 行为不一致，报错误导）已一并修复。

---

## 3. D1–D3 题库交付

### D1：`noj-problems` WIP 固化（PR #1）

审阅 40 文件 / +4177 行未提交 WIP，**独立核验**而非引用其 README：

| 核验项 | 实测结果 |
|---|---|
| 全部测试 | **44 passed** |
| 零告警 | `-W error::ResourceWarning` 下 **44 passed**（修复了一处未关闭文件句柄） |
| 剧本质量校验 | **6 剧本，ERROR 0 条** |
| 满分链路可达 | `strong` + `judge=50` → **1000/1000** |
| 零 LLM 基线 | `generic` → **0–100**（6 剧本实测 max=100） |
| **反刷分** | **7 类 rogue × 6 剧本 = 42 组合全部 0 分**（即使授予 judge=50） |
| 确定性 | 同 seed 必同剧本；600 次抽样覆盖全部 6 剧本（无死剧本） |
| 布局可重现 | `tools/build_scenarios.py --check` 全部通过 |

### D2：题库 CI（PR #2）—— 使「Draft PR CI 验收」标准成立

该仓库此前**无任何 workflow**（`gh pr checks #1` 返回 `no checks reported`）。
新增 `scripts/ci_checks.sh`（按目录自动发现题目）+ `scripts/validate_manifest.py`（按规范校验 manifest）+ workflow。

- 正向：4 道题 **14 项检查全过**（`汇总：通过 14 项，失败 0 项`）
- 反向：注入 ERROR 后退出码 **1**，还原后 **0** —— 门禁真实有效
- **CI 首轮失败并抓出真实缺陷**：D1 中的 Python 3.12 兼容问题
  （`NameError: name 'Any' is not defined`）—— 本机 python3.14 因 PEP 649
  延迟注解求值而**掩盖**了它。修复后跨版本验证 **3.10 / 3.11 / 3.12 / 3.13 / 3.14 全部 44 passed**。

### D3：4 道原创题

| 题目 | 模块 | 隐藏/可见用例 | 单测 | 离线自测 |
|---|---|---|---|---|
| `decoding-sampler` 解码采样器 | 解码与部署 | 22 / 3 | **48 passed** | 6/6 |
| `bpe-tokenizer` BPE 分词器 | 大模型基础概念·文本解析 | 34 / 4 | **79 passed** | 6/6 |
| `llm-metrics` LLM 评测指标 | 模型评测 | 38 / 4 | **71 passed** | 6/6 |
| `rag-cited-qa` 带引用的检索问答 | 智能体·RAG·API 调用 | 15 / 3（语料 16 篇） | **140 passed** | 22 项全过 |

全部题目：`-W error::ResourceWarning` 下通过，且**在 `python:3.12-slim` 容器内复跑通过**
（评测镜像版本；本机 3.14 会掩盖 3.12 上的注解求值问题）。

**反刷分实测（LLM 题）** —— 6 类策略**全部 0.00**：硬编码 / 引用全部文档 / 空答案 /
不检索直接作答 / 统一规范拒答 / 只引第一名不作答。
残余面「检索后统一拒答」= **13.33**，由 `gaming_bounds` 用同一套评分函数推导出**结构性上界**
（= 2/15 拒答用例占比）并与实测同值。

**判据非空转实测**（证明不是二值空转，而是连续分档）：

| 题目 | 近似错误实现 | 得分 |
|---|---|---|
| BPE | 规则顺序反转（把 rank 优先级写成列表顺序） | **67.65** |
| BPE | 缺失 rank 0 规则 | **73.53** |
| LLM 指标 | 桶边界归上桶 | **92.11** |
| RAG | 引用错一个 doc / 漏引一篇 / 答案错但引用对 | **75.00 / 83.33 / 50.00** |

### D3.5：平台端到端验证（L1 门禁 #8，真实平台取证）

搭建独立平台栈（新库 + 独立 Redis db + local 存储 + judge worker），逐题执行
「导入题目包 → 提交参考解 → 校验判定与分数」：

| 题目 | 状态 | 分数 | 隐藏/可见用例 | 隐藏字段泄露 |
|---|---|---|---|---|
| `decoding-sampler` | `finished` | **10000**（满分 100.00） | 22 / 3 | 无 ✅ |
| `bpe-tokenizer` | `finished` | **10000**（满分 100.00） | 34 / 4 | 无 ✅ |
| `llm-metrics` | `finished` | **10000**（满分 100.00） | 38 / 4 | 无 ✅ |

**反蒙分（平台侧实测）**：提交 `template.py`（`solve` 抛 `NotImplementedError`）→
`status=error`、`score=0`、`cases=0` —— 符合设计契约（异常上抛 → 不输出 `---RESULT---`
→ judge 收尾 `error`），且满足「非 AC 且 0 分」。

---

## 4. D4 平台改进交付

| 项 | 内容 | 关键验证 |
|---|---|---|
| D4.2 | **每用户并发限制改为跨 worker 分布式 claim**（真实缺陷） | **8 个 worker 并发占用同一用户，恰好 1 个成功**（对原缺陷的直接回归）；另有 5 个 Redis 集成用例覆盖过期回收/误释放/命名空间 |
| D4.3 | **代码相似度检测**（Phase 2 唯一空白项） | 改名/注释/空白 → **1.0000**；不同实现 → **0.0000**；空/极短 → 0.0000；最难场景（同思路 DP）→ 0.2653；100 份 7.0ms |
| D4.4 | **成绩单导出补全**（历史版本 + 逐题明细 CSV + UI 入口） | 真实平台实测：`/1.json` → 200 且返回**该版本** rows；`/1.csv` 逐题展开；`=cmd\|calc` → `'=cmd\|calc`（注入防护）；`/99.json` → 404；`/0.json` → 400；静态路由未被抢占 |
| D4.5 | **题目脚手架 `noj problems init`** | 11 个用例（含「产物通过平台 manifest 校验」ERROR 0 / WARN 0）；实测生成 7 文件 |
| D5 | **陈旧镜像陷阱修复** | 无改动 → 跳过（0.71s）；改 SDK 源码 → **检测到并重建**（这正是曾骗过我的场景）；7 个哈希单元用例 |

### D4.2 为何是「真实缺陷」而非理论问题

原实现用**进程内** `HashSet` 记录活跃用户 → 部署 N 个 worker 时每个进程各有一份集合，
同一用户可同时跑 N 个评测（公平性被静默放大 N 倍）。**单 worker 下完全不可见**，
因此长期未被发现。

### D4.3 的两个关键决策

- **规模超限抛错而非静默截断**（默认 200 份 → `SIMILARITY_SCALE_EXCEEDED`）：
  静默截断会让管理员把「没算到」误读成「没有相似提交」。
- **数字字面量不归一化**：保住「只改常量」这层区分度，代价是该类抄袭**漏报**（非误报）。

### D4.4 踩到的 Hono 路由坑（已记录在代码注释）

| 写法 | 实测结果 |
|---|---|
| `:version.json` | 匹配成功，但**整个 `version.json` 被当作参数名**（捕获 `"1.json"`） |
| `:version{[0-9]+}.json` | **RegExpRouter 构建匹配器时直接抛错** |
| `:file` + handler 内解析 | ✅ 唯一可行（且必须注册在静态同级路由之后） |

---

## 5. 门禁与工程质量

| 检查 | 结果 |
|---|---|
| `deno run -A scripts/check-all.ts`（仓库级门禁） | **全部检查通过** |
| `cargo nextest run --all-targets` | **341 passed / 0 failed** |
| `cargo clippy --all-targets` | **零警告** |
| `cargo fmt --check` / `deno fmt --check` / `deno lint` | 通过 |
| `noj-ui` 的 `deno task check`（fmt+lint+类型+Nuxt 类型） | exit 0 |
| 导出 JSDoc 覆盖率门禁 | 通过（noj-core 62.4% ≥ 阈值 59.6%） |
| Agent Note 格式校验 | 通过（新增 3 篇：基线稳定性 / 代码相似度 / 无人值守设计） |

### 门禁实际拦下的问题（证明门禁有效）

1. **路由目录过期**：D4.3 与 D4.4 新增端点后 `check-all.ts` 失败并提示重跑
   `gen-route-catalog.ts` —— 两处均已重生成并确认新端点出现在目录中。
2. **题库 CI 首轮失败**：抓出 Python 3.12 兼容缺陷（见 §3 D2）。
3. **反向注入验证**：题库 CI 注入 ERROR → 退出码 1；judge 镜像陈旧检测
   改源码 → 触发重建。

---

## 6. 未完成 / 未验证项（明确声明）

| 项 | 状态 | 原因 |
|---|---|---|
| **LLM 题的真实模型质量** | **未验证** | 环境无可用 LLM Provider（`llm_providers` 表 0 行）。离线用确定性桩验证了评分链路可达满分与反刷分有效，但**真实 judge 的要点覆盖分布、多跳召回、评分稳定性、重测波动、`billed_tokens`** 均需配置真实 Provider 后复验。已列在 `rag-cited-qa/README.e2e.md` 第 4 节。 |
| `rag-cited-qa` 的平台 E2E | **未执行** | 同上（需真实 Provider）。另 3 道纯 CPU 题已在真实平台取证满分。 |
| 题库 PR 的 CI 结论 | **部分缺失** | PR #1 提交时该仓库尚无 CI（#2 才引入）。#3–#6 由 #2 的 CI 覆盖，但 PR 各自的 `gh pr checks` 需以 #2 的 workflow 生效后为准。 |
| D4.6 Judge ZIP fuzz 测试 | **已取消（前提不成立）** | 子代理报「文档声称已做但实际不存在」经**二次核实为假阴性**：测试实际存在，名为 `test_extract_zip_random_bytes_never_panics`（固定 LCG 种子 + 有界 200 次迭代），与 Agent Note 描述**完全吻合**。子代理只 grep 了英文 `fuzz`。**教训：命名差异会导致假阴性，对「grep 0 命中 ⇒ 功能不存在」必须二次核实。** |
| 考试模式 / A-B 榜 / IOAI 赛制 / 评测插件机制 / 多语言评测 | **未做（明确排除）** | 前四项规模 L，24h 内不可靠；多语言评测经确认**非本项目目标**。 |

---

## 7. 待人工 review 清单

### 高优先级（影响正确性）

1. **judge RESULT payload 竞态修复**（#486）—— 本次最高价值修复。
   重点 review `noj-judge/src/dual/mod.rs` 编排循环的**退出条件顺序**
   （payload 完整 → 双流结束 → 超时）；后续重构不得把「payload 完整即收尾」
   放到「双流结束」之后。
2. **跨 worker 每用户并发 claim**（#488）—— 确认 `JWT_USER_CLAIM_TTL_MS` 默认 1h
   与生产最长评测耗时的关系（**必须大于**，否则长评测会被误判过期而破坏互斥）。
3. **迁移文件直接修改而非新增迁移**（#486）—— 确认生产尚未应用这些迁移，
   或确认前缀去除对已应用环境无影响（生产对象均在 `public`，理论上无影响）。
4. **`isJudgeAvailable()` 放宽为接受 `error`**（#486）—— 确认无其他 E2E 用例
   依赖「error 即视为 judge 不可用」。

### 设计取舍（需产品/运营判断）

5. **代码相似度默认上限 200 份**（#490）—— 若竞赛常见 300+ 份/题需提高，
   代价是请求线程的同步 CPU 时间（400 份病态输入实测 7.0s）。
6. **数字字面量不归一化**（#490）—— 「只改常量」的抄袭会漏报，属刻意取舍。
7. **成绩导出 CSV 格式变更**（#491）—— 由「一人一行 + JSON 明细单元格」改为
   「一人一题一行」。若有下游脚本解析旧格式需同步调整。
8. **题目脚手架位置**（#489）—— 放在 `noj-core/scripts/noj.ts` 而非 `noj-cli`。
   理由：`noj-cli` 是生产部署 CLI，题目创作链路（`problems build/import`）本就在 core。
9. **题库占位符分级**（#2）—— `llm.provider_id`/`model` 的 `REPLACE_WITH_*`
   默认记 WARN（保持 CI 常绿），`--strict` 下升为 ERROR。理由：这是已文档化的
   运营前置步骤；若默认 ERROR，CI 会永久红灯，重蹈「基线不可信」的覆辙。

### 需真实 Provider 才能定论

10. **LLM 题的评分稳定性与真实模型能力**（见 §6）。

---

## 8. 本次工作暴露的既有问题（不在范围内，供后续排期）

1. **`plans/` 的 checkbox 不可信**：38 份中 31 份有未勾项，但对应工作早已上线
   （`2026-09-03-noj-core-organization-refactor.md` 有 139 未勾，对应域化重构已交付）。
   **不能当待办清单用**——建议要么回勾，要么在文件头声明「checkbox 不维护」。
2. **ROADMAP 漏报已实现项**：成绩单导出（原仅最新版）、judge 三级优先级队列、
   队列背压都已存在但未勾选。
3. **`noj-tests` 有 15 个文件未通过 `deno fmt --check`**（既有格式漂移，非本次引入）。
   我改动的 2 个文件均已格式化；其余 15 个属历史遗留。
4. **`ensure_sdk_images` 的陈旧镜像问题**已在 #492 修复（同类问题的
   「陈旧 Docker 镜像」变体也影响过平台 E2E —— 见 progress-log 的环境坑记录）。
5. **提交详情投影会裁剪出题人自定义的汇总字段**：题目 `details` 中的
   `hidden_passed` 等字段不会返回给前端（投影按白名单裁剪），
   `details.cases[]` 正常保留。出题人若需暴露汇总字段需确认其在白名单内。

---

## 9. 复现方式（供 review 者独立验证）

```bash
# 平台仓库
cd neuro-oj
deno run -A scripts/check-all.ts                    # 仓库级门禁
cd noj-core && deno task test:parallel              # 910 passed
cd noj-judge && cargo nextest run --all-targets     # 341 passed
NOJ_RUN_E2E=1 cargo test --test e2e_abnormal -- --ignored   # 含 RESULT 竞态回归
REDIS_URL=redis://127.0.0.1:6379/9 cargo test --test user_claim_redis  # 跨 worker 回归

# 题库仓库
cd noj-problems && bash scripts/ci_checks.sh        # 4 题 14 项检查
cd decoding-sampler && python3 offline_check.py     # 6 项（含反空转）
cd bpe-tokenizer && python3 offline_check.py
cd llm-metrics && python3 offline_check.py
cd rag-cited-qa && python3 offline_check.py         # 22 项（含 6 类反刷分）
```

平台 E2E 脚本（需自行搭建栈）：`/tmp/e2e_platform_check.py`（未纳入仓库；
如需长期使用建议移入 `noj-tests/` 或 `scripts/`）。
