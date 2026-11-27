/**
 * 提交产物分层保留策略与分页/持锁重评/回滚调度单测（零数据库依赖）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  type ArtifactRetentionCandidate,
  type ArtifactRetentionPolicy,
  DEFAULT_ARTIFACT_RETENTION_POLICY,
  evaluateArtifactRetention,
  resolveArtifactRetentionPolicyFromEnv,
  runArtifactRetentionSweep,
} from "./service.ts";

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

Deno.test("artifact-retention: keyset 游标越过前排受保护记录触达后续过期产物", async () => {
  const dataset: ArtifactRetentionCandidate[] = [
    // 前 3 条均处于进行中竞赛（受保护），若不翻页则会卡死 batchSize=2 的清理
    makeCandidate({
      id: "sub-01",
      contest_id: "c-live",
      contest_end_time: daysAhead(1),
      created_at: daysAgo(40),
    }),
    makeCandidate({
      id: "sub-02",
      contest_id: "c-live",
      contest_end_time: daysAhead(1),
      created_at: daysAgo(39),
    }),
    makeCandidate({
      id: "sub-03",
      is_accepted: true,
      created_at: daysAgo(38),
    }),
    // 第 4、5 条为过期非最佳产物，必须被游标推进清理到
    makeCandidate({
      id: "sub-04",
      created_at: daysAgo(30),
      judge_finished_at: daysAgo(30),
    }),
    makeCandidate({
      id: "sub-05",
      created_at: daysAgo(29),
      judge_finished_at: daysAgo(29),
    }),
  ];

  const prunedIds: string[] = [];
  const summary = await runArtifactRetentionSweep({
    policy: ENABLED_POLICY,
    batchSize: 2,
    dryRun: false,
    nowMs: NOW_MS,
    fetchPage: (cursor, limit) => {
      const filtered = cursor === null
        ? dataset
        : dataset.filter((row) =>
          row.created_at > cursor.createdAt ||
          (row.created_at === cursor.createdAt && row.id > cursor.id)
        );
      return Promise.resolve(filtered.slice(0, limit));
    },
    pruneCandidate: (row) => {
      prunedIds.push(row.id);
      return Promise.resolve({ outcome: "deleted" });
    },
  });

  assertEquals(summary.scanned, 5);
  assertEquals(summary.skipped_protected, 3);
  assertEquals(summary.pruned, 2);
  assertEquals(summary.deleted_objects, 2);
  assertEquals(prunedIds, ["sub-04", "sub-05"]);
});

Deno.test("artifact-retention: 持锁重评发现并发重测已转为受保护或存储失败回滚时不误删", async () => {
  const state = new Map<string, ArtifactRetentionCandidate>([
    [
      "sub-rejudged",
      makeCandidate({
        id: "sub-rejudged",
        created_at: daysAgo(30),
        judge_finished_at: daysAgo(30),
      }),
    ],
    [
      "sub-flaky",
      makeCandidate({
        id: "sub-flaky",
        created_at: daysAgo(29),
        judge_finished_at: daysAgo(29),
      }),
    ],
  ]);

  let flakyAttempts = 0;
  const runOnce = () =>
    runArtifactRetentionSweep({
      policy: ENABLED_POLICY,
      batchSize: 10,
      dryRun: false,
      nowMs: NOW_MS,
      fetchPage: (cursor, limit) => {
        const rows = [...state.values()].filter((r) =>
          r.artifact_storage_url !== null &&
          (cursor === null ||
            r.created_at > cursor.createdAt ||
            (r.created_at === cursor.createdAt && r.id > cursor.id))
        );
        return Promise.resolve(rows.slice(0, limit));
      },
      pruneCandidate: (row) => {
        if (row.id === "sub-rejudged") {
          // 模拟持锁期间并发重测完成，提交变为通过 → 持锁重评跳过
          const fresh = {
            ...row,
            is_accepted: true,
            judge_finished_at: daysAgo(0),
          };
          state.set(row.id, fresh);
          if (
            !evaluateArtifactRetention(fresh, ENABLED_POLICY, NOW_MS).eligible
          ) {
            return Promise.resolve({ outcome: "skipped" });
          }
        }
        if (row.id === "sub-flaky") {
          flakyAttempts++;
          if (flakyAttempts === 1) {
            // 首次存储异常触发事务回滚，artifact_storage_url 保持未清空
            return Promise.reject(new Error("S3 temporary outage"));
          }
          state.set(row.id, { ...row, artifact_storage_url: null });
          return Promise.resolve({ outcome: "deleted" });
        }
        return Promise.resolve({ outcome: "deleted" });
      },
    });

  const first = await runOnce();
  assertEquals(first.pruned, 0);
  assertEquals(first.skipped_protected, 1);
  assertEquals(first.failed, 1);
  assertEquals(state.get("sub-rejudged")?.artifact_storage_url !== null, true);
  assertEquals(state.get("sub-flaky")?.artifact_storage_url !== null, true);

  // 第二轮重试：sub-rejudged 已被保护跳过，sub-flaky 成功回收
  const second = await runOnce();
  assertEquals(second.pruned, 1);
  assertEquals(second.deleted_objects, 1);
  assertEquals(state.get("sub-flaky")?.artifact_storage_url, null);
});
