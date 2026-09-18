import { assertEquals } from "@std/assert";
import {
  assertPassphraseFileMode,
  DEFAULT_PASSPHRASE_PATH,
  PassphraseModeError,
  resolveOrCreatePassphrase,
} from "./backup_passphrase.ts";

Deno.test("DEFAULT_PASSPHRASE_PATH 与生产脚本约定一致", () => {
  assertEquals(DEFAULT_PASSPHRASE_PATH, "/etc/noj/backup-passphrase");
});

Deno.test("assertPassphraseFileMode: 600/400 通过，其余拒绝", () => {
  assertPassphraseFileMode("600");
  assertPassphraseFileMode("400");
  for (const mode of ["644", "666", "777", "640"]) {
    let threw = false;
    try {
      assertPassphraseFileMode(mode);
    } catch (e) {
      threw = e instanceof PassphraseModeError;
    }
    assertEquals(threw, true, `mode ${mode} 应被拒绝`);
  }
});

Deno.test("assertPassphraseFileMode: 错误信息含实际权限与修复建议", () => {
  try {
    assertPassphraseFileMode("644");
  } catch (e) {
    const msg = (e as Error).message;
    assertEquals(msg.includes("644"), true);
    assertEquals(msg.includes("chmod"), true);
  }
});

Deno.test("resolveOrCreatePassphrase: 已存在则复用，不覆盖", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const p = dir + "/pass";
    await Deno.writeTextFile(p, "existing-secret\n");
    await Deno.chmod(p, 0o600);
    const result = await resolveOrCreatePassphrase({
      path: p,
      generate: false,
    });
    assertEquals(result.created, false);
    assertEquals(await Deno.readTextFile(p), "existing-secret\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveOrCreatePassphrase: 不存在且允许生成时创建 600 权限文件", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const p = dir + "/newpass";
    const result = await resolveOrCreatePassphrase({
      path: p,
      generate: true,
      randomHex: () => "a".repeat(64),
    });
    assertEquals(result.created, true);
    const mode = (await Deno.stat(p)).mode! & 0o777;
    assertEquals(mode.toString(8), "600");
    assertEquals((await Deno.readTextFile(p)).trim(), "a".repeat(64));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveOrCreatePassphrase: 不存在且不允许生成时报错", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let threw = false;
    try {
      await resolveOrCreatePassphrase({
        path: dir + "/missing",
        generate: false,
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveOrCreatePassphrase: 已存在但权限过宽时拒绝", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const p = dir + "/loose";
    await Deno.writeTextFile(p, "x");
    await Deno.chmod(p, 0o644);
    let threw = false;
    try {
      await resolveOrCreatePassphrase({ path: p, generate: true });
    } catch (e) {
      threw = e instanceof PassphraseModeError;
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
