# features（面向主题 → 功能主题）文档审计报告

> 审计日期：2026-09-24　审计范围：`noj-docs/docs/features/`
> 规范：[RUBRIC.md](./RUBRIC.md)（含第四节「接口语义必须先取证再落笔」硬约束）
> 事实源：`noj-core/src/domains/**`、`noj-ui/pages|components|composables|utils`

## 范围

| 文件 | 改前行数 | 改后行数 |
|---|---:|---:|
| `features/index.md` | 11 | 13 |
| `features/ranking.md` | 30 | 52 |
| `features/search-messages.md` | 29 | 53 |
| `features/community.md` | 42 | 49 |
| `features/contests.md` | 37 | 83 |
| `features/trainings.md` | 26 | 40 |
| `features/announcements.md` | 19 | 26 |
| `features/objective.md` | 31 | 41 |

## 正确性发现

| 位置 | 问题 | 证据（路径 + 符号） | 处置 |
|---|---|---|---|
| `ranking.md`（全组） | 非法容器 `::: note`（VitePress 无 `note` 类型，会被渲染成字面文本，截图已证实：页面出现 `::: note 时间提示`） | VitePress 官方容器仅 `tip/info/warning/danger/details`；截图 `ranking-before.png` | **已修正** 为 `::: tip` |
| `ranking.md` 榜单规则 | 缺少「root 系统账号不计入」「通过率 / 提交数作为排序键」的完整口径 | `noj-core/src/domains/query/services/rankings.ts` `getGlobalRankings`：`WHERE u.id <> '0'`、`ROW_NUMBER() OVER (ORDER BY solved_count DESC, acceptance_rate DESC, total_submissions ASC, u.created_at ASC)` | **已修正**（补表格与上榜条件） |
| `ranking.md` 榜单延迟 | 未说明物化视图带来数秒滞后 | `rankings.ts` `refreshRankingsView`：`RANKING_REFRESH_INTERVAL_MS = 5000`，`REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings` | **已修正**（新增 tip） |
| `ranking.md` 签到历史入口 | 原文「用户可在签到卡片查看……最近签到历史（30/90/365 天）」不准确：首页签到卡只显示连续天数；30/90/365 是接口参数，界面在**用户主页活跃度**固定用 365 天 | `noj-ui/pages/index.vue` + `CheckInCard.vue`（无 stats/history 调用）；`noj-ui/pages/users/[id].vue`：`/api/v1/checkin/stats?user_id=`、`/api/v1/checkin/history?days=365&user_id=`；`noj-core/src/domains/identity/routes/checkin.ts` `getCheckinHistory`（`HISTORY_DAYS_ALLOWED = {30,90,365}`） | **已修正**（区分卡片与主页） |
| `ranking.md` 签到活跃榜 | 原文称「签到活跃榜按月展示……可查看自己的当月排名」，暗示站点有该功能页面 | 服务端存在 `GET /api/v1/rankings/checkin`（`noj-core/src/domains/query/routes/rankings.ts`、`identity/services/checkin.ts` `getCheckinLeaderboard`），但全仓 UI 检索不到任何调用点（`nog-ui` pages/components/composables 均无 `rankings/checkin` / `user_rank`） | **已修正**：改为 `::: warning` 说明「服务端已具备、当前无独立页面」 |
| `search-messages.md` 实体类型 | 类型切换列表与实现一致（8 类），但未标注「用户仅管理员可搜」 | `noj-core/src/domains/search/routes/search.ts`：`ALL_TYPES`（problem/user/community_post/community_comment/contest/submission/message/announcement）；`if (typeParam === "user" && !isAdmin) → ForbiddenError` | **已修正**（新增 warning） |
| `search-messages.md` 限制 | 未写 `q` 长度 2–100、限流、响应头 | `search.ts`：`q.length < 2 / > 100` 抛 `ValidationError`；`middleware/search-rate-limit.ts` `searchRateLimit("auto")`；`settings-registry.ts` `rate_limit_search_*`（窗口 30s、匿名 60、登录 120） | **已修正**（新增 warning/info） |
| `search-messages.md` 会话预览 | 原文「消息预览（50 字截断）」，实际还有图片与已撤回两种特殊预览 | `noj-core/src/domains/messaging/services/messages.ts`：`PREVIEW_LENGTH = 50`、`msg.recalled_at ? "[已撤回]" : msg.type === "image" ? "[图片]"` | **已修正**（补注） |
| `contests.md` 全页 | 未说明 `kaggle` 为**唯一**赛制常量，也未列出邀请赛 / 公开赛的报名与可见性差异 | `noj-core/src/domains/contest/types/contests.ts`：`CONTEST_TYPES = ["kaggle"]`、`CONTEST_KINDS = ["public","invite"]`；`contests.ts` `createContest`（`public 仅管理员`、`invite 必须设邀请码`、`is_public = kind === "public"`） | **已修正**（新增「赛制与基本规则」「报名与参赛」表） |
| `contests.md` 榜单可见性 | 只描述「服务端封榜」，未列 `ranking_visibility` 三值 | `types/contests.ts`：`RANKING_VISIBILITIES = ["public","participants","hidden"]` | **已修正**（新增可见性表） |
| `contests.md` 封榜 | 未写 `freeze_start_time` 与 `freeze_duration_seconds` **只能二选一**；未写封榜期间 SSE 停止推送提交事件 | `contests.ts` `normalizeRankingPolicy`（「只能配置一个」）；`routes/sse.ts`：`isNonLiveView()` 时 `if (!isAdmin && isNonLiveView()) return` | **已修正**（新增 info） |
| `contests.md` 结算 | 原文「发布 #435 正式成绩快照」含无来源的 issue 编号，读者无法理解 | `contest-ranking.ts` `publishContestRankingSnapshot` / `getLatestContestRankingSnapshot`（快照版本、`status: ended`、评测清空门禁）；无 `#435` 相关符号 | **已修正**（去掉编号，改为「正式成绩快照」；`#435` 列入遗留问题） |
| `contests.md` 源码路径 | 「`services/contest/`」路径不存在 | 实际为 `noj-core/src/domains/contest/services/` | **已修正** |
| `contests.md` 访问时机 | 原文「结束后所有登录用户可查看竞赛页」不准确：邀请赛结束后对非参赛者仍 404 | `routes/contests.ts` `GET /:id`：`if (!data.is_public && !admin && !data.is_registered) throw NotFoundError` | **已修正** |
| `trainings.md` 可见性 | 未说明 `public` 仅 `training:publish` 可设（权限表述笼统） | `noj-core/src/domains/catalog/services/trainings.ts`：`createTraining`（创建只能 private/unlisted）、`updateTraining`（`visibility === "public" && !canPublish → ForbiddenError`） | **已修正**（新增权限列与 warning） |
| `trainings.md` 加入题单 | 未写「只能加入公开题或自己的题」限制 | `trainings.ts` `addTrainingProblem`：`!isAdmin && problem.visibility !== "public" && problem.owner_id !== actorId → ForbiddenError` | **已修正**（新增 tip） |
| `announcements.md` 横幅 / 轮播 | 未提及 `banner_text`（导航栏横幅）与首页轮播（`carousel_slides`）已解耦 | `noj-core/src/domains/system/services/announcements.ts` `getLatestBannerAnnouncement`；`noj-core/src/domains/system/services/carousel.ts`；`noj-ui/pages/index.vue` 注释「轮播与公告已解耦」 | **已修正**（新增 info 与 banner_text 说明） |
| `announcements.md` 删除语义 | 原文「删除公告」未说明是物理删除 | `announcements.ts` `deleteAnnouncement`（`db.delete`） | **已修正** |
| `objective.md` 练习/竞赛提交 | 未说明「练习可重复、竞赛同一竞赛内只允许一次」 | `noj-core/src/domains/objective/services/objective-submissions.ts` `validateContestSubmission`（「只允许提交一次」） | **已修正**（新增 warning） |
| `objective.md` 解析门控 | 「练习模式提交后立即返回……解析（如有）」未区分公开 / 私有套卷 | `objective-submissions.ts` `submitObjectivePaper`：公开卷 `withExplanation(..., true)`，私有卷 `false`（剥离 `expected`） | **已修正**（新增 info） |
| `objective.md` 题型表格 | 判定列可补充（多选顺序无关、集合匹配） | `objective-judge.ts` `judgeQuestion`：`normalizeAnswer`（`sort()`）→ 集合比较 | **已修正**（表格加判定列） |
| `community.md` 举报状态 | 「resolved / dismissed」表述正确，已保留 | `community-moderation.ts`：状态过滤 `pending/resolved/dismissed/all` | 保留（无需改） |
| `community.md` 内容合规 | 原文「不影响正常发布」正确；补强为独立容器 | `community-review.ts` `reviewUgcContent`（`review` 分支放行转人工） | **已改进** |
| 全组 | 无其他非法容器（`:::` 均已配对且首 token 合法） | `grep -c` 校验 open/close 全部 1:1；首 token ∈ {tip,info,warning} | 已扫描 |

