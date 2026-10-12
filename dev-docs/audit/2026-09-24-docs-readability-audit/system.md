# 系统架构与运维主题 文档审计报告

> 审计对象：`noj-docs/docs/system/`（面向主题 · 系统架构与运维）
> 审计日期：2026-09-24；事实源：源码（`noj-core/src`、`noj-judge/src`）与各模块 `CLAUDE.md`/`AGENTS.md`。
> 截图目录：`/tmp/opencode/audit-shots/system/`（`before-*` / `after-*`）。

## 范围

| 文件 | 改前行数 | 改后行数 |
| --- | ---: | ---: |
| `noj-docs/docs/system/index.md` | 8 | 15 |
| `noj-docs/docs/system/architecture.md` | 13 | 68 |
| `noj-docs/docs/system/security.md` | 53 | 95 |
| `noj-docs/docs/system/storage.md` | 67 | 60 |
| `noj-docs/docs/system/object-storage-governance.md` | 48 | 60 |
| `noj-docs/docs/system/anti-cheat.md` | 15 | 33 |

改前本组**零 VitePress 容器**，是本次审计的重点改进对象。

---

## 正确性发现

| 位置 | 问题 | 证据（路径 + 符号） | 处置 |
| --- | --- | --- | --- |
| `anti-cheat.md`（原「第二阶段：代码相似度（规划）」） | 称代码相似度为"规划"阶段、尚未实施；实际已作为风控面板分栏落地 | `noj-core/src/domains/contest/services/contest-similarity.ts` 文件头「竞赛代码相似度检测」与 `detectSimilarPairs()`；路由 `noj-core/src/domains/admin/routes/contest.ts:504` `GET /contests/:id/anti-cheat/similar-submissions`；前端 `noj-ui/pages/admin/contests.vue:46` `antiCheatTab = ref<'ip' \| 'similar'>` | **已修正**：重写为「代码相似度」已落地，并补充默认阈值/上限 |
| `anti-cheat.md` | 未说明相似度的规模约束，运营者易在整场竞赛上超限 | `contest-similarity.ts:38` `DEFAULT_SIMILARITY_THRESHOLD = 0.8`；`:41` `MAX_SIMILAR_PAIR_LIMIT = 200`；`:71` `DEFAULT_MAX_SIMILARITY_SUBMISSIONS = 200`；`:74` `DEFAULT_PAIR_LIMIT = 50`；`admin/routes/contest.ts:544-559` 参数解析 | **已修正**：补充"默认阈值 0.8、默认 50 对/上限 200 对、候选默认上限 200，超限建议按题缩小" |
| `anti-cheat.md` | 原称"第二阶段计划…完成评审后再实施"，与已上线事实矛盾 | 同上 | **已修正**：删除"规划"表述，改为两类已落地线索 |
| `security.md` | `applySubmissionProjection` 规则写"竞赛进行中…保留"与"竞赛结束后…保留"两条，但源码赛前/赛后对参赛者本人走**同一**投影分支（均保留 status/score、剥离 hidden） | `noj-core/src/domains/submission/services/submissions/submission-projection.ts:101-103` `// running/ended 均保留 status/score` | **已修正**：合并表述，避免读者误以为赛后恢复隐藏用例 |
| `security.md` | 未指出 `is_public` 由 `kind` 派生；旧文写"`is_public` 仍是控制展示的字段…二者不可互相替代"，易误导为可独立设置 | `noj-core/src/domains/contest/services/contests.ts:425` `is_public: kind === "public"`；`:546` `updates.is_public = kind === "public"` | **已修正**：改为"由 kind 派生、写入路径统一收敛，不单独接受 is_public 覆盖" |
| `security.md` | "邀请赛密码在库中只存哈希"不完整：报名校验兼容历史明文行 | `contests.ts:705-709` `isBcryptHash(stored) ? comparePassword(...) : stored === password` | **已修正**：改为"经 bcrypt 哈希存储，校验时兼容历史明文行" |
| `storage.md` | "local 模式会把支持包 Base64 内联"归因错误：local provider 的 `downloadUrl()` 生成 `noj-download://local?path=...`，不产生 base64 | `noj-core/src/domains/system/services/storage/local.ts:287-296` `buildLocalDownloadUrl()` | **已修正**：改为"`noj-download://base64` 会把支持包 Base64 内联" |
| `storage.md` | 缺少支持包大小上限，读者无法判断限制来源 | `noj-core/src/domains/catalog/services/support-package.ts:24` `MAX_SUPPORT_PACKAGE_SIZE = 128 * 1024 * 1024`；`problem-bundle.ts:133` 导入时校验 | **已修正**：新增 info 容器说明 128 MiB 上限 |
| `storage.md` | 评测包生命周期未点明"剥离的是 `problem.json`/`statement.md`" | `noj-core/src/domains/catalog/services/bundle-parser.ts:8` `stripMetadataEntries` 剔除这两个固定名；`problem-bundle.ts:178` | **已修正**：明确剥离的元数据文件与根级 `problem.yaml`/`evaluate.py` 契约 |
| `object-storage-governance.md` | 相对链接 `../../../dev-docs/engineering/object-storage-governance.json` 指向 VitePress 源目录（`noj-docs/docs`）之外，在构建产物与线上站点中不可达 | 仓库结构：`dev-docs/` 与 `noj-docs/docs/` 平级；该相对路径在站点 URL 下解析为 `/dev-docs/...`（404） | **已修正**：改为 GitHub 绝对链接 |
| `object-storage-governance.md` | 告警指标仅以行内代码串列，指标含义需读者自行推断 | `noj-core/src/domains/system/services/storage/audit.ts:150-179` `renderStorageAuditPrometheus()` 的 6 个 gauge | **已修正**：改为指标-含义表格 |
| `object-storage-governance.md` | `data/storage/` 未标注是 local provider 默认目录且可被 `SUPPORT_PACKAGE_DIR` 覆盖 | `local.ts:91` `Deno.env.get("SUPPORT_PACKAGE_DIR") ?? "data/storage"` | **已修正**：补充默认目录与覆盖变量 |
| `architecture.md` | 模块清单缺 `noj-lmcc-extension` 与 `noj-cli`；基础设施未给组件用途表 | 根 `AGENTS.md` §3 目录结构与模块表 | **已修正**：补两模块，基础设施改表格并新增 Mermaid 架构图 |
| `index.md` | 仅罗列 4 个链接，未给出阅读顺序，且遗漏 `object-storage-governance.md` | 侧边栏 `noj-docs/docs/.vitepress/config.ts:166-171` 含 5 个子页 | **已修正**：列全 5 页并给阅读顺序与定位 |
| 全组 | 多处数值无来源，默认值漂移风险（本次核对**未发现**与源码冲突的数值） | JWT HS256/24h：`identity/services/security/jwt.ts:73,79`、`settings-registry.ts:196-203`；bcrypt 12：`identity/services/security/password.ts:10`；ZIP 1000/64MiB/512MiB：`noj-judge/src/sandbox/container.rs:9-13`；容器安全项：`noj-judge/src/sandbox/host_config.rs:34-40`；审计保留 90 天：`settings-registry.ts:944-947`；`ANTI_CHEAT_IP_RETENTION_DAYS` 180：`:956-961` | 保持数值，但改为表格汇总并注明"默认值，以源码/注册表为准" |

