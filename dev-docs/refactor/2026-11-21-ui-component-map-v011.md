# noj-ui 组件目录重组与重命名映射（v0.11）

| 项 | 值 |
| --- | --- |
| 状态 | **已执行**（2026-11-21；迁移 + 引用改写 + 显式 dirs + 结构文档；check / 组件测试 / build / 链接检查通过） |
| 日期 | 2026-11-21 |
| 执行结果 | 移动 89 个路径（纯移动 34、仅改名 28、移动+改名 27）、改写 130 个文件；147 个组件全部出现在 `.nuxt/components.d.ts` |
| 分支 | `refactor/ui-component-dirs`（基于 `main`；起始工作区干净，本轮只新增本文档与脚本） |
| 范围 | `noj-ui/components/**`（147 个 `.vue`）+ 引用点 + `nuxt.config.ts` + `noj-ui/docs/structure.md`；`noj-ui/AGENTS.md` 内容不动 |
| 不改 | `pages/` URL、`composables/` 文件名、`layouts/`、后端与文档站 |
| 前置 | `nuxt.config.ts:131-133` 为 `dirs: [{ path: '~/components', pathPrefix: false }]`，目录不参与组件名 |
| 输入 | `.dsh/tmp/map-decisions.json` 72 条；rc0.10 映射表 71 条命中（去重后 70 条）；本表补录 5 条（§5.2） |
| 相关 | rc0.10 映射表 `dev-docs/refactor/2026-10-24-ui-component-map.md`、Agent Note `2026-10-24-ui-component-directory.md`、脚本 `scripts/oneoff/rename-ui-components-v011.ts` |

> 命名公式：**领域（出现的地方）+ 功能**。目录只做归档，组件名必须自带领域前缀，保证全局唯一。
> 本表是唯一权威清单；脚本 `scripts/oneoff/rename-ui-components-v011.ts` 只按本表执行，不自行推断。
> 本表 147 行覆盖磁盘上全部 147 个组件；其中 5 条输入缺口在 §5.2 单独标注。

---

## 1. 规则

### 1.1 通用规则（R1–R7，沿用 rc0.10）

| 编号 | 规则 |
| --- | --- |
| R1 | 组件名 = `PascalCase`，领域目录内的组件**必须**以领域词开头（`problem/ProblemCard.vue`）。 |
| R2 | 新名字必须全局唯一；`legacy/` 不参与自动导入，不占用组件名。 |
| R3 | 只有 `base/`、`shared/`、`layout/` 豁免领域前缀（直接用功能名）；`education/` 为第三个豁免目录（见 D2）。 |
| R4 | 后缀语义：`*Modal` 业务弹窗、`*Drawer` 侧边抽屉、`*Section` 页面区块、`*Panel` 可操作面板、`*Card` 可点击卡片、`*Badge` 状态/标识、`*Banner` 横幅、`*Skeleton` 骨架屏。 |
| R5 | 拼写统一：`Checkin`（不再出现 `CheckIn`），与后端 `/api/v1/rankings/checkin` 对齐。 |
| R6 | 目录名用单数、小写单词（`problem/`、`submission/`），子域用短横线或单词（`problem/ui/`）。 |
| R7 | `components.dirs` 改为**显式目录清单**（见 §9.2），新目录必须登记，未登记不会被自动导入。本轮只记录目标配置，不动 `nuxt.config.ts`。 |

### 1.2 v0.11 追加判定（D1–D4）

| 编号 | 判定 | 说明 |
| --- | --- | --- |
| D1 | 29 个 `Domain*` 一律拆掉 `Domain`，按所属领域改名 | 例：`DomainProblemVersions` → `problem/ProblemVersions`；`editor/` 内全部变 `Editor*`。数量为本分支实测（不是 33，见 §5.4）。 |
| D2 | `education/` 是第三个豁免目录（同 `base/`/`shared/`/`layout/`） | 内部保留 `Assignment*`/`Classroom*`/`Student*` 子前缀，不强行加 `Education`。19 个组件全部原地。 |
| D3 | `workspace/` 内 `Domain*` → `Workspace*` | 例：`DomainHomeContent` → `WorkspaceHomeContent`；`InvitationManager` 补 `Workspace` 前缀。 |
| D4 | 新开 `announcements/` 收公告组件；`AnnouncementBanner` 留在 `layout/` | `AnnouncementBanner` 是全局框架横幅，不属于公告业务域（同 `BanBanner`、`EmailVerificationBanner`）。 |

---

## 2. 目标目录树

```text
noj-ui/components/
├── base/             10  无业务语义的原子件
├── shared/            4  跨领域业务件
├── layout/            9  全局框架、全局横幅与通知
├── home/              3  首页区块
├── problem/          22  题目域（不含下面两个子目录）
│   ├── objective/     2  客观题
│   └── ui/            2  界面题
├── submission/       12  提交、评测结果与队列
├── contest/           3  竞赛
├── training/          2  题单
├── community/         8  社区
├── ranking/           4  榜单与签到
├── search/            2  搜索
├── auth/              3  认证
├── legal/             1  合规
├── editor/           13  出题编辑器
├── admin/            14  后台骨架
├── education/        19  教务（作业/班级/学生）
├── knowledge/         4  知识图谱
├── workspace/         6  工作空间
├── announcements/     4  公告
└── legacy/            0  保留目录，不登记自动导入（本分支无冻结项）
```

