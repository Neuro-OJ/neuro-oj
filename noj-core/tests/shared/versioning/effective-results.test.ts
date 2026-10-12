/**
 * 有效成绩计算纯函数测试（Handbook §3.2、§1.3）。
 *
 * 这些用例是版本化评测的**语义基线**：跨版本保留、独立作用域、通过指针与
 * 分数指针分离都在这里穷举，后续 service 层只负责把候选集合读对。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  effectiveScore,
  mergeSubmissionProjection,
  policyAcceptsVersion,
  selectEffectiveResults,
} from "../../../src/shared/versioning/effective-results.ts";
import {
  type CurrentVersionResult,
  type EffectiveVersionPolicy,
  EMPTY_EFFECTIVE_SELECTION,
} from "../../../src/shared/versioning/types.ts";

const ANY: EffectiveVersionPolicy = { mode: "any" };
const exact = (versionId: string): EffectiveVersionPolicy => ({
  mode: "exact",
  version_id: versionId,
});

/** 构造候选判定。 */
function result(
  attempt_id: string,
  problem_version_id: string | null,
  score: number,
  accepted: boolean,
  sequence: number,
  extra: Partial<CurrentVersionResult> = {},
): CurrentVersionResult {
  return {
    attempt_id,
    problem_version_id,
    score,
    accepted,
    sequence,
    ...extra,
  };
}

const V1 = "version-v1";
const V2 = "version-v2";

Deno.test("effective results: 无候选时两布尔为 false、两指针为空", () => {
  assertEquals(selectEffectiveResults([], ANY), EMPTY_EFFECTIVE_SELECTION);
  assertEquals(
    selectEffectiveResults([], exact(V2)),
    EMPTY_EFFECTIVE_SELECTION,
  );
});

Deno.test({
  name: "effective results: Handbook §1.3 状态迁移表（V1 AC/V2 WA 起）",
  fn() {
    // 初次提交 V1，通过 → any/exact(V1) 均通过；exact(V2) 无候选
    const afterV1Ac = [result("a1", V1, 10000, true, 0)];
    assertEquals(selectEffectiveResults(afterV1Ac, ANY), {
      is_valid: true,
      is_accepted: true,
      effective_attempt_id: "a1",
      accepted_attempt_id: "a1",
    });
    assertEquals(selectEffectiveResults(afterV1Ac, exact(V2)), {
      is_valid: false,
      is_accepted: false,
      effective_attempt_id: null,
      accepted_attempt_id: null,
    });

    // 用 V2 重测，失败 → V1 AC 保留，any 下仍通过；exact(V2) 下不通过
    const afterV2Wa = [
      result("a1", V1, 10000, true, 0),
      result("a2", V2, 1000, false, 1),
    ];
    assertEquals(selectEffectiveResults(afterV2Wa, ANY), {
      is_valid: true,
      is_accepted: true,
      effective_attempt_id: "a1",
      accepted_attempt_id: "a1",
    });
    assertEquals(selectEffectiveResults(afterV2Wa, exact(V2)), {
      is_valid: true,
      is_accepted: false,
      effective_attempt_id: "a2",
      accepted_attempt_id: null,
    });

    // 再次用 V1 重测，失败 → V1 判定被同一版本的更新判定替换
    const afterV1Wa = [
      result("a3", V1, 0, false, 2),
      result("a2", V2, 1000, false, 1),
    ];
    assertEquals(selectEffectiveResults(afterV1Wa, ANY), {
      is_valid: true,
      is_accepted: false,
      effective_attempt_id: "a2",
      accepted_attempt_id: null,
    });

    // 用 V2 重测，通过 → exact(V2) 下通过
    const afterV2Ac = [
      result("a3", V1, 0, false, 2),
      result("a4", V2, 10000, true, 3),
    ];
    assertEquals(selectEffectiveResults(afterV2Ac, ANY), {
      is_valid: true,
      is_accepted: true,
      effective_attempt_id: "a4",
      accepted_attempt_id: "a4",
    });
    assertEquals(selectEffectiveResults(afterV2Ac, exact(V2)), {
      is_valid: true,
      is_accepted: true,
      effective_attempt_id: "a4",
      accepted_attempt_id: "a4",
    });
    // V1 上的旧 AC 判定已被 V1 的失败重测替换，不能"复活"
    assertEquals(selectEffectiveResults(afterV2Ac, exact(V1)), {
      is_valid: true,
      is_accepted: false,
      effective_attempt_id: "a3",
      accepted_attempt_id: null,
    });
  },
});

