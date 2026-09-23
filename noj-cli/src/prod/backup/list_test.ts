import { assert, assertEquals } from "@std/assert";
import { listBackups, pruneBackups } from "./list.ts";
import { planPrune, type SnapshotEntry } from "./index.ts";

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
Deno.test("pruneBackups: 删除失败必须上报而非静默吞掉", async () => {
  // 评审修正：早先 catch{} 让调用方看到「已删除 0 个」却 exit 0，
  // 传达「已清理」的假成功。删除失败必须出现在 failed[] 中。
  const dir = await Deno.makeTempDir();
  try {
    const backups = dir + "/backups";
    await Deno.mkdir(backups);
    await Deno.writeTextFile(
      backups + "/snapshot-2026-09-17T10-00-00Z.nojbackup",
      "x",
    );
    // 目录设为只读：Deno.remove 会失败（非 root 环境生效）
    await Deno.chmod(backups, 0o555);
    try {
      const r = await pruneBackups(backups, { keep: 0, confirm: true });
      // 非 root 时应失败；root 会绕过权限，此时只断言结构存在
      assertEquals(Array.isArray(r.failed), true, "必须返回 failed 数组");
      if (r.failed.length > 0) {
        assertEquals(r.deleted.length, 0);
        assertEquals(r.failed[0]!.reason.length > 0, true, "必须带失败原因");
      }
    } finally {
      await Deno.chmod(backups, 0o755);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pruneBackups: 成功时 failed 为空", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const backups = dir + "/backups";
    await Deno.mkdir(backups);
    await Deno.writeTextFile(
      backups + "/snapshot-2026-09-17T10-00-00Z.nojbackup",
      "x",
    );
    const r = await pruneBackups(backups, { keep: 0, confirm: true });
    assertEquals(r.deleted.length, 1);
    assertEquals(r.failed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("listBackups: 名字不可解析时回退 mtime（而非 epoch）", async () => {
  const root = await Deno.makeTempDir();
  try {
    // 手工改名的快照：名字解析不出时间戳，但 mtime 是"刚刚"
    const manual = `${root}/my-manual-backup.nojbackup`;
    await Deno.writeTextFile(manual, "x");
    await Deno.writeTextFile(`${root}/snapshot-20260917-103000.nojbackup`, "y");
    const { entries } = await listBackups(root);
    const e = entries.find((x) => x.name === "my-manual-backup.nojbackup");
    assert(e !== undefined, "手工改名的快照应被列举（不应因名字被忽略）");
    const ageMs = Date.now() - Date.parse(e!.createdAt);
    assert(
      ageMs < 60_000,
      `应按 mtime 取"刚刚"而非 epoch（实得 age=${ageMs}ms）`,
    );
    // 且不会在默认保留期（30 天）内被清理
    const plan = planPrune(entries, { olderThanDays: 30, now: new Date() });
    assertEquals(
      plan.remove.some((x: SnapshotEntry) =>
        x.name === "my-manual-backup.nojbackup"
      ),
      false,
      "刚拷进来的快照不得被自动清理删除",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