### 已核实无漂移的关键断言（未改动或仅措辞调整）

- 容器安全项 `cap_drop ALL` / `no-new-privileges` / `network_mode none` / `ipc_mode none` / `pids_limit 256` 全部与 `noj-judge/src/sandbox/host_config.rs:34-40` 一致；`readonly_rootfs` + tmpfs 见 `noj-judge/src/dual/container.rs:198-207`。
- ZIP 限额 1000 / 64 MiB / 512 MiB 与 `noj-judge/src/sandbox/container.rs:9-13` 一致。
- 题目可见性判定顺序 `admin → owner → 竞赛上下文（不回退 public）→ visibility` 与 `noj-core/src/domains/catalog/services/problem-access.ts:51-63` 逐字一致。
- `verifyContestAccess` 的"题目属于竞赛 + 参赛者 + running/ended"与 `noj-core/src/domains/contest/services/contest-access.ts:40-60` 一致。
- 竞赛创建权限（public 仅管理员、invite 必须邀请码）与 `contests.ts:384-393` 一致。
- 风控接口只返回用户/题目/语言/状态/时间，不含邮箱/源码/输出，与 `contest-anti-cheat.ts:85-100` 一致。
- `storage.md` 的 `noj-storage://` / `noj-download://` 格式与 `storage/types.ts:168-169,239-240,290-336` 一致。

---

## 可读性改进

