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
  | "TRANSACTION_FAILED";

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