合计 147。`problem/` 的 22 不含 `problem/objective/` 与 `problem/ui/`。
本分支没有 `dev/lab/` 目录（`utils/labRegistry.ts` 也不存在），v0.11 不再保留该目录。

---

## 3. 映射表

路径省略 `noj-ui/components/` 前缀。动作：**原地**／**移动**／**改名**／**移动+改名**／**冻结**。
标签名 = 文件名去掉 `.vue`（`pathPrefix: false`），改名项同时改变模板标签。

### 3.1 base/（10）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `ui/AnimatedCounter.vue` | `base/AnimatedCounter.vue` | 移动 |
| `ui/AsyncContent.vue` | `base/AsyncContent.vue` | 移动 |
| `ui/DialogModal.vue` | `base/DialogModal.vue` | 移动 |
| `card/LiveElapsed.vue` | `base/LiveElapsed.vue` | 移动 |
| `shared/MarqueeTitle.vue` | `base/MarqueeTitle.vue` | 移动 |
| `shared/PaginationNav.vue` | `base/PaginationNav.vue` | 移动 |
| `editor/ResizableSplitter.vue` | `base/ResizableSplitter.vue` | 移动 |
| `ui/TableSkeleton.vue` | `base/TableSkeleton.vue` | 移动 |
| `ui/ToastBanner.vue` | `base/ToastBanner.vue` | 移动 |
| `shared/ZipDropZone.vue` | `base/ZipDropZone.vue` | 移动 |

### 3.2 shared/（4）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `shared/LibraryPageHeader.vue` | 同左 | 原地 |
| `shared/MarkdownEditor.vue` | 同左 | 原地 |
| `shared/MarkdownRenderer.vue` | 同左 | 原地 |
| `shared/UserIdentity.vue` | 同左 | 原地 |

### 3.3 layout/（9）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/AccountNotifications.vue` | `layout/AccountNotifications.vue` | 移动 |
| `layout/AnnouncementBanner.vue` | 同左 | 原地 |
| `BanBanner.vue` | `layout/BanBanner.vue` | 移动 |
| `shared/BrandLogo.vue` | `layout/BrandLogo.vue` | 移动 |
| `layout/BreadcrumbNav.vue` | 同左 | 原地 |
| `EmailVerificationBanner.vue` | `layout/EmailVerificationBanner.vue` | 移动 |
| `layout/FooterBar.vue` | 同左 | 原地 |
| `layout/Navbar.vue` | 同左 | 原地 |
| `layout/UserMenu.vue` | 同左 | 原地 |

### 3.4 home/（3）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/HomepageCheckIn.vue` | `home/HomeCheckinPanel.vue` | 移动+改名 |
| `feature/LatestSubmissions.vue` | `home/HomeLatestSubmissions.vue` | 移动+改名 |
| `feature/StatsToggle.vue` | `home/HomeStatsToggle.vue` | 移动+改名 |

### 3.5 problem/（22）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/DomainProblemAnswer.vue` | `problem/ProblemAnswer.vue` | 移动+改名 |
| `problem/ProblemAnswerPanel.vue` | 同左 | 原地 |
| `feature/DomainProblemBindingEditor.vue` | `problem/ProblemBindingEditor.vue` | 移动+改名 |
| `feature/DomainProblemChooser.vue` | `problem/ProblemChooser.vue` | 移动+改名 |
| `problem/ContestHiddenMark.vue` | `problem/ProblemContestHiddenMark.vue` | 改名 |
| `problem/ProblemContestNotice.vue` | 同左 | 原地 |
| `ui/DifficultyBadge.vue` | `problem/ProblemDifficultyBadge.vue` | 移动+改名 |
| `feature/ProblemFilterBar.vue` | `problem/ProblemFilterBar.vue` | 移动 |
| `problem/ProblemHeader.vue` | 同左 | 原地 |
| `ui/ProblemId.vue` | `problem/ProblemIdBadge.vue` | 移动+改名 |
| `problem/ProblemMetaCard.vue` | 同左 | 原地 |
| `problem/MySubmissionCard.vue` | `problem/ProblemMySubmissionCard.vue` | 改名 |
| `problem/OfficialSolutionEntry.vue` | `problem/ProblemOfficialSolutionEntry.vue` | 改名 |
| `problem/ProblemReference.vue` | 同左 | 原地 |
| `problem/ProblemSamples.vue` | 同左 | 原地 |
| `feature/DomainSelfTestPanel.vue` | `problem/ProblemSelfTestPanel.vue` | 移动+改名 |
| `problem/DomainProblemSolutions.vue` | `problem/ProblemSolutions.vue` | 改名 |
| `problem/ProblemStatement.vue` | 同左 | 原地 |
| `problem/DomainProblemSubmissions.vue` | `problem/ProblemSubmissions.vue` | 改名 |
| `feature/DomainProblemVersions.vue` | `problem/ProblemVersions.vue` | 移动+改名 |
| `feature/DomainProblemVersionSelect.vue` | `problem/ProblemVersionSelect.vue` | 移动+改名 |
| `problem/DomainProblemWorkspace.vue` | `problem/ProblemWorkspace.vue` | 改名 |

