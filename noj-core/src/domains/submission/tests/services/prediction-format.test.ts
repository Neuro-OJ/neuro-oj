/**
 * prediction 提交文件格式校验纯函数测试。
 *
 * `validatePredictionFile` 不依赖 DB / 存储 / 网络，因此这里以纯单测覆盖
 * 扩展名白/黑名单与各类魔数校验。
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  predictionFileExtension,
  validatePredictionFile,
} from "../../services/submissions/prediction-format.ts";
import { BadRequestError } from "./../../../../shared/base/errors.ts";

/** 断言校验以 PREDICTION_FORMAT_REJECTED 错误码拒绝。 */
function assertRejected(fileName: string, bytes: Uint8Array): void {
  const err = assertThrows(
    () => validatePredictionFile(fileName, bytes),
    BadRequestError,
  );
  if (err.code !== "PREDICTION_FORMAT_REJECTED") {
    throw new Error(
      `错误码应为 PREDICTION_FORMAT_REJECTED，实际为 ${err.code}`,
    );
  }
}

Deno.test("prediction-format: 接受 csv/jsonl 文本格式", () => {
  validatePredictionFile(
    "pred.csv",
    new TextEncoder().encode("id,value\n1,0.5\n"),
  );
  validatePredictionFile("pred.jsonl", new TextEncoder().encode('{"id":1}\n'));
  validatePredictionFile("pred.json", new TextEncoder().encode('{"id":1}'));
  validatePredictionFile("pred.tsv", new TextEncoder().encode("id\tvalue\n"));
  validatePredictionFile("pred.txt", new TextEncoder().encode("id value\n"));
});

Deno.test("prediction-format: 接受 npy/npz/parquet 正确魔数", () => {
  // .npy：\x93NUMPY
  const npy = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00]);
  validatePredictionFile("pred.npy", npy);
  // .npz：PK\x03\x04
  validatePredictionFile("pred.npz", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  // .parquet：PAR1
  validatePredictionFile(
    "pred.parquet",
    new Uint8Array([0x50, 0x41, 0x52, 0x31]),
  );
});

Deno.test("prediction-format: 拒绝 pickle 类扩展名", () => {
  for (
    const name of [
      "m.pkl",
      "m.pickle",
      "m.pt",
      "m.pth",
      "m.bin",
      "m.joblib",
      "m.ckpt",
    ]
  ) {
    assertRejected(name, new Uint8Array([0x00]));
  }
});

Deno.test("prediction-format: 拒绝 pickle 协议头（任何扩展名）", () => {
  assertRejected("m.csv", new Uint8Array([0x80, 0x04, 1, 2]));
  assertRejected("m.jsonl", new Uint8Array([0x80, 0x05, 1, 2]));
  assertRejected("m.txt", new Uint8Array([0x80, 0x04]));
  // 扩展名大小写不敏感：大写扩展名同样被拒
  assertRejected("M.CSV", new Uint8Array([0x80, 0x05]));
});

Deno.test("prediction-format: 拒绝含 NUL 的文本格式", () => {
  assertRejected("m.csv", new Uint8Array([0x61, 0x00, 0x62]));
  assertRejected("m.jsonl", new Uint8Array([0x7b, 0x00]));
  assertRejected("m.txt", new Uint8Array([0x00]));
});

Deno.test("prediction-format: 拒绝未知扩展名", () => {
  assertRejected("m.exe", new Uint8Array([0x4d, 0x5a]));
  assertRejected("m.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  assertRejected("m", new Uint8Array([0x61]));
});

Deno.test("prediction-format: 拒绝魔数不匹配的 npy/npz/parquet", () => {
  // .npy 魔数错误
  assertRejected("m.npy", new Uint8Array([0x00, 0x01, 0x02]));
  // .npz 魔数错误（非 PK）
  assertRejected("m.npz", new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]));
  // .parquet 魔数错误
  assertRejected("m.parquet", new Uint8Array([0x50, 0x41, 0x52, 0x32]));
});

Deno.test("prediction-format: 空文件对二进制格式拒绝、文本格式放行", () => {
  assertRejected("m.npy", new Uint8Array(0));
  assertRejected("m.npz", new Uint8Array(0));
  assertRejected("m.parquet", new Uint8Array(0));
  // 空文本文件不含 NUL，交由评测脚本按格式错误处理
  validatePredictionFile("m.csv", new Uint8Array(0));
});

Deno.test("prediction-format: 扩展名提取（大小写、无扩展名）", () => {
  assertEquals(predictionFileExtension("A.CSV"), ".csv");
  assertEquals(predictionFileExtension("m.npz"), ".npz");
  assertEquals(predictionFileExtension("noext"), "");
  // 路径式文件名取最后一段扩展名（路由层传 basename，这里保守处理）
  assertEquals(predictionFileExtension("a.b.parquet"), ".parquet");
});
