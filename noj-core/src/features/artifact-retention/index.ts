/**
 * 提交产物分层保留功能切片对外出口（`defineFeature` 自声明）。
 *
 * 启动流程经 `src/features.ts` 自动装配后台周期 worker，不再在 `create-system.ts` 手工登记。
 */
import { defineFeature } from "../../shared/feature.ts";
import { startArtifactRetentionTask } from "./service.ts";

export const feature = defineFeature({
  name: "artifact-retention",
  workers: [startArtifactRetentionTask],
});

export {
  _resetArtifactRetentionForTest,
  type ArtifactPruneOutcome,
  type ArtifactRetentionCandidate,
  type ArtifactRetentionCursor,
  type ArtifactRetentionDecision,
  type ArtifactRetentionPolicy,
  type ArtifactRetentionSweepResult,
  type ArtifactRetentionTier,
  DEFAULT_ARTIFACT_RETENTION_POLICY,
  DEFAULT_CONTEST_GRACE_DAYS,
  evaluateArtifactRetention,
  pruneExpiredSubmissionArtifacts,
  resolveArtifactRetentionPolicyFromEnv,
  runArtifactRetentionSweep,
  startArtifactRetentionTask,
} from "./service.ts";
