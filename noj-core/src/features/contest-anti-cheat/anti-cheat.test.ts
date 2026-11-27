import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  comparePredictionVectors,
  detectSimilarPredictions,
  extractSortablePythonSource,
} from "./index.ts";

Deno.test("contest-anti-cheat: 预测向量共同错误重合度与产物 ZIP 源码提取", () => {
  const truth = ["A", "A", "A", "A", "B", "B", "C", "C", "D", "D"];
  // 两位高准确率但独立犯不同错误的选手
  const independentA = ["A", "A", "A", "A", "B", "B", "C", "C", "A", "D"];
  const independentB = ["A", "A", "A", "A", "B", "B", "C", "C", "D", "B"];
  const indepMetrics = comparePredictionVectors(
    independentA,
    independentB,
    truth,
  );
  assertEquals(indepMetrics.agreement, 0.8);
  assertEquals(indepMetrics.wrong_coincidence, 0);

  // 两位犯完全相同错误的选手
  const copiedA = ["A", "A", "A", "A", "B", "B", "X", "Y", "Z", "D"];
  const copiedB = ["A", "A", "A", "A", "B", "B", "X", "Y", "Z", "D"];
  const copiedMetrics = comparePredictionVectors(copiedA, copiedB, truth);
  assertEquals(copiedMetrics.wrong_coincidence, 1);

  const predPairs = detectSimilarPredictions(
    [
      {
        submission_id: "p-ind-1",
        user_id: "u1",
        problem_id: "pred-1",
        predictions: independentA,
      },
      {
        submission_id: "p-ind-2",
        user_id: "u2",
        problem_id: "pred-1",
        predictions: independentB,
      },
      {
        submission_id: "p-cop-1",
        user_id: "u3",
        problem_id: "pred-1",
        predictions: copiedA,
      },
      {
        submission_id: "p-cop-2",
        user_id: "u4",
        problem_id: "pred-1",
        predictions: copiedB,
      },
    ],
    { groundTruth: truth, threshold: 0.85 },
  );
  assertEquals(predPairs.length, 1);
  assertEquals(predPairs[0]!.submission_a_id, "p-cop-1");
  assertEquals(predPairs[0]!.submission_b_id, "p-cop-2");

  const extracted = extractSortablePythonSource({
    ".venv/lib/site.py": "ignored = 1\n",
    "__pycache__/cache.py": "ignored = 2\n",
    "tests/test_main.py": "ignored = 3\n",
    "README.md": "ignored\n",
    "b_model.py": "def b(): return 2\n",
    "a_main.py": "def a(): return 1\n",
  });
  assert(extracted.indexOf("a_main.py") < extracted.indexOf("b_model.py"));
  assert(!extracted.includes("ignored"));
});
