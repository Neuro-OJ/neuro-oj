import { assertEquals } from "jsr:@std/assert@^1";
import {
  COMMUNITY_SILENCE_MODES,
  isValidContestConfig,
} from "../../types/contests.ts";
import { normalizeContestConfig } from "../../services/contest-input.ts";
import {
  doesContestSilenceActor,
  resolveCommunitySilenceMode,
} from "../../services/problem-secrecy.ts";

Deno.test("contest-silence-policy: community_silence_mode 校验与规范化", () => {
  for (const mode of COMMUNITY_SILENCE_MODES) {
    assertEquals(
      isValidContestConfig("kaggle", {
        scoreboard_scope: "self",
        community_silence_mode: mode,
      }),
      true,
    );
    assertEquals(
      normalizeContestConfig("kaggle", {
        scoreboard_scope: "self",
        community_silence_mode: mode,
      }),
      {
        scoreboard_scope: "self",
        community_silence_mode: mode,
      },
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

Deno.test("contest-silence-policy: pending/ended 不静默，running 按模式与参赛状态分流", () => {
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

  // secrecy_enabled=false 时不静默
  assertEquals(
    doesContestSilenceActor({
      secrecyEnabled: false,
      status: "running",
      silenceMode: "domain_all",
      isParticipant: true,
    }),
    false,
  );

  // running + secrecy_enabled=true 按三种模式分流
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