## 可读性改进

| 页面 | 改动 | 理由 |
|---|---|---|
| `index.md` | 无序列表 → 两列表格（主题 / 内容摘要） | 让「功能主题」总览一眼可扫读 |
| `ranking.md` | 排序口径改为 4 行表格；新增 intro 与 4 个容器（info / tip / tip / warning） | 排序键与方向并列信息更适合表格；把「上榜条件」「延迟」「时区」「活跃榜缺失」做成容器 |
| `search-messages.md` | 新增「入口对照」表；搜索限制 / 限流 / 私信审核做成容器；预览补注 | 命令面板 vs 结果页的差异此前埋在括号里，改表格更清晰 |
| `community.md` | 内容合规、门槛与赛期门控做成容器；补「回复一级评论」；私信段落改为交叉链接 | 减少与 `search-messages.md` 的重复；突出「会踩坑」的发布门槛 |
| `contests.md` | 大改：新增「赛制与基本规则」「报名与参赛」表、「榜单可见性」表、封榜 info、两份 warning；`运营者` 列表加粗小标题 | 原文把规则、限制、状态混在长段落里；拆分后赛制与可见性可扫读 |
| `trainings.md` | 可见性表加「谁可以设置」列；创建流程改为编号步骤；进度表列「已完成条件」 | 权限差异是读者最容易踩坑的地方，放表格第一眼可见 |
| `announcements.md` | 新增轮播 / 公告解耦 info；`banner_text` 与物理删除说明 | 读者常把首页轮播当成公告的一部分 |
| `objective.md` | 题型表加「判定」列；练习 / 竞赛规则做成 warning；解析门控做成 info | 区分两类提交规则与可见性，避免误以为竞赛可反复提交 |
| 全组 | 每页新增 1–2 句「本页讲什么」导语 | 功能文档偏能力说明，导语降低进入成本 |

