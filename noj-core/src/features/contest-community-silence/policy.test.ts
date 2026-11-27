import { assertEquals } from "jsr:@std/assert@^1";
import {
  COMMUNITY_SILENCE_MODES,
  doesContestSilenceActor,
  resolveCommunitySilenceMode,
} from "./index.ts";
import { isValidContestConfig } from "../../modules/contests/index.ts";

Deno.test("contest-community-silence: community_silence_mode 校验与解析", () => {
  for (const mode of COMMUNITY_SILENCE_MODES) {
    assertEquals(
      isValidContestConfig("kaggle", {
        scoreboard_scope: "self",
        community_silence_mode: mode,
      }),
      true,
    );
  }
  assertEquals(
    isValidContestConfig("kaggle", {
      community_silence_mode: "invalid" as never,
    }),
    false,
  );
  assertEquals(resolveCommunitySilenceMode(undefined), "domain_all");
  assertEquals(resolveCommunitySilenceMode({}), "domain_all");
  assertEquals(
    resolveCommunitySilenceMode({ community_silence_mode: "bogus" }),
    "domain_all",
  );
  assertEquals(
    resolveCommunitySilenceMode({
      community_silence_mode: "contest_participants",
    }),
    "contest_participants",
  );
});

Deno.test("contest-community-silence: pending/ended 不静默，running 按模式与参赛状态分流", () => {
  for (const status of ["pending", "ended"] as const) {
    for (const silenceMode of COMMUNITY_SILENCE_MODES) {
      for (const isParticipant of [false, true]) {
        assertEquals(
          doesContestSilenceActor({
            secrecyEnabled: true,
            status,
            silenceMode,
            isParticipant,
          }),
          false,
        );
      }
    }
  }

  assertEquals(
    doesContestSilenceActor({
      secrecyEnabled: false,
      status: "running",
      silenceMode: "domain_all",
      isParticipant: true,
    }),
    false,
  );
  assertEquals(
    doesContestSilenceActor({
      secrecyEnabled: true,
      status: "running",
      silenceMode: "none",
      isParticipant: true,
    }),
    false,
  );
  assertEquals(
    doesContestSilenceActor({
      secrecyEnabled: true,
      status: "running",
      silenceMode: "contest_participants",
      isParticipant: false,
    }),
    false,
  );
  assertEquals(
    doesContestSilenceActor({
      secrecyEnabled: true,
      status: "running",
      silenceMode: "contest_participants",
      isParticipant: true,
    }),
    true,
  );
  assertEquals(
    doesContestSilenceActor({
      secrecyEnabled: true,
      status: "running",
      silenceMode: "domain_all",
      isParticipant: false,
    }),
    true,
  );
});