| 页面 | 改动 | 理由 |
| --- | --- | --- |
| `index.md` | 加导语 + 编号阅读顺序 + `::: tip`（运维请走 CLI） | 原为裸链接列表，读者不知从何读起，也易把"设计说明"当"操作手册" |
| `architecture.md` | 加一句导语；新增 Mermaid 架构图；模块职责、基础设施改表格；补 `::: info` 单一事实源 | 原页全是段落，缺图；读者难一眼建立模块关系 |
| `security.md` | 顶部「安全基线速览」表格；新增「认证与密码细节」「容器与 ZIP 隔离」小节与限制项表格；`warning`（可信代理）、`tip`（会话撤销）、`danger`（不要放宽沙箱）、`info`（客观题防泄露） | 原文 7 条无结构列表，安全红线不突出；容器与 ZIP 细节无处安放 |
| `storage.md` | 两层 URL 改表格（模式/示例/key 或适用场景）；`warning`（内联 base64 受 16 MiB 约束）、`danger`（生产独立 S3 凭据）、`info`（128 MiB 上限）、`tip`（样例题边界） | 原文示例块多、并列信息未对齐；关键限制散落正文 |
| `object-storage-governance.md` | 指标改表格；`danger`（orphan 不可直接删）、`warning`（先确认目标环境 / 暂停回收条件）、`info`（路径区分） | 只读盘点的"不可逆"风险需要显式危险容器 |
| `anti-cheat.md` | 加导语与「设计立场」`info`；第一节改「用途/可见范围/保留策略」结构化要点；`warning`（保留期合规上限、相似度是线索非判罚）；相似度参数改无序要点 | 原页两节过短、重点（"不等于作弊"）埋没在段落中 |
| 全组 | 统一"默认值以源码/注册表为准"的说明；行内 `code` 标注变量/字段/端点 | 降低读者把文档默认值当绝对值的风险 |

容器使用统计（改后，每页 2–5 个，符合 RUBRIC）：`index` 1、`architecture` 1、`security` 4、`storage` 4、`object-storage-governance` 4、`anti-cheat` 3。

---

## 视觉评价

截图（1440 宽，含改前/改后对比）位于 `/tmp/opencode/audit-shots/system/`。

- **改前**：`architecture` 仅 4 行正文 + 一段列表，页面大面积留白，无图无表，信息密度严重偏低；`security` 虽有表格但顶部 7 条列表无层次，红线不突出；`anti-cheat`、`index` 是"一堵墙/一串链接"，无视觉锚点；`storage`、`object-storage-governance` 以代码块为主，并列信息未对齐。
- **改后**：
  - `architecture` Mermaid 图渲染正常，按「客户端 / 服务端 / 评测 / 基础设施」分组后在 1440px 下布局清晰、箭头不再交叉；模块与基础设施表格扫读顺畅。
  - `security` 顶部速览表 + 黄/绿/红三种容器形成明确的"警告—推荐—危险"层次，长页有了明显的节奏。
  - `storage`、`object-storage-governance` 的两层 URL / 指标表格显著降低扫读成本，警告与危险容器位置恰当（不滥用）。
  - `anti-cheat` 从"两段短文"变为结构清晰的三段式，设计立场与合规警告得到强调。
- **剩余视觉小问题**：`object-storage-governance`「对象类型与引用」表与 `security`「题目可见性」表的"取值"列因内容较长出现换行（`private` 被折成两行），属 VitePress 默认表格宽度行为，不影响可读性；如追求极致可后续加 `min-width`，本次不改主题/样式。

---

## 遗留问题 / 建议

1. **跨页重叠**：`system/storage.md` 与 `operators/storage.md` 内容有交叉（本次仅改 `system/` 那份）。建议由编排者确认两者定位（面向主题 vs 操作手册），避免同一事实两处维护。
2. **跨页指标**：`operators/observability.md:27` 引用了 `storage:audit --prometheus-output`，本页（`object-storage-governance.md`）已补齐指标表；两页对指标的解释口径应保持一致，归 `operators` 组核对。
3. **能力联网交叉**：`security.md` 提到"LLM 题由题目配置显式开启 evaluator 联网"（证据 `noj-judge/src/dual/mod.rs:334-344`、`noj-judge/src/config.rs:167` `JUDGE_ALLOW_EVALUATOR_NETWORK`/`JUDGE_EVALUATOR_NETWORK`）。更完整的联网能力说明在 `mechanisms/capability-networking.md`，本组未越界修改，建议核对其与本页口径一致。
4. **`is_public` 与 `kind` 解耦**：源码将 `is_public` 完全派生自 `kind`，但 DB schema 仍保留 `is_public` 列且 `contests` 表定义 `default(true)`。文档已按运行时行为描述；若未来恢复 `is_public` 可独立设置，需同步更新 `security.md`。
5. **相似度算法文档缺口**：管理后台「相似提交」已是正式功能，但用户/运营文档尚无算法与申诉流程说明（`contest-similarity.ts` 仅为源码注释）。建议单开页面或在 `operators` 补充，需人拍板。
6. **`data/storage` 与 `data/packages` 术语**：`object-storage-governance.md` 已区分，但 `noj-core/.env.example:140-141` 注释仍写"默认 data/support-packages"（与 `local.ts` 实际的 `data/storage` 不一致）。属源码注释漂移，**未越界修改源码**，建议由 core 组修正。