### 3.6 problem/objective/（2）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `objective/ObjectiveQuestionForm.vue` | `problem/objective/ObjectiveQuestionForm.vue` | 移动 |
| `objective/ObjectiveRichText.vue` | `problem/objective/ObjectiveRichText.vue` | 移动 |

### 3.7 problem/ui/（2）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `uiproblem/UiFrame.vue` | `problem/ui/UiProblemFrame.vue` | 移动+改名 |
| `feature/DomainUiRuns.vue` | `problem/ui/UiProblemRuns.vue` | 移动+改名 |

### 3.8 submission/（12）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `submission/ArtifactDownload.vue` | `submission/SubmissionArtifactDownload.vue` | 改名 |
| `card/SubmissionCard.vue` | `submission/SubmissionCard.vue` | 移动 |
| `submission/SubmissionCaseResults.vue` | 同左 | 原地 |
| `submission/OwnSubmissionRecord.vue` | `submission/SubmissionOwnRecord.vue` | 改名 |
| `submission/OwnSubmissionSummary.vue` | `submission/SubmissionOwnSummary.vue` | 改名 |
| `feature/QueueRow.vue` | `submission/SubmissionQueueRow.vue` | 移动+改名 |
| `submission/DomainRejudgeAction.vue` | `submission/SubmissionRejudgeAction.vue` | 改名 |
| `submission/DomainSubmissionResult.vue` | `submission/SubmissionResult.vue` | 改名 |
| `ui/SubmissionResult.vue` | `submission/SubmissionStatusBadge.vue` | 移动+改名 |
| `submission/DomainSelfTestResult.vue` | `submission/SubmissionSelfTestResult.vue` | 改名 |
| `submission/DomainSubmissionStatus.vue` | `submission/SubmissionStatus.vue` | 改名 |
| `submission/DomainUpgradeAction.vue` | `submission/SubmissionUpgradeAction.vue` | 改名 |

> C1 已裁决：面板占 `SubmissionResult`，内联胶囊改 `SubmissionStatusBadge`（见 §5.1）。两条不再撞名。

### 3.9 contest/（3）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/DomainContestAnswer.vue` | `contest/ContestAnswer.vue` | 移动+改名 |
| `feature/contest/ClarificationsPanel.vue` | `contest/ContestClarificationsPanel.vue` | 移动+改名 |
| `feature/DomainContestForm.vue` | `contest/ContestForm.vue` | 移动+改名 |

### 3.10 training/（2）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/training/DomainAddToTrainingMenu.vue` | `training/TrainingAddToMenu.vue` | 移动+改名 |
| `feature/DomainTrainingEditor.vue` | `training/TrainingEditor.vue` | 移动+改名 |

### 3.11 community/（8）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `admin/CommunityBoardsSection.vue` | `community/CommunityBoardsSection.vue` | 移动 |
| `feature/community/CommentCard.vue` | `community/CommunityCommentCard.vue` | 移动+改名 |
| `feature/community/CommunityIndex.vue` | `community/CommunityIndex.vue` | 移动 |
| `feature/community/CommunityManage.vue` | `community/CommunityManage.vue` | 移动 |
| `feature/community/CommunityNotificationDetail.vue` | `community/CommunityNotificationDetail.vue` | 移动 |
| `feature/community/CommunityPostDetail.vue` | `community/CommunityPostDetail.vue` | 移动 |
| `feature/community/CommunityReportDetail.vue` | `community/CommunityReportDetail.vue` | 移动 |
| `feature/community/ReportModal.vue` | `community/CommunityReportModal.vue` | 移动+改名 |

### 3.12 ranking/（4）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/CheckInCard.vue` | `ranking/CheckinCard.vue` | 移动+改名 |
| `checkin/CheckinContributionGraph.vue` | `ranking/CheckinContributionGraph.vue` | 移动 |
| `feature/ranking/CheckinLeaderboard.vue` | `ranking/CheckinLeaderboard.vue` | 移动 |
| `feature/ranking/RankBadge.vue` | `ranking/RankBadge.vue` | 移动 |

### 3.13 search/（2）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/search/SearchPalette.vue` | `search/SearchPalette.vue` | 移动 |
| `feature/search/SearchResultItem.vue` | `search/SearchResultItem.vue` | 移动 |

### 3.14 auth/（3）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `auth/AuthFormCard.vue` | 同左 | 原地 |
| `form/PasswordField.vue` | `auth/AuthPasswordField.vue` | 移动+改名 |
| `form/TextInput.vue` | `auth/AuthTextInput.vue` | 移动+改名 |

### 3.15 legal/（1）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `legal/LegalConsentModal.vue` | 同左 | 原地 |

