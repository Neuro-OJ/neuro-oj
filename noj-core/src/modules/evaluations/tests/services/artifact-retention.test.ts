/**
 * 提交产物分层保留策略纯逻辑单测（零数据库依赖）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  type ArtifactRetentionCandidate,
  type ArtifactRetentionPolicy,
  DEFAULT_ARTIFACT_RETENTION_POLICY,
  evaluateArtifactRetention,
  resolveArtifactRetentionPolicyFromEnv,
} from "../../services/submissions/artifact-retention.ts";

const NOW_MS = Date.parse("2026-11-27T00:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

function daysAhead(days: number): string {
  return new Date(NOW_MS + days * DAY_MS).toISOString();
}

function makeCandidate(
  overrides: Partial<ArtifactRetentionCandidate> = {},
): ArtifactRetentionCandidate {
  return {
    id: "sub-1",
    status: "finished",
    active_attempt_id: null,
    is_accepted: false,
    is_contest_accepted: false,
    contest_effective_attempt_id: null,
    contest_id: null,
    contest_end_time: null,
    created_at: daysAgo(30),
    judge_finished_at: daysAgo(30),
    artifact_storage_url: "noj-storage://s3/artifacts/sub-1.zip",
    ...overrides,
  };
}

const ENABLED_POLICY: ArtifactRetentionPolicy = {
  enabled: true,
  nonBestRetentionDays: 14,
  bestRetentionDays: 0,
  contestGraceDays: 7,
};

Deno.test("artifact-retention: Tier 0 保护在途评测与无产物提交", () => {
  const judging = evaluateArtifactRetention(
    makeCandidate({ status: "judging" }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(judging.eligible, false);
  assertEquals(judging.tier, "protected_inflight");

  const activeAttempt = evaluateArtifactRetention(
    makeCandidate({ active_attempt_id: "att-1" }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(activeAttempt.eligible, false);
  assertEquals(activeAttempt.tier, "protected_inflight");

  const noUrl = evaluateArtifactRetention(
    makeCandidate({ artifact_storage_url: null }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(noUrl.eligible, false);
  assertEquals(noUrl.tier, "protected_inflight");
});

Deno.test("artifact-retention: Tier 0 严格保护进行中竞赛及赛后宽限期", () => {
  const running = evaluateArtifactRetention(
    makeCandidate({
      contest_id: "c-1",
      contest_end_time: daysAhead(2),
      created_at: daysAgo(20),
      judge_finished_at: daysAgo(20),
    }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(running.eligible, false);
  assertEquals(running.tier, "protected_active_contest");

  // 竞赛结束 3 天（< 7 天宽限期）仍受保护
  const inGrace = evaluateArtifactRetention(
    makeCandidate({
      contest_id: "c-2",
      contest_end_time: daysAgo(3),
      created_at: daysAgo(25),
      judge_finished_at: daysAgo(25),
    }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(inGrace.eligible, false);
  assertEquals(inGrace.tier, "protected_active_contest");

  // 竞赛结束 10 天（过 7 天宽限期后才过了 3 天 < 14 天非最佳保留期）暂不清理
  const afterGraceNotExpired = evaluateArtifactRetention(
    makeCandidate({
      contest_id: "c-3",
      contest_end_time: daysAgo(10),
      created_at: daysAgo(40),
      judge_finished_at: daysAgo(40),
    }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(afterGraceNotExpired.eligible, false);
  assertEquals(afterGraceNotExpired.tier, "non_best");

  // 竞赛结束 25 天（7 天宽限期 + 14 天保留期 = 21 天，已过期）允许清理
  const afterGraceExpired = evaluateArtifactRetention(
    makeCandidate({
      contest_id: "c-4",
      contest_end_time: daysAgo(25),
      created_at: daysAgo(40),
      judge_finished_at: daysAgo(40),
    }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(afterGraceExpired.eligible, true);
  assertEquals(afterGraceExpired.tier, "non_best");
});

Deno.test("artifact-retention: Tier 1 最佳/通过产物默认永久保留，显式配置天数后超期回收", () => {
  const accepted = makeCandidate({
    is_accepted: true,
    judge_finished_at: daysAgo(120),
  });
  const keepForever = evaluateArtifactRetention(
    accepted,
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(keepForever.eligible, false);
  assertEquals(keepForever.tier, "best_or_accepted");

  const contestEffective = makeCandidate({
    contest_effective_attempt_id: "att-best",
    judge_finished_at: daysAgo(120),
  });
  assertEquals(
    evaluateArtifactRetention(contestEffective, ENABLED_POLICY, NOW_MS)
      .eligible,
    false,
  );

  const timedBestPolicy: ArtifactRetentionPolicy = {
    ...ENABLED_POLICY,
    bestRetentionDays: 90,
  };
  const expiredBest = evaluateArtifactRetention(
    accepted,
    timedBestPolicy,
    NOW_MS,
  );
  assertEquals(expiredBest.eligible, true);
  assertEquals(expiredBest.tier, "best_or_accepted");
});

Deno.test("artifact-retention: Tier 2 非最佳产物超期可回收，未超期或开关关闭时保留", () => {
  const recent = evaluateArtifactRetention(
    makeCandidate({ judge_finished_at: daysAgo(10) }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(recent.eligible, false);
  assertEquals(recent.tier, "non_best");

  const expired = evaluateArtifactRetention(
    makeCandidate({ judge_finished_at: daysAgo(15) }),
    ENABLED_POLICY,
    NOW_MS,
  );
  assertEquals(expired.eligible, true);
  assertEquals(expired.tier, "non_best");

  const disabled = evaluateArtifactRetention(
    makeCandidate({ judge_finished_at: daysAgo(15) }),
    DEFAULT_ARTIFACT_RETENTION_POLICY,
    NOW_MS,
  );
  assertEquals(disabled.eligible, false);
});

Deno.test("artifact-retention: 环境变量解析与安全钳制", () => {
  const defaults = resolveArtifactRetentionPolicyFromEnv(() => undefined);
  assertEquals(defaults, DEFAULT_ARTIFACT_RETENTION_POLICY);

  const custom = resolveArtifactRetentionPolicyFromEnv((k) =>
    ({
      ARTIFACT_RETENTION_ENABLED: "true",
      ARTIFACT_NON_BEST_RETENTION_DAYS: "30",
      ARTIFACT_BEST_RETENTION_DAYS: "99999",
    })[k]
  );
  assertEquals(custom.enabled, true);
  assertEquals(custom.nonBestRetentionDays, 30);
  assertEquals(custom.bestRetentionDays, 3650);
});
