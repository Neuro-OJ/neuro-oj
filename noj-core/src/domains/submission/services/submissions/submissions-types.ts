/**
 * Submissions 模块共享类型（PR-3 拆分）。
 *
 * 集中管理 SubmissionInput / SubmissionResponse / SubmissionDetail /
 * SubmissionListItem 等公开 DTO，避免拆分后多文件互相 import 形成循环依赖。
 */
import type { SubmissionStatus } from "../../types/index.ts";
import type { EffectiveVersionPolicy } from "../../../../shared/versioning/types.ts";

/** 创建提交的请求体 */
export interface SubmissionInput {
  problem_id: string;
  language: string;
  code: string;
  file_name?: string;
  contest_id?: string;
  /**
   * 提交时版本（Handbook §4.2）。
   *
   * 题库提交必须携带该题的已发布版本；竞赛提交携带时必须等于竞赛固定版本，
   * 否则 `409 CONTEST_PROBLEM_VERSION_CHANGED`。缺失且题目已版本化时返回
   * `VERSION_REQUIRED`——服务端**不静默绑定最新版**。
   */
  version_id?: string;
}

/** 创建提交成功后的响应（基础字段，不含 result） */
export interface SubmissionResponse {
  id: string;
  public_id: string;
  user_id: string;
  problem_id: string;
  contest_id: string | null;
  language: string;
  code: string;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
}

/** 测试点可见性。省略时按 visible 处理。 */
export type SubmissionCaseVisibility = "visible" | "hidden";

/** 评测结果中的标准测试点详情。 */
export interface SubmissionCaseResult {
  case_id: string;
  status: string;
  visibility?: SubmissionCaseVisibility;
  time_ms?: number | null;
  equivalent_time_ms?: number | null;
  fuel_consumed?: number | null;
  fuel_budget?: number | null;
  termination_reason?: string;
  memory_kb?: number | null;
  input?: string;
  expected_output?: string;
  actual_output?: string;
}

/** 评测详情的公共扩展字段；题目仍可携带自定义汇总数据。 */
export interface SubmissionEvaluationDetails extends Record<string, unknown> {
  cases?: SubmissionCaseResult[];
}

/**
 * 提交详情响应——基础数据公开，详细内容（code/output/details）按权限裁剪。
 *
 * - viewer 是 owner 或 admin → `code`/`output`/`details` 完整返回（output 可能被截断）
 * - viewer 是匿名用户或登录非 owner → `code`/`output`/`details` 均为 null
 */
/**
 * 单个题目版本的当前正式判定（跨版本保留，Handbook 核心不变量 3）。
 *
 * 每条来自 `submission_version_results` ⋈ `evaluation_attempts`：一个（提交，版本）
 * 只有一条当前判定，重测只会替换该版本的判定，不影响其他版本。
 */
export interface SubmissionVersionResultView {
  /** 题目版本 ID；迁移期"未知版本桶"为 null。 */
  problem_version_id: string | null;
  /** 版本号（展示用）；未知版本桶为 null。 */
  version: number | null;
  /** 产生该判定的已完成正式尝试 ID。 */
  attempt_id: string;
  /** 同一提交内递增的尝试序号（同分稳定排序依据）。 */
  sequence: number;
  /** 判定状态（finished / error 等）。 */
  status: string;
  /** ×100 整数，0..10000。 */
  score: number;
  time_ms: number | null;
  memory_kb: number | null;
  /** 是否为当前有效成绩（按题目作用域的有效版本策略解析）。 */
  is_effective: boolean;
  /** 是否为当前"通过"指针（通过候选中 sequence 最小者）。 */
  is_accepted: boolean;
}

/**
 * 一次评测尝试的读模型（Handbook §2.8、§6.8）。
 *
 * 与 `SubmissionVersionResultView` 的区别：后者只含「当前正式判定」的
 * 每版本聚合，本类型是**逐次执行**的完整历史（含 queued/judging/superseded、
 * 平台错误与已被替换的重测）。
 *
 * 不含 `output` / `details`：尝试历史面向所有可见者，敏感内容仍只走
 * `result`（经 `applySubmissionProjection` 统一裁剪）。
 */
export interface SubmissionAttemptView {
  /** 尝试 ID（正式评测的 `run_id`）。 */
  attempt_id: string;
  /** 同一提交内递增的尝试序号。 */
  sequence: number;
  /** 本次执行使用的题目版本；迁移历史尝试为 null。 */
  problem_version_id: string | null;
  /** 版本号（展示用）；未知历史版本为 null。 */
  version: number | null;
  /** 尝试来源：初次 / 重测 / 升级 / 迁移导入。 */
  source: "initial" | "rejudge" | "upgrade" | "legacy_import";
  /** 尝试状态机：queued / judging / finished / error / superseded。 */
  state: "queued" | "judging" | "finished" | "error" | "superseded";
  /** 判定类别：正式判定 / 平台错误；未终结为 null。 */
  result_kind: "graded" | "platform_error" | null;
  /** 展示用结果状态，与 `result.status` 同口径（finished / error / pending / judging）。 */
  status: string;
  /** ×100 整数；未终结为 0。 */
  score: number;
  time_ms: number | null;
  memory_kb: number | null;
  /** 是否为当前有效成绩指针（与投影一致，前端不得自行推断）。 */
  is_effective: boolean;
  /** 是否为当前"通过"成绩指针。 */
  is_accepted: boolean;
  /** 是否为最近一次执行（提交的 `latest_attempt_id` 所指）。 */
  is_latest: boolean;
  created_at: string;
  finished_at: string | null;
}

