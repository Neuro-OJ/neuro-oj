import { assertEquals } from "@std/assert";
import {
  detectSnapshotFormat,
  parseBackupName,
  planPrune,
  type SnapshotEntry,
} from "./backup_index.ts";

Deno.test("detectSnapshotFormat: 单文件 .nojbackup 识别为 single", () => {
  assertEquals(
    detectSnapshotFormat({ name: "snapshot-2026.nojbackup", isDir: false }),
    "single",
  );
});

Deno.test("detectSnapshotFormat: 目录 + sha256sums.txt + SUCCESS 识别为 legacy", () => {
  assertEquals(
    detectSnapshotFormat({
      name: "snapshot-20260101-000000",
      isDir: true,
      entries: ["sha256sums.txt", "SUCCESS", "postgres.dump"],
    }),
    "legacy",
  );
});

Deno.test("detectSnapshotFormat: 目录缺 SUCCESS 不算 legacy（避免误判）", () => {
  assertEquals(
    detectSnapshotFormat({
      name: "snapshot-x",
      isDir: true,
      entries: ["sha256sums.txt"],
    }),
    "unknown",
  );
});

Deno.test("detectSnapshotFormat: 无关文件为 unknown", () => {
  assertEquals(
    detectSnapshotFormat({ name: "readme.md", isDir: false }),
    "unknown",
  );
});

Deno.test("parseBackupName: 从 .nojbackup 文件名解析时间", () => {
  const ts = parseBackupName("snapshot-2026-09-17T10-30-00Z.nojbackup");
  assertEquals(ts?.toISOString(), "2026-09-17T10:30:00.000Z");
});

Deno.test("parseBackupName: 从 legacy 目录名解析时间", () => {
  const ts = parseBackupName("snapshot-20260917-103000");
  assertEquals(ts?.toISOString(), "2026-09-17T10:30:00.000Z");
});

Deno.test("parseBackupName: 无法解析返回 null（不抛错）", () => {
  assertEquals(parseBackupName("garbage"), null);
  assertEquals(parseBackupName("snapshot-bad-date.nojbackup"), null);
});

function entry(name: string, iso: string, bytes = 100): SnapshotEntry {
  return { name, path: "/b/" + name, createdAt: iso, bytes, format: "single" };
}

Deno.test("planPrune: --keep N 保留最近 N 份，其余待删", () => {
  const list = [
    entry("a", "2026-01-03T00:00:00Z"),
    entry("b", "2026-01-02T00:00:00Z"),
    entry("c", "2026-01-01T00:00:00Z"),
  ];
  const plan = planPrune(list, { keep: 2 });
  assertEquals(plan.keep.map((e) => e.name), ["a", "b"]);
  assertEquals(plan.remove.map((e) => e.name), ["c"]);
});

Deno.test("planPrune: --older-than DAYS 只删超过阈值的", () => {
  const now = new Date("2026-01-10T00:00:00Z");
  const list = [
    entry("recent", "2026-01-09T00:00:00Z"),
    entry("old", "2026-01-01T00:00:00Z"),
  ];
  const plan = planPrune(list, { olderThanDays: 5, now });
  assertEquals(plan.remove.map((e) => e.name), ["old"]);
  assertEquals(plan.keep.map((e) => e.name), ["recent"]);
});

Deno.test("planPrune: 两个条件同时给出时取交集（都满足才删）", () => {
  const now = new Date("2026-01-10T00:00:00Z");
  const list = [
    entry("newest", "2026-01-09T00:00:00Z"),
    entry("mid", "2026-01-05T00:00:00Z"),
    entry("oldest", "2026-01-01T00:00:00Z"),
  ];
  // keep=1 保住 newest；olderThan=5 只匹配 oldest；
  // 交集 => 只有既不在 keep 内、又超龄的才删（oldest）
  const plan = planPrune(list, { keep: 1, olderThanDays: 5, now });
  assertEquals(plan.remove.map((e) => e.name), ["oldest"]);
});

Deno.test("planPrune: 无参数时不删任何东西（安全默认）", () => {
  const list = [entry("a", "2026-01-01T00:00:00Z")];
  const plan = planPrune(list, {});
  assertEquals(plan.remove.length, 0);
  assertEquals(plan.keep.length, 1);
});

Deno.test("planPrune: legacy 目录默认不删（除非显式 includeLegacy）", () => {
  const list: SnapshotEntry[] = [
    { ...entry("new", "2026-01-02T00:00:00Z") },
    { ...entry("legacy", "2026-01-01T00:00:00Z"), format: "legacy" },
  ];
  const plan = planPrune(list, { keep: 0 });
  assertEquals(plan.remove.map((e) => e.name), ["new"]);
  assertEquals(plan.keep.map((e) => e.name), ["legacy"]);

  const withLegacy = planPrune(list, { keep: 0, includeLegacy: true });
  assertEquals(
    withLegacy.remove.map((e) => e.name).sort(),
    ["legacy", "new"],
  );
});

Deno.test("planPrune: 列表按时间倒序返回，便于展示", () => {
  const list = [
    entry("c", "2026-01-01T00:00:00Z"),
    entry("a", "2026-01-03T00:00:00Z"),
    entry("b", "2026-01-02T00:00:00Z"),
  ];
  const plan = planPrune(list, { keep: 3 });
  assertEquals(plan.keep.map((e) => e.name), ["a", "b", "c"]);
});