## 视觉评价

截图落盘：`/tmp/opencode/audit-shots/features/`（改前 `*-before.png`、改后 `*-after.png`，
无头 Chrome 1440×2200/2400、`--virtual-time-budget=12000`）。

- **改前 `ranking-before.png`**：确认了 `::: note` 坏块 —— 页面底部直接显示
  `::: note 时间提示 北京时间 0:00–8:00 …… :::` 的**字面文本**，容器语法完全失效。
  该页其余部分为连续要点列表，无层次，信息密度尚可但缺少重点锚点。
- **改后 `ranking-after.png`**：坏块已消失，时间提示渲染为绿色 tip 卡片；
  排序口径表格 + info 上榜条件 + warning「活跃榜暂无入口」形成清晰的扫读路径。
  容器使用 4 个，页内分布均匀，未出现「满屏彩块」。
- **改后 `contests-after.png`**：新增赛制表、报名表、可见性表与 3 个容器后，页面从
  「一堵文字」变为分段式结构；表格宽度与正文一致，未溢出。唯一偏密处是「做题人」
  段落仍较长，但已按 `###` 拆为榜单可见性 / 封榜两节。
- **改后 `search-messages-after.png` / `community-after.png` / `objective-after.png`**：
  表格 + 容器组合层次清晰；`community` 通过交叉链接减少私信重复后更聚焦。
- 总体：本组容器数从 2 提升至 17（7 页，每页 2–4 个），符合 RUBRIC「每页 2–5 个」，
  未见滥用；所有容器顶格、成对闭合，渲染无异常。

## 遗留问题 / 建议

1. **签到活跃榜无 UI 入口**：`GET /api/v1/rankings/checkin` 与 `getCheckinLeaderboard`
   已完整实现并有测试，但 UI 无任何调用点。建议产品确认是「暂缓上线」还是「遗漏入口」；
   若上线，`features/ranking.md` 的 warning 可改回正向描述。
2. **`contests.md` 的「#435」**：原文引用的 issue 编号在源码中查无对应符号，已删除；
   若确有对应 issue，请补充链接。
3. **`users/search-messages.md`、`users/ranking.md` 均为占位页**（内容仅一句「已迁移至功能主题」），
   与 `features/` 对应页存在标题重复。属跨页（`users/*`）问题，未越界修改；建议
   统一为「重定向说明」样式或从侧边栏移除。`objective` / `community` / `contests` / `trainings` /
   `announcements` 在 `users/` 侧无同名占位页，重复面较小。
4. **`contests.md` 的榜单可见性 + 进行中排名语义**：`getContestRankingView` 在
   `running` 且榜单非公开时对普通用户**只返回本人行**；当前文档以「进行中排名不一定是完整
   公开榜」概括。若产品希望明确告知「你可能只看到自己」，可进一步取证后加注。
5. **`trainings.md` 题目可见性**：题单内题目对非 owner 会过滤掉非公开题
   （`listTrainingProblems` 的 `visibleRows`），当前文档未展开。可作为后续补充点。
6. **`objective.md` 与 `contests.md` 的竞赛提交交集**：客观题竞赛提交的「只允许一次」
   与编程题竞赛提交的次数上限（`submission_limits`）规则不同，两页现已分别说明，
   但仍存在概念交叉，建议后续在 `contests.md` 里补一句指向 `objective.md`。