/** 最近一次执行 / 当前有效成绩的定位摘要（字段与 {@link SubmissionAttemptView} 同源）。 */
export interface SubmissionAttemptSummary {
  attempt_id: string;
  sequence: number;
  problem_version_id: string | null;
  version: number | null;
  state: SubmissionAttemptView["state"];
  result_kind: "graded" | "platform_error" | null;
  status: string;
  score: number;
  time_ms: number | null;
  memory_kb: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface SubmissionDetail {
  progress?: import("../oi-progress.ts").OiProgress | null;
  id: string;
  public_id: string;
  user_id: string;
  problem_id: string;
  contest_id: string | null;
  language: string;
  /** 源代码：仅 owner/admin 可见，否则为 null */
  code: string | null;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
  result: {
    status: string;
    score: number;
    /** 评测脚本输出：仅 owner/admin 可见（可能被截断至 8KB），否则为 null */
    output: string | null;
    /** output 是否被 API 层截断（issue 64 评论 §5.1）；非 owner/admin 为 null */
    output_truncated: boolean | null;
    time_ms: number | null;
    memory_kb: number | null;
    /** 评测用例级详情：仅 owner/admin 可见，否则为 null */
    details: SubmissionEvaluationDetails | null;
    /** 公开的统一计量摘要，不包含源码或隐藏测试数据。 */
    metering?: Record<string, unknown>;
  } | null;
  /** 排队位置（1-based），仅在 pending/等待中时有值。 */
  queue_position?: number | null;
  /** 当前 pending 队列总长度。 */
  queue_length?: number | null;
  /** 开始评测时间。 */
  judge_started_at?: string | null;
  /** 评测完成时间。 */
  judge_finished_at?: string | null;
  /** 提交时版本 ID（Handbook §2.7）；`legacy_unknown` 的历史提交为 null。 */
  submitted_version_id: string | null;
  /** 版本来源：`known`（提交时明确版本）/ `legacy_unknown`（迁移前未知）。 */
  version_origin: string;
  /** 提交时版本号（展示用）；未知历史版本为 null。 */
  submitted_version: number | null;
  /** 提交时版本是否仍是该题最新已发布版本（tracking #53）。 */
  is_latest: boolean;
  /** 由升级任务派生时指向源提交（同题旧版）；普通提交为 null。 */
  upgraded_from_id: string | null;
  /** 题目作用域的有效版本策略——各版本判定的选择依据（竞赛另有独立策略）。 */
  effective_version_policy: EffectiveVersionPolicy;
  /** 各版本当前正式判定；无版本化判定时为 null（与 `result` 同源展示）。 */
  version_results: SubmissionVersionResultView[] | null;
  /** 全部执行历史（含被 superseded 的重测与平台错误），按 sequence 升序。 */
  attempts: SubmissionAttemptView[];
  /** 最近一次执行（提交的 `latest_attempt_id`），无执行历史时为 null。 */
  latest_attempt: SubmissionAttemptSummary | null;
  /** 当前有效成绩指针所指的执行（`effective_attempt_id`），无有效成绩时为 null。 */
  effective_attempt: SubmissionAttemptSummary | null;
  /** 最近一次执行 ID；与 `latest_attempt.attempt_id` 一致。 */
  latest_attempt_id: string | null;
  /** 当前有效成绩指针 ID。 */
  effective_attempt_id: string | null;
  /** 当前通过成绩指针 ID。 */
  accepted_attempt_id: string | null;
}

/**
 * 提交列表项——不含 code 字段，附带题目和评测摘要。
 */
export interface SubmissionListItem {
  id: string;
  public_id: string;
  user_id: string;
  problem_id: string;
  contest_id: string | null;
  language: string;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
  judge_started_at: string | null;
  judge_finished_at: string | null;
  queue_position: number | null;
  queue_length: number | null;
  problem: {
    id: string;
    title: string;
  };
  /** 提交时版本 ID（未版本化历史提交为 null）。 */
  submitted_version_id: string | null;
  /** 版本来源：known / legacy_unknown。 */
  version_origin: string;
  /** 提交时版本号（展示用）；未知历史版本为 null。 */
  submitted_version: number | null;
  result: {
    status: string;
    score: number;
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
}

/** 列表查询参数 */
export interface ListSubmissionsParams {
  /** 已授权调用方解析的使用域；不能来自客户端任意覆盖值。 */
  domainId?: string;
  /** 由认证调用方传入，不能来自查询参数。 */
  platformAdmin?: boolean;
  userId?: string;
  contestId?: string;
  problemId?: string;
  problemSearch?: string;
  submissionId?: string;
  userSearch?: string;
  language?: string;
  status?: string;
  from?: string;
  to?: string;
  /** 为 true 时排除所有竞赛提交（contest_id IS NULL），用于公开列表。 */
  excludeContest?: boolean;
  /** 提交时版本 ID 精确筛选（Handbook §4.4「按版本筛选」）。 */
  versionId?: string;
  /** 按版本来源筛选：known（提交时明确版本）/ legacy_unknown（迁移前未知）。 */
  versionOrigin?: "known" | "legacy_unknown";
  /** 仅返回当前口径有效的提交（`is_valid = true`）。 */
  validOnly?: boolean;
  /** 仅返回当前口径通过的提交（`is_accepted = true`）。 */
  acceptedOnly?: boolean;
  /**
   * 仅返回"可升级"的提交：题目已有最新已发布版，且本提交的提交时版本不是最新版。
   *
   * 这是用户批量升级的候选集合（`ALREADY_LATEST` 不算可升级）。
   */
  upgradable?: boolean;
  page: number;
  perPage: number;
}

/** 列表查询结果 */
export interface ListSubmissionsResult {
  data: SubmissionListItem[];
  total: number;
}

/** 今日提交统计（由 stats-cache.ts 消费） */
export interface TodayStats {
  total: number;
  full_score: number;
  not_full_score: number;
}
