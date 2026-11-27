/**
 * 赛时社区静默策略功能切片对外出口（`defineFeature` 自声明）。
 *
 * 按比赛配置的 `community_silence_mode`（`none` / `contest_participants` / `domain_all`）
 * 仅在比赛进行期（`running`）判定是否静默指定用户的社区发布行为。
 */
import { defineFeature } from "../../shared/feature.ts";

export const feature = defineFeature({
  name: "contest-community-silence",
});

export {
  COMMUNITY_SILENCE_MODES,
  type CommunitySilenceMode,
  doesContestSilenceActor,
  isActorSilencedByRunningContest,
  resolveCommunitySilenceMode,
} from "./policy.ts";
