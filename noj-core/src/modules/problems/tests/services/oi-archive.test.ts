import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { buildOiArchive, readOiArchive } from "../../services/oi-archive.ts";
import { readEvaluationEntries } from "../../services/bundle-parser.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";

Deno.test("OI 归档 Worker 保留二进制及文本内容，处理期间主线程能继续响应", async () => {
  const entries = {
    "testdata/a.in": new Uint8Array(8 * 1024 * 1024).fill(65),
    "testdata/a.out": new Uint8Array([0, 255, 10]),
  };
  let finished = false;
  const building = buildOiArchive(entries).then((value) => {
    finished = true;
    return value;
  });
  let responded = false;
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      responded = true;
      resolve();
    }, 0)
  );
  assertEquals(responded, true);
  assertEquals(finished, false);
  const bytes = await building;
  const extracted = await readOiArchive(bytes);
  assertEquals(extracted, entries);
});

Deno.test("OI 配置校验仅扫描 ZIP 目录，不展开内容；保留路径安全规则", async () => {
  const paths: string[] = [];
  assertEquals(
    readEvaluationEntries(
      zipSync({ "data/1.in": new Uint8Array([1]) }),
      false,
      paths,
    ),
    {},
  );
  assertEquals(paths, ["data/1.in"]);
  const invalid = zipSync({ "../private": new Uint8Array([1]) });
  assertThrows(
    () => readEvaluationEntries(invalid, false, []),
    BadRequestError,
  );
  await assertRejects(() => readOiArchive(invalid), BadRequestError);
});
