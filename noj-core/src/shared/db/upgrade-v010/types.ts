/**
 * `v0.10.6 → v0.11` 逻辑迁移器类型与错误定义。
 *
 * 本目录属于 `shared/db`，严格保持零业务模块依赖，只依赖标准库、`postgres`
 * 与 `shared/db` 内部契约（`migrations-path.ts` / `schema-compat.ts`）。
 */

/** 逻辑迁移器稳定错误码。 */
export type UpgradeV010ErrorCode =
  | "INVALID_OPTIONS"
  | "SAME_DATABASE"
  | "SOURCE_INVALID_SCHEMA"
  | "SOURCE_UNSUPPORTED_VERSION"
  | "TARGET_INVALID_SCHEMA"
  | "TARGET_NOT_EMPTY"
  | "DATA_INTEGRITY_ERROR"
  | "ACCESS_DECISION_REQUIRED"
  | "GATEWAY_TARGET_REQUIRED"
  | "GATEWAY_TARGET_INVALID"
  | "GATEWAY_VERIFY_FAILED"
  | "TRANSACTION_FAILED";

/**
 * v0.10.6 私有题（`visibility='private'` 且已发布）在 v0.11 公开 `main` 域的处置：
 * - `disable`：绑定写入 `disabled_at`，任何人（含原所有者）均不可读，平台管理员逐题复核后再启用；
 * - `expose`：运维明确接受在 `main` 域按 ID 公开可读（等同于转为公开题）。
 */
export type PrivateProblemPolicy = "disable" | "expose";

/**
 * v0.10.6 访问受限比赛（`is_public=false`、`kind='invite'` 或设有报名口令）在 v0.11 的处置。
 * v0.11 不再识别邀请/口令语义，唯一可选处置为 `expose`：运维明确接受其在 `main`
 * 域公开列出、可直接报名（旧口令清空）。
 */
export type RestrictedContestPolicy = "expose";

/**
 * 逻辑迁移前置条件或数据转换失败错误。
 *
 * `message` 与 `details` 严禁包含源库或目标库连接串、口令或敏感凭据。
 */
export class UpgradeV010Error extends Error {
  readonly code: UpgradeV010ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: UpgradeV010ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UpgradeV010Error";
    this.code = code;
    this.details = details;
  }
}

/** 逻辑迁移执行选项。 */
export interface UpgradeFromV010Options {
  /** 只读源库连接串（`v0.10.6` / `0115`）。 */
  sourceUrl: string;
  /** 空目标库连接串（已运行 `v0.11` 全量迁移 `0000..0144`）。 */
  targetUrl: string;
  /** 为 `true` 时只做只读预检与规划统计，不向目标库写入任何行。 */
  dryRun?: boolean;
  /** 可选迁移目录覆写，供测试与自定义打包布局使用。 */
  migrationsDir?: string;
  /** 可选时钟函数（返回 ISO UTC 时间戳）。 */
  now?: () => string;
  /**
   * 独立部署的 `noj-llm-gateway` 数据库连接串（已执行 v0.11 Gateway 迁移）。
   * 源 Core 库存在默认模型或别名、而目标 Core 库内没有同库 Gateway 表时必填。
   */
  gatewayUrl?: string;
  /** 已发布私有题的处置；存在此类题目而未指定时拒绝升级。 */
  privateProblemPolicy?: PrivateProblemPolicy;
  /** 访问受限比赛的处置；存在此类比赛而未指定时拒绝升级。 */
  restrictedContestPolicy?: RestrictedContestPolicy;
}

/** 已发布私有题的处置记录。 */
export interface PrivateProblemDecisionEntry {
  id: string;
  title: string;
  ownerId: string;
  action: PrivateProblemPolicy;
}

/** 访问受限比赛的处置记录（不含口令明文）。 */
export interface RestrictedContestDecisionEntry {
  id: string;
  title: string;
  wasPublic: boolean;
  kind: string;
  hadPassword: boolean;
  action: RestrictedContestPolicy;
}

/** 引用已删除题目的批量任务条目处置记录。 */
export interface OrphanJobItemEntry {
  id: string;
  jobId: string;
  problemId: string;
  originalStatus: string;
  importedStatus: string;
}

/** `U` 题重编号规划项。 */
export interface RenumberedProblemEntry {
  id: string;
  oldType: "P" | "U";
  oldNumber: number;
  newNumber: number;
  title: string;
}

/** 迁移过程中被归档跳过的旧版动态（`moment`）帖子摘要（不含正文内容）。 */
export interface SkippedMomentPostEntry {
  id: string;
  authorId: string;
  createdAt: string;
}

/** 同库 `noj-llm-gateway` 表迁移摘要。 */
export interface GatewayMigrationSummary {
  /** 源库和目标库是否均包含可迁移的 Gateway 表。 */
  detected: boolean;
  copiedProviders: number;
  copiedUsage: number;
  copiedQuotas: number;
  backfilledDomainSettings: number;
  backfilledModelAliases: number;
  /**
   * 独立 Gateway 库的默认模型/别名转移结果；`null` 表示无需转移（同库或源库无配置）。
   * `verified=true` 表示已在 Gateway 库读回并与计划逐行比对一致。
   */
  standalone: {
    domainSettings: number;
    modelAliases: number;
    verified: boolean;
  } | null;
}

/** 下线或转换数据的归档与统计摘要。 */
export interface UpgradeArchivedSummary {
  renumberedProblems: RenumberedProblemEntry[];
  skippedMomentPosts: SkippedMomentPostEntry[];
  skippedMomentComments: number;
  skippedMessageReports: number;
  skippedMomentReports: number;
  skippedMessageSearchEntries: number;
  skippedMomentSearchEntries: number;
  skippedAuditLogs: number;
  droppedSystemSettings: string[];
  droppedLegacyTables: Record<string, number>;
  privateProblems: PrivateProblemDecisionEntry[];
  restrictedContests: RestrictedContestDecisionEntry[];
  orphanJobItems: OrphanJobItemEntry[];
}

/** `runUpgradeFromV010` 返回的结构化报告。 */
export interface UpgradeReport {
  dryRun: boolean;
  executedAt: string;
  defaultDomainId: string;
  defaultDomainSlug: string;
  defaultDomainOwnerId: string;
  sourceMigrationCount: number;
  targetMigrationCount: number;
  tableCounts: Record<string, number>;
  archivedSummary: UpgradeArchivedSummary;
  gateway: GatewayMigrationSummary;
}
