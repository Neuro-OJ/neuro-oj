import { assertEquals } from "@std/assert";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
import { fileSha256Hex, realDriver, sha256Hex } from "./backup_driver.ts";

/** 记录 run 调用的 fake runner。 */
function recordingRunner(records: string[][]): CommandRunner {
  return {
    run(cmd, args) {
      records.push([cmd, ...args]);
      return Promise.resolve(
        { code: 0, stdout: "", stderr: "" } satisfies CmdResult,
      );
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

Deno.test("sha256Hex: SHA-256 已知摘要", async () => {
  const h = await sha256Hex(new TextEncoder().encode("abc"));
  assertEquals(
    h,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("fileSha256Hex: 读文件算摘要", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/a.txt`;
  await Deno.writeTextFile(p, "hello");
  const h = await fileSha256Hex(p);
  assertEquals(
    h,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("realDriver.archive: tar -I zstd -<level> -cf", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  await d.archive("/s", "/out.tar.zst", 15);
  assertEquals(records[0], [
    "tar",
    "-I",
    "zstd -15",
    "-cf",
    "/out.tar.zst",
    "-C",
    "/s",
    ".",
  ]);
});

Deno.test("realDriver.extract: tar -I zstd -xf", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  const dir = await Deno.makeTempDir();
  const dest = `${dir}/d`;
  await d.extract("/a.tar.zst", dest);
  assertEquals(records[0], [
    "tar",
    "-I",
    "zstd",
    "-xf",
    "/a.tar.zst",
    "-C",
    dest,
  ]);
});

Deno.test("realDriver.gpgEncrypt: --symmetric AES256", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  await d.gpgEncrypt("/src.tar.zst", "/out.nojbackup", "/pw.txt");
  assertEquals(records[0], [
    "gpg",
    "--batch",
    "--yes",
    "--symmetric",
    "--cipher-algo",
    "AES256",
    "--passphrase-file",
    "/pw.txt",
    "--output",
    "/out.nojbackup",
    "/src.tar.zst",
  ]);
});