Deno.test("effective results: any 接受未知版本候选，exact 不接受", () => {
  const unknown = [result("a1", null, 10000, true, 0)];
  assertEquals(selectEffectiveResults(unknown, ANY).is_accepted, true);
  assertEquals(selectEffectiveResults(unknown, exact(V1)), {
    is_valid: false,
    is_accepted: false,
    effective_attempt_id: null,
    accepted_attempt_id: null,
  });
  assertEquals(policyAcceptsVersion(ANY, null), true);
  assertEquals(policyAcceptsVersion(exact(V1), null), false);
});

Deno.test("effective results: 有效指针与通过指针可以不同（不通过最高分）", () => {
  const candidates = [
    result("a1", V1, 10000, true, 0), // 通过但分数更高
    result("a2", V2, 6000, false, 1), // 不通过
    result("a3", V1, 5000, true, 2), // 通过且 sequence 最小的是 a1
  ];
  // any：有效指针取最高分 a1；通过指针取通过候选里 sequence 最小的 a1
  const anySelection = selectEffectiveResults(candidates, ANY);
  assertEquals(anySelection.effective_attempt_id, "a1");
  assertEquals(anySelection.accepted_attempt_id, "a1");

  // exact(V2)：只有 a2 候选（不通过），有效指针 a2、通过指针为空
  const exactSelection = selectEffectiveResults(candidates, exact(V2));
  assertEquals(exactSelection.is_valid, true);
  assertEquals(exactSelection.is_accepted, false);
  assertEquals(exactSelection.effective_attempt_id, "a2");
  assertEquals(exactSelection.accepted_attempt_id, null);
});

Deno.test("effective results: 通过指针取通过候选中 sequence 最小者，与分数无关", () => {
  const candidates = [
    result("later-high", V1, 10000, true, 5),
    result("early-ac", V1, 3000, true, 1), // 通过且 sequence 最小
    result("wa-high", V2, 9000, false, 0),
  ];
  const selection = selectEffectiveResults(candidates, ANY);
  assertEquals(selection.effective_attempt_id, "later-high");
  assertEquals(selection.accepted_attempt_id, "early-ac");
  assert(selection.effective_attempt_id !== selection.accepted_attempt_id);
});

Deno.test("effective results: 同分按 sequence 升序、再按 ID 升序稳定选择", () => {
  const sameScore = [
    result("b-attempt", V1, 5000, false, 2),
    result("a-attempt", V1, 5000, false, 2),
    result("c-attempt", V1, 5000, false, 1),
  ];
  assertEquals(
    selectEffectiveResults(sameScore, ANY).effective_attempt_id,
    "c-attempt",
  );
  assertEquals(
    selectEffectiveResults(sameScore.slice(0, 2), ANY).effective_attempt_id,
    "a-attempt",
  );
});

Deno.test("effective results: 平台错误与在途尝试不参与选择", () => {
  const candidates = [
    result("graded", V1, 1000, false, 0),
    result("errored", V2, 10000, true, 1, {
      result_kind: "platform_error",
    }),
    result("in-flight", V2, 10000, true, 2, { state: "judging" }),
    result("queued", V2, 10000, true, 3, { state: "queued" }),
  ];
  const selection = selectEffectiveResults(candidates, ANY);
  assertEquals(selection.effective_attempt_id, "graded");
  assertEquals(selection.is_accepted, false);
  // 若只有平台错误候选：视为无候选（旧正式判定保留由写入侧负责）
  const onlyError = [
    result("errored", V1, 0, false, 0, { result_kind: "platform_error" }),
  ];
  assertEquals(
    selectEffectiveResults(onlyError, ANY),
    EMPTY_EFFECTIVE_SELECTION,
  );
});

Deno.test("effective results: effectiveScore 与选择一致", () => {
  const candidates = [
    result("a1", V1, 4200, false, 0),
    result("a2", V2, 8800, false, 1),
  ];
  assertEquals(effectiveScore(candidates, ANY), 8800);
  assertEquals(effectiveScore(candidates, exact(V1)), 4200);
  assertEquals(effectiveScore([], ANY), null);
});

Deno.test("effective results: mergeSubmissionProjection 保持两个作用域独立", () => {
  const global = selectEffectiveResults(
    [result("g1", V1, 10000, true, 0)],
    ANY,
  );
  const contest = selectEffectiveResults(
    [result("c1", V2, 1000, false, 1)],
    exact(V2),
  );
  const merged = mergeSubmissionProjection(global, contest);
  assertEquals(merged.is_valid, true);
  assertEquals(merged.is_accepted, true);
  assertEquals(merged.effective_attempt_id, "g1");
  assertEquals(merged.is_contest_valid, true);
  assertEquals(merged.is_contest_accepted, false);
  assertEquals(merged.contest_effective_attempt_id, "c1");
  assertEquals(merged.contest_accepted_attempt_id, null);
});