### 3.16 editor/（13）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `editor/ActivityBar.vue` | `editor/EditorActivityBar.vue` | 改名 |
| `editor/DomainAiRuntime.vue` | `editor/EditorAiRuntime.vue` | 改名 |
| `editor/BundleImportPanel.vue` | `editor/EditorBundleImportPanel.vue` | 改名 |
| `editor/DomainCodeWorkspace.vue` | `editor/EditorCodeWorkspace.vue` | 改名 |
| `editor/DomainObjectiveQuestions.vue` | `editor/EditorObjectiveQuestions.vue` | 改名 |
| `editor/DomainOiFiles.vue` | `editor/EditorOiFiles.vue` | 改名 |
| `editor/DomainOiRuntime.vue` | `editor/EditorOiRuntime.vue` | 改名 |
| `editor/DomainProblemEditor.vue` | `editor/EditorProblemEditor.vue` | 改名 |
| `editor/EditorSidebar.vue` | 同左 | 原地 |
| `editor/EditorStatusBar.vue` | 同左 | 原地 |
| `editor/EditorToolbar.vue` | 同左 | 原地 |
| `editor/MonacoEditor.vue` | 同左 | 原地 |
| `editor/ProblemSampleEditor.vue` | 同左 | 原地 |

### 3.17 admin/（14）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `admin/AdminAccountDialogs.vue` | 同左 | 原地 |
| `admin/AdminCommandPalette.vue` | 同左 | 原地 |
| `feature/DomainCopyCatalog.vue` | `admin/AdminCopyCatalog.vue` | 移动+改名 |
| `admin/AdminDetailDrawer.vue` | 同左 | 原地 |
| `admin/AdminEditPanel.vue` | 同左 | 原地 |
| `admin/AdminFilterBar.vue` | 同左 | 原地 |
| `admin/AdminFormField.vue` | 同左 | 原地 |
| `admin/InstanceNav.vue` | `admin/AdminInstanceNav.vue` | 改名 |
| `feature/DomainLlmAliases.vue` | `admin/AdminLlmAliases.vue` | 移动+改名 |
| `admin/AdminPageHeader.vue` | 同左 | 原地 |
| `admin/RefreshControl.vue` | `admin/AdminRefreshControl.vue` | 改名 |
| `admin/SettingFieldInput.vue` | `admin/AdminSettingFieldInput.vue` | 改名 |
| `admin/AdminTable.vue` | 同左 | 原地 |
| `admin/AdminTopbar.vue` | 同左 | 原地 |

### 3.18 education/（19）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `education/AssignmentActions.vue` | 同左 | 原地 |
| `education/AssignmentCellSubmissions.vue` | 同左 | 原地 |
| `education/AssignmentConversation.vue` | 同左 | 原地 |
| `education/AssignmentCopy.vue` | 同左 | 原地 |
| `education/AssignmentDraftPreview.vue` | 同左 | 原地 |
| `education/AssignmentEditor.vue` | 同左 | 原地 |
| `education/AssignmentHelpThread.vue` | 同左 | 原地 |
| `education/AssignmentKnowledgePicker.vue` | 同左 | 原地 |
| `education/AssignmentMatrix.vue` | 同左 | 原地 |
| `education/AssignmentRemediation.vue` | 同左 | 原地 |
| `education/ClassroomContests.vue` | 同左 | 原地 |
| `education/ClassroomImport.vue` | 同左 | 原地 |
| `education/ClassroomJoinRequests.vue` | 同左 | 原地 |
| `education/ClassroomNavigation.vue` | 同左 | 原地 |
| `education/ContestRemediationBuilder.vue` | 同左 | 原地 |
| `education/RemediationSelection.vue` | 同左 | 原地 |
| `education/StudentTraining.vue` | 同左 | 原地 |
| `education/SubmissionAttemptHistory.vue` | 同左 | 原地 |
| `education/SubmissionReview.vue` | 同左 | 原地 |

### 3.19 knowledge/（4）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `knowledge/KnowledgeEditorPanel.vue` | 同左 | 原地 |
| `knowledge/KnowledgeNextLink.vue` | 同左 | 原地 |
| `knowledge/KnowledgePicker.vue` | 同左 | 原地 |
| `knowledge/KnowledgeTags.vue` | 同左 | 原地 |

> 这 4 条不在 `.dsh/tmp/map-decisions.json` 中，按 R1 推定「原地」，见 §5.2；不发生移动/改名。

### 3.20 workspace/（6）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/WorkspaceHero.vue` | `workspace/WorkspaceHero.vue` | 移动 |
| `workspace/DomainHomeContent.vue` | `workspace/WorkspaceHomeContent.vue` | 改名 |
| `workspace/InvitationManager.vue` | `workspace/WorkspaceInvitationManager.vue` | 改名 |
| `workspace/WorkspaceLimitFields.vue` | 同左 | 原地 |
| `workspace/WorkspaceSettingsForm.vue` | 同左 | 原地 |
| `workspace/DomainSettingsShell.vue` | `workspace/WorkspaceSettingsShell.vue` | 改名 |

### 3.21 announcements/（4）

