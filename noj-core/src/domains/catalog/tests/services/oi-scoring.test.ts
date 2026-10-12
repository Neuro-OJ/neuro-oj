import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { distributeOiPoints, oiCaseMaxScores } from "../../types/oi-scoring.ts";
import { validateProblemSamples } from "../../types/problem-samples.ts";
import { validateOiSelfTestCases } from "../../services/oi-self-test-package.ts";
import { buildOiSelfTestPackage } from "../../services/oi-self-test-package.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { unzipSync } from "fflate";
import { sha256Hex } from "../../../system/index.ts";
import { isAcceptedResult } from "../../../../shared/base/accepted-result.ts";

Deno.test("OI 默认整数等分与显式分数一致，余数分给末尾", () => {
  assertEquals(distributeOiPoints(100, 3), [33, 33, 34]);
  assertEquals(distributeOiPoints(2, 4), [0, 0, 1, 1]);
  assertEquals(
    oiCaseMaxScores({
      id: "a",
      score: 100,
      scoring: "sum",
      cases: [{ input: "1", output: "1.out", score: 20 }, {
        input: "2",
        output: "2.out",
      }, { input: "3", output: "3.out" }],
    }),
    [20, 40, 40],
  );
  assertEquals(
    oiCaseMaxScores({
      id: "a",
      score: 100,
      scoring: "max",
      cases: [{ input: "1", output: "1.out" }],
    }),
    [100],
  );
});
Deno.test("独立样例与自测区分空输出和缺省输出，并拒绝重复标识", () => {
  validateProblemSamples([{ id: "sample", input: "", output: "" }]);
  assertThrows(() =>
    validateProblemSamples([{ id: "sample", input: 1, output: "" }])
  );
  validateOiSelfTestCases([{ id: "run", input: "" }, {
    id: "compare",
    input: "",
    expected_output: "",
  }]);
  assertThrows(() =>
    validateOiSelfTestCases([{ id: "run", input: "" }, {
      id: "run",
      input: "",
    }])
  );
  assertThrows(() =>
    validateOiSelfTestCases([{ id: "run", input: "", expected_output: null }])
  );
});
Deno.test("OI 满分 WA 不计为通过，零分 AC 仍通过；AI 保留正分语义", () => {
  assertEquals(
    isAcceptedResult("finished", 10000, { oi: { verdict: "WA" } }),
    false,
  );
  assertEquals(
    isAcceptedResult("finished", 0, { oi: { verdict: "AC" } }),
    true,
  );
  assertEquals(isAcceptedResult("finished", 2500, {}), true);
  assertEquals(
    isAcceptedResult("error", 10000, { oi: { verdict: "AC" } }),
    false,
  );
});

Deno.test("OI 自测包遵循原始 base64 下载协议，校验和覆盖实际 ZIP 内容", async () => {
  const built = await buildOiSelfTestPackage(
    {
      backend: "wasm",
      languages: ["cc"],
      time_limit_ms: 1000,
      memory_limit_mb: 256,
      checker: { type: "default" },
      subtasks: [{
        id: "all",
        score: 100,
        cases: [{ input: "hidden.in", output: "hidden.out" }],
      }],
    },
    null,
    [
      { id: "sample", input: "1 2\n", expected_output: "3\n" },
      { id: "run", input: "" },
      { id: "empty", input: "", expected_output: "" },
    ],
  );
  // 与现有 Worker 一样按 & 与第一个 = 切分，不使用会把 + 改为空格的表单解析。
  const query = built.download_url.split("?")[1]!;
  const fields = Object.fromEntries(
    query.split("&").map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  assertEquals(fields.content.includes("%"), false);
  const bytes = decodeBase64(fields.content);
  assertEquals(fields.checksum_sha256, await sha256Hex(bytes));
  const files = unzipSync(bytes);
  assertEquals(
    Object.keys(files).sort(),
    ["1.in", "1.out", "2.in", "2.out", "3.in", "3.out"].map((path) =>
      `noj-self-test/${path}`
    ),
  );
  assertEquals(new TextDecoder().decode(files["noj-self-test/1.in"]), "1 2\n");
  assertEquals(new TextDecoder().decode(files["noj-self-test/1.out"]), "3\n");
  assertEquals(built.runtime_config.self_test?.no_compare_inputs, [
    "noj-self-test/2.in",
  ]);
});
