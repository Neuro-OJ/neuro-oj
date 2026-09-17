import { assertEquals } from "@std/assert";
import { listBackups, pruneBackups } from "./backup_list.ts";

/** 建一个含单文件与旧目录备份的临时备份目录。 */
async function makeFixture(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    dir + "/snapshot-2026-09-17T10-00-00Z.nojbackup",
    "x".repeat(100),
  );
  await Deno.writeTextFile(
    dir + "/snapshot-2026-09-16T10-00-00Z.nojbackup",
    "y".repeat(50),
  );
  const legacy = dir + "/snapshot-20260915-100000";
  await Deno.mkdir(legacy);
  await Deno.writeTextFile(legacy + "/sha256sums.txt", "abc  postgres.dump\n");
  await Deno.writeTextFile(legacy + "/SUCCESS", "success\n");
  await Deno.writeTextFile(legacy + "/postgres.dump", "z".repeat(200));
  await Deno.writeTextFile(dir + "/README.md", "not a backup");
  return dir;
}

Deno.test("listBackups: 同时识别单文件与旧目录格式", async () => {
  const dir = await makeFixture();
  try {
    const { entries, ignored } = await listBackups(dir);
    const names = entries.map((e) => e.name);
    assertEquals(names.length, 3);
    assertEquals(
      names.includes("snapshot-20260915-100000"),
      true,
      "旧目录必须被识别",
    );
    assertEquals(
      entries.find((e) => e.name === "snapshot-20260915-100000")?.format,
      "legacy",
    );
    assertEquals(ignored.includes("README.md"), true);
    assertEquals(names[0], "snapshot-2026-09-17T10-00-00Z.nojbackup");
    assertEquals(names[2], "snapshot-20260915-100000");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("listBackups: 单文件大小来自 stat，目录大小递归求和", async () => {
  const dir = await makeFixture();
  try {
    const { entries } = await listBackups(dir);
    const single = entries.find((e) =>
      e.name.endsWith("09-17T10-00-00Z.nojbackup")
    )!;
    assertEquals(single.bytes, 100);
    const legacy = entries.find((e) => e.name === "snapshot-20260915-100000")!;
    assertEquals(legacy.bytes! >= 200, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("listBackups: 目录不存在时返回空列表而非抛错", async () => {
  const { entries } = await listBackups("/nonexistent-backup-dir-xyz");
  assertEquals(entries, []);
});

Deno.test("pruneBackups: 默认 dry-run 不删除任何文件", async () => {
  const dir = await makeFixture();
  try {
    const r = await pruneBackups(dir, { keep: 1 });
    assertEquals(r.deleted, []);
    assertEquals(r.plan.remove.length > 0, true, "应给出待删计划");
    const { entries } = await listBackups(dir);
    assertEquals(entries.length, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pruneBackups: --confirm 才真删", async () => {
  const dir = await makeFixture();
  try {
    const r = await pruneBackups(dir, { keep: 1, confirm: true });
    assertEquals(r.deleted.length > 0, true);
    const { entries } = await listBackups(dir);
    assertEquals(entries.length, 2, "最新单文件 + 受保护的 legacy 目录");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pruneBackups: 无参数时不删任何东西（安全默认）", async () => {
  const dir = await makeFixture();
  try {
    const r = await pruneBackups(dir, { confirm: true });
    assertEquals(r.deleted, []);
    assertEquals(r.plan.remove.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