| 旧路径 | 新路径 | 动作 |
| --- | --- | --- |
| `feature/AnnouncementDetail.vue` | `announcements/AnnouncementDetail.vue` | 移动 |
| `feature/AnnouncementList.vue` | `announcements/AnnouncementList.vue` | 移动 |
| `admin/AnnouncementManager.vue` | `announcements/AnnouncementManager.vue` | 移动 |
| `feature/AnnouncementSection.vue` | `announcements/AnnouncementSection.vue` | 移动 |

### 3.22 legacy/（0）

本分支没有需要冻结的组件；`legacy/` 只保留目录约定，不登记自动导入（R2/R7）。

### 3.23 统计

| 动作 | 数量 |
| --- | ---: |
| 原地 | 58 |
| 纯移动 | 34 |
| 仅改名 | 28 |
| 移动+改名 | 27 |
| 冻结 | 0 |
| **合计** | **147** |

> 统计为 C1 裁决后的最终口径：`DomainSubmissionResult` 占 `SubmissionResult`（改名），
> 原 `ui/SubmissionResult` 胶囊改 `SubmissionStatusBadge`（移动+改名）。

---

## 4. 命名例外（E1–E10）

| 编号 | 例外 | 原因 |
| --- | --- | --- |
| E1 | `NojPageHeader`（尚未创建，计划中） | 页面骨架统一抬头，唯一 `Noj` 前缀特例，来自 #639；本分支还没有这个组件。 |
| E2 | `editor/ProblemSampleEditor` 保留现名 | `EditorProblemSampleEditor` 冗长；D1 已把 `DomainProblemEditor` 改为 `EditorProblemEditor`，两者靠 `Sample` 区分。 |
| E3 | `editor/MonacoEditor` | 专有名词，`EditorMonacoEditor` 无意义。 |
| E4 | `RankBadge` / `CheckinLeaderboard` / `CheckinCard` / `CheckinContributionGraph` | 功能词已含域词，`RankingRankBadge`、`RankingCheckinLeaderboard` 重复。 |
| E5 | `dev/lab/` 内统一 `Lab` 前缀（规则保留） | 本分支无该目录；若以后恢复，子域前缀不叠加 `DevLab`。 |
| E6 | `problem/ui/` 用 `UiProblem` 前缀 | `UiFrame` 太泛、`ProblemUiFrame` 语序倒置。 |
| E7 | `layout/BanBanner` 保留现名 | 语义为「封禁横幅」；如需更明确可改 `AccountBanBanner`，本轮不动。 |
| E8 | `education/` 内部子前缀（`Assignment*`/`Classroom*`/`Student*`/`ContestRemediation*`/`Remediation*`/`Submission*`） | D2：教务域按子域分文件；统一 `Education` 前缀会得到 `EducationAssignmentMatrix` 这类长名，且无法区分作业/班级/学生三条线。 |
| E9 | `problem/objective/` 用 `Objective*` 前缀 | 客观题是题目子域；`ProblemObjectiveQuestionForm` 重复。 |
| E10 | `layout/AnnouncementBanner` 留 `layout/` | D4：它是全局框架横幅（同 `BanBanner`、`EmailVerificationBanner`），不属于公告业务域。 |

---

## 5. 冲突与未覆盖项

### 5.1 C1：`SubmissionResult` 目标撞名（已裁决：面板占名，胶囊改 `SubmissionStatusBadge`）

两个职责不同的组件曾按 D1 落到同一路径；裁决后的最终路径：

| 源文件 | 大小 | 行数 | 最终路径 | 角色 |
| --- | ---: | ---: | --- | --- |
| `submission/DomainSubmissionResult.vue` | 7,630 B | 104 | `submission/SubmissionResult.vue` | 详情页的**整块评测结果面板** |
| `ui/SubmissionResult.vue` | 1,369 B | 41 | `submission/SubmissionStatusBadge.vue` | 列表行内的**内联状态胶囊** |

裁决理由：R4 的 `*Badge` 是「状态/标识」，`*Panel` 是「可操作面板」；胶囊不可操作，
且 `Pill` 在本仓没有先例，因此胶囊取 `SubmissionStatusBadge`。

**两个文件的前 30 行要点（裁决依据）**

- `ui/SubmissionResult.vue`（41 行）：模板 1–18 行是单个 `<span>`，三种分支——有结果时按 `getStatusColor`/`getStatusLabel` 上色显示判定，`queue_position != null` 显示「等待评测」，否则显示「评测中」；script 20–41 行只有一个 `Props`（`status: string`、`result: { status: string } | null`、`queue_position?: number | null`）和两个 `computed`。无副作用、无数据请求，是纯展示原子件，对应 `*Badge`。
- `submission/DomainSubmissionResult.vue`（104 行）：script 1–28 行接收 `submission: DomainSubmission`，派生 `visible`（`result_visibility !== 'hidden'`）、`oi`、`verdict`、`summary`（平台失败 / 等待评测 / 正在评测 / AC / 未通过 / 已完成）与 `subtasks`；模板 29–75 行是带图标、得分、耗时、内存胶囊的结果摘要卡；80–103 行还有编译诊断、子任务成绩表、`SubmissionCaseResults`、评测输出、评测沿革。它是详情页级组件，依赖 `~/composables/useDomainSubmissions` 的类型，对应 `*Result`。

