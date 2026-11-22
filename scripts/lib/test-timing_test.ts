/**
 * 测试阶段计时记录器单元测试。
 *
 * 覆盖：默认关闭、JSONL 落盘、异常仍记录并原样抛出、每个记录器独立文件、
 * 计数记录、写入失败不影响测试结果。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createTestTimingRecorder,
  type TestTimingRecord,
  type TestTimingRecorderOptions,
} from "./test-timing.ts";

function readRecords(file: string): TestTimingRecord[] {
  return Deno.readTextFileSync(file)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TestTimingRecord);
}

function recorderOptions(
  directory: string,
  overrides: TestTimingRecorderOptions = {},
): TestTimingRecorderOptions {
  return {
    enabled: true,
    directory,
    runId: "run-test",
    shard: "shard-a",
    fileSuffix: "suffix",
    ...overrides,
  };
}

Deno.test("test-timing: 默认关闭时不创建文件", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const recorder = createTestTimingRecorder({
      enabled: false,
      directory: dir,
      fileSuffix: "off",
    });
    assertEquals(recorder.enabled, false);
    await recorder.measure("reset", () => Promise.resolve(1));
    const entries = [...Deno.readDirSync(dir)];
    assertEquals(entries.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-timing: 开启时按阶段写 JSONL", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const recorder = createTestTimingRecorder(recorderOptions(dir));
    await recorder.measure("db:reset", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }, { file: "tests/db/reset-db.test.ts", caseName: "reset" });
    recorder.count("llm:gate-arrival", 2, { file: "e2e/x.test.ts" });

    const records = readRecords(`${dir}/shard-a-suffix.jsonl`);
    assertEquals(records.length, 2);
    assertEquals(records[0]!.version, 1);
    assertEquals(records[0]!.runId, "run-test");
    assertEquals(records[0]!.shard, "shard-a");
    assertEquals(records[0]!.phase, "db:reset");
    assertEquals(records[0]!.success, true);
    assertEquals(records[0]!.file, "tests/db/reset-db.test.ts");
    assertEquals(records[0]!.durationMs >= 5, true);
    assertEquals(records[1]!.count, 2);
    assertEquals(records[1]!.durationMs, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-timing: 异常阶段记录失败后原样抛出", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const recorder = createTestTimingRecorder(recorderOptions(dir));
    await assertRejects(
      () =>
        recorder.measure("template:migrate", () => {
          throw new Error("迁移失败");
        }),
      Error,
      "迁移失败",
    );
    const records = readRecords(`${dir}/shard-a-suffix.jsonl`);
    assertEquals(records.length, 1);
    assertEquals(records[0]!.success, false);
    assertEquals(records[0]!.phase, "template:migrate");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-timing: 两个记录器不会互相覆盖", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const first = createTestTimingRecorder(
      recorderOptions(dir, { fileSuffix: "a" }),
    );
    const second = createTestTimingRecorder(
      recorderOptions(dir, { fileSuffix: "b" }),
    );
    await first.measure("browser:launch", () => Promise.resolve());
    await second.measure("browser:launch", () => Promise.resolve());
    assertEquals(readRecords(`${dir}/shard-a-a.jsonl`).length, 1);
    assertEquals(readRecords(`${dir}/shard-a-b.jsonl`).length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-timing: 写入失败不改变测试结果", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const recorder = createTestTimingRecorder(
      recorderOptions(dir, {
        writeLine: () => {
          throw new Error("磁盘只读");
        },
      }),
    );
    const value = await recorder.measure("child", () => Promise.resolve(42));
    assertEquals(value, 42);
    // 写入失败后停止再写，但测量本身继续可用。
    await recorder.measure("child", () => Promise.resolve());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