**影响**

- 面板：2 个模板调用点（`pages/d/[slug]/submissions/[submissionId].vue:50`、`components/editor/DomainCodeWorkspace.vue:275`）+ 1 个测试 import。
- 胶囊：1 个模板调用点（`components/card/SubmissionCard.vue:22`）+ 1 个测试 import。
- 两条标签互为链（`<DomainSubmissionResult>` → `<SubmissionResult>`，`<SubmissionResult>` → `<SubmissionStatusBadge>`）；
  脚本用单次正则同时替换，dry-run 会打印「改名链…已用单次替换规避」告警。

### 5.2 输入未覆盖的 5 个组件（已确认）

`.dsh/tmp/map-decisions.json` 实际只有 72 条，未覆盖以下 5 个组件；已按下列处理确认：

| 组件 | 输入情况 | 最终处理 | 依据 |
| --- | --- | --- | --- |
| `knowledge/KnowledgeEditorPanel.vue` | map-decisions 缺 4 条 | 原地 | 文件名已带 `Knowledge` 前缀、目录已在目标树 |
| `knowledge/KnowledgeNextLink.vue` | 同上 | 原地 | 同上 |
| `knowledge/KnowledgePicker.vue` | 同上 | 原地 | 同上 |
| `knowledge/KnowledgeTags.vue` | 同上 | 原地 | 同上 |
| `submission/DomainSubmissionResult.vue` | 缺 1 条 | `submission/SubmissionResult.vue` | 与 C1 一并裁决（§5.1） |

### 5.3 全量重名检查结论

| 检查项 | 结果 |
| --- | --- |
| 147 个目标文件名（basename）两两比对 | 0 组重复 |
| 源文件名（basename）重复 | 0 组 |
| 大小写不敏感重复（Windows 文件系统） | 0 组 |
| 目标路径已被现有文件占用 | 0 处 |
| 标签替换链（某条 `newTag` 等于另一条 `oldTag`） | 1 条（C1 互换口径，脚本单次替换） |
| 移动链（某条 `newRel` 等于另一条 `oldRel`） | 0 条 |

### 5.4 与任务书数字的差异（以本表实测为准）

| 项 | 任务书 | 实测 | 说明 |
| --- | ---: | ---: | --- |
| `map-decisions.json` 条数 | 76 | **72** | 缺 4 条 `knowledge/*`；另有 1 条 `feature/AnnouncementSection` 与 rc0.10 重叠 |
| rc0.10 可直接沿用 | 71 | **71**（去重后 70） | 71 个旧路径命中，其中 `feature/AnnouncementSection` 被 decisions 覆盖，故实际沿用 70 |
| `Domain*` 组件 | 33 | **29** | 任务书按旧基线计数；本分支实测 29 个文件，全部在 §3 中拆掉 `Domain` |
| 覆盖算式 | 76 + 71 = 147 | 72 + 70 + 5 = **147** | 5 = 4 个 `knowledge/*` + `DomainSubmissionResult` |

---

## 6. 需要同步修改的引用点

改名前须全部处理，否则构建期静默失败（组件解析不到会渲染成未知标签，不报错）。

| 类别 | 位置 | 数量 | 处理 |
| --- | --- | ---: | --- |
| 显式路径 import | `noj-ui/**/*.{vue,ts}` 中 `~/components/...` | 121 行 / 103 文件；其中 **65 行 / 61 文件**需改路径 | 脚本按表重写；`AdminTable` 的 8 处 `AdminColumn` 类型 import 路径不变 |
| 显式 import 的局部绑定名 | 12 个 `.vue`（`InstanceNav`×7、`InvitationManager`×2、`SettingFieldInput`、`DomainLlmAliases`、`UiFrame`） | 12 个文件 / 12 个绑定 | 脚本随标签改名同步绑定名；否则旧绑定变成未使用变量，标签只能靠自动导入兜底 |
| 模板标签 | `.vue` 模板区（不含 `<script>`/`<style>`） | **129 处 / 68 文件**（pages 52、components 16） | 脚本按边界正则改写；C1 的 `SubmissionResult` ↔ `SubmissionStatusBadge` 用单次替换 |
| 组件测试 stub 键 | `tests/components/*.spec.ts` | **39 处 / 22 文件** | 脚本同步对象键与 `name:`；spec 文件名本轮不改 |
| 组件测试显式注册与选择器 | `WorkspaceHomepage.spec.ts`、`OwnSubmissionRecord.spec.ts` | 2 文件 / 5 处 | **人工修正**：脚本不识别 `global.components` 键与 kebab stub 选择器（见 §8.4） |
| `overlay.create` | `composables/useDialog.ts`、`composables/useReportModal.ts` | 2 文件 | import 重写后自动生效（`DialogModal`、`ReportModal` 不在模板中出现） |
| 自动导入配置 | `noj-ui/nuxt.config.ts:131-133` | 1 | **本轮已改**显式 dirs（§9.2）；`.nuxt/components.d.ts` 声明 147/147 |
| lab 注册表 | `noj-ui/utils/labRegistry.ts` | 0 | 本分支不存在；脚本检测到才同步键名 |
| 模块文档 | `noj-ui/docs/structure.md` | 1 篇 | **本轮已重写**为新目录树 + R1–R7 + E1–E10；`noj-ui/AGENTS.md` 只保留指向它的路由，未改内容 |
| 历史文档 | `dev-docs/audit/**`、`dev-docs/superpowers/**` | 91 处路径 | **不改**：历史计划与审计记录保留当时路径 |
| 活文档 | `dev-docs/problem-version-management-handbook.md` 等 | 少量 | 下一轮人工对照；其中已有引用本分支不存在的组件 |

合计需改写 **130 个文件**（import 65 行、模板标签 129 处、测试 stub 39 处；同一文件可能同时命中多类）。

> **注意**：`DialogModal`、`ReportModal` 这类由 `overlay.create()` 打开、不在模板里出现的组件，
> 标签扫描看不到。死代码判定必须同时看 `composables/`：两个都在用，**不是**死代码。
>
> 标签改写只作用于 `.vue` 模板区：本分支 `components/editor/DomainOiRuntime.vue` 里有
> `defineModel<DomainOiRuntime>`，类型来自 `~/utils/domain-problem-editor`，不是组件标签；全文件替换会把它改成不存在的类型。
> 脚本在 dry-run 会把这 1 处列为「script 内命中，已跳过」。

---

## 7. 执行步骤

```text
1. 评审本表：C1（§5.1，已裁决）、knowledge 4 条（§5.2，已确认）、E1–E10（§4）
2. deno run -A scripts/oneoff/rename-ui-components-v011.ts            # dry-run，确认目标唯一 + 覆盖 147/147
3. deno run -A scripts/oneoff/rename-ui-components-v011.ts --apply
4. 手工改 nuxt.config.ts（§9.2 的显式 dirs）与 noj-ui/docs/structure.md
5. 验证：
   cd noj-ui && deno task check
   cd noj-ui && deno task test:components
   cd noj-ui && deno task build
   deno run -A scripts/verify-md-links.ts
6. 清理迁移后变空的目录（脚本只列出，不删除）
7. 一个提交（GPG 签名），不 push
```

---

## 8. 执行与验证（2026-11-21）

### 8.1 dry-run（执行前）

```text
$ deno run -A scripts/oneoff/rename-ui-components-v011.ts
映射 147 行；磁盘组件 147；可自动导入 147；覆盖 147
动作：原地 58 · 移动 34 · 改名 28 · 移动+改名 27 · 冻结 0
目标路径唯一：通过
目标标签唯一：通过
表外组件：0
引用扫描：需改写 130 文件（import 65 行、模板标签 129 处、测试 stub 39 处）
退出码 0
```

### 8.2 `--apply`

```text
$ deno run -A scripts/oneoff/rename-ui-components-v011.ts --apply
告警：改名链 <DomainSubmissionResult> → <SubmissionResult>，且 <SubmissionResult> 另有改名项；已用单次替换规避
完成：改写 130 个文件，移动 89 个文件。
```

C1 落位：`submission/SubmissionResult.vue`（7,630 B，结果面板）、
`submission/SubmissionStatusBadge.vue`（1,369 B，状态胶囊）。

### 8.3 验证结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 组件测试 | `cd noj-ui && deno task test:components` | **110 文件 / 483 用例全通过** |
| 构建 | `cd noj-ui && deno task build` | **通过**；`.nuxt/components.d.ts` 声明 147/147，无旧路径 |
| 静态检查 | `cd noj-ui && deno task check` | **通过**（fmt + lint 357 文件 + `check:types` + nuxt typecheck + vue-tsc） |
| 链接检查 | `deno run -A scripts/verify-md-links.ts` | **通过**（1028 个 Markdown） |

> `deno task check` 直接跑时，`deno fmt --check` 会因 Windows 检出 CRLF 报 357 个
> “Text differed by line endings”（既有环境问题，未改动的 `app.config.ts` 也在列表里）。
> 验证时用临时 `.editorconfig`（`end_of_line = crlf`）让 `check` 全绿，结束即删除；
> 另在 LF 归一化副本上单独跑 `deno fmt --check` 也是 0 差异（634 文件）。CI 为 LF，不受影响。

### 8.4 组件测试的手工修正

脚本只改 import 路径、stub 键与 `name:`，以下 2 个 spec 需要人工补（见 §6）：

- `tests/components/WorkspaceHomepage.spec.ts`：stub 选择器 `domain-home-content-stub` → `workspace-home-content-stub`。
- `tests/components/OwnSubmissionRecord.spec.ts`：4 处 `global.components: { OwnSubmissionSummary }` →
  `{ SubmissionOwnSummary: OwnSubmissionSummary }`。

修正后全量组件测试通过。

---

## 9. 关键设计决定

### 9.1 为什么保留完整文件名（`problem/ProblemCard.vue`）

`pathPrefix: false` 意味着目录不参与命名。若改成短文件名（`problem/Card.vue`）就必须同时打开 `pathPrefix`，
所有标签与 import 全量重写，且 `feature/community/CommentCard.vue` 会变成 `FeatureCommunityCommentCard`。
保留完整文件名 = 移动目录零标签改动，只有 55 项需要改名，diff 可控。

### 9.2 `components.dirs` 显式清单（本轮已改）

```ts
components: {
  dirs: [
    '~/components/base',
    '~/components/shared',
    '~/components/layout',
    '~/components/home',
    '~/components/problem',
    '~/components/submission',
    '~/components/contest',
    '~/components/training',
    '~/components/community',
    '~/components/ranking',
    '~/components/search',
    '~/components/auth',
    '~/components/legal',
    '~/components/editor',
    '~/components/admin',
    '~/components/education',
    '~/components/knowledge',
    '~/components/workspace',
    '~/components/announcements',
  ].map((path) => ({ path, pathPrefix: false })),
}
```

Nuxt 对每个登记目录递归扫描，`problem/objective/`、`problem/ui/` 不用单列；`legacy/` 故意不登记。
代价：新增目录必须登记；好处：「目录即领域」从约定变成配置事实，废弃组件不再占用组件名。

### 9.3 为什么标签改写只动模板区

rc0.10 的脚本对整份文件（含 `.ts`）做 `<Old>` 替换。本分支 `utils/domain-problem-editor.ts` 有
`Partial<DomainAiRuntime>`，`components/editor/DomainOiRuntime.vue` 有 `defineModel<DomainOiRuntime>`——
两者都会被当成组件标签改坏，且构建期不一定报错。v0.11 脚本把替换限制在
`<template>` 区（跳过 `<script>`/`<style>`），并把 script 内的命中列进 dry-run 报告供人工确认。

### 9.4 为什么同步测试 stub 键

组件测试用 `global.stubs = { ComponentName: ... }` 按组件名打桩。组件改名后 stub 键不跟着改不会报错，
真实组件会被渲染，测试仍可能通过但覆盖目标已经漂移。脚本对 `tests/**/*.ts` 只改两种精确形态：
行首 `OldTag:` 对象键、`name: 'OldTag'`（含 `findComponent({ name: ... })`）。

### 9.5 为什么连显式 import 的绑定名一起改

12 个 `.vue` 显式 import 了要改名的组件（`InstanceNav`×7、`InvitationManager`×2、`SettingFieldInput`、
`DomainLlmAliases`、`UiFrame`）。只改路径和模板标签会留下未使用的旧绑定，标签只能靠 Nuxt 自动导入兜底。
脚本在「绑定名 == 旧标签名」时，把 import 绑定与文件内同名标识符一起换成新名；测试文件里只改路径，
不动变量名（不涉及模板，避免无意义 diff）。

---

## 10. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 标签替换误伤 | `<ProblemId>` → `<ProblemIdBadge>` 时正则若不加边界会把新标签再改一次 | 正则用 `<(/?)Old(?=[\s/>])`，脚本幂等（重复执行无变化） |
| script 内误伤 | `Partial<DomainAiRuntime>` / `defineModel<DomainOiRuntime>` 被当成标签 | 只改模板区；dry-run 列出 script 内命中（1 处，已跳过） |
| 组件名冲突 | 同名组件在 Nuxt 中会静默取其一 | 脚本执行前校验目标路径与标签全局唯一（本轮 C1 已裁决，校验仍会拦新撞名） |
| 漏改引用 | 显式 import 漏改不会构建失败，只在运行/SSR 时炸 | 脚本扫描全量 `~/components/` 引用并报告未覆盖项；人工 grep 兜底 |
| 测试 stub 静默失效 | 键名是字符串，改名后不报错 | 脚本同步 39 处并输出 diff；`deno task test:components` 验证 |
| 自动导入范围变化 | 显式 dirs 漏一个目录，该目录组件全部失效 | 已用 `.nuxt/components.d.ts` 校验 147/147；以后跑 `deno task build` 后抽查首页/题目页/后台 |
| 历史文档路径失效 | 审计与历史计划引用的旧路径不再存在 | 明确不改；活文档下一轮单独对照 |
| CRLF 格式噪音 | Windows 检出下 `deno fmt --check` 报既有行尾差异 | 与本轮无关；CI 在 LF 下正常 |

---

## 11. 未纳入本轮

- `pages/` 目录归并与文件名规范（会改 URL，需单独评估重定向）
- `composables/`、`layouts/` 命名
- 组件内部 props/emit 命名、导出类型名（`AdminColumn`、`WorkspaceProblem` 等保持不动）
- 巨型组件拆分（`EditorCodeWorkspace`、`EducationAssignmentEditor` 等）
- `noj-ui/AGENTS.md` 的内容（路由表已指向 `docs/structure.md`，本轮未改）与其余模块文档
- `dev/lab/` 与 `legacy/`（本分支无组件；`legacy/` 只保留目录约定）
- 组件测试文件名（`Domain*Spec.ts` 保持原名，只改 import 路径与 stub 键）
