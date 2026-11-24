/**
 * `deploy/install.sh`（一键部署脚本）的行为回归。
 *
 * 用 `file://` 伪造一个 Release 目录：假二进制只回显参数。平台与 Docker 检查
 * 用测试开关跳过（CI 与开发机未必是 Linux + Docker），其余路径全部真实执行。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { fromFileUrl, join } from "jsr:@std/path@^1";

const SCRIPT = fromFileUrl(new URL("../../deploy/install.sh", import.meta.url));
const VERSION = "v9.9.9";
const BIN = "noj-cli-linux-amd64";

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 建一个假 Release；`tamper` 为真时让二进制与校验文件不一致。 */
async function fakeRelease(root: string, tamper = false): Promise<string> {
  const dir = join(root, "rel", "download", VERSION);
  await Deno.mkdir(dir, { recursive: true });
  const body = new TextEncoder().encode(
    '#!/usr/bin/env bash\necho "FAKE-NOJ-CLI $*"\n',
  );
  await Deno.writeFile(join(dir, BIN), body);
  const hash = await sha256Hex(body);
  await Deno.writeTextFile(
    join(dir, `${BIN}.sha256`),
    `${tamper ? "0".repeat(64) : hash}  ${BIN}\n`,
  );
  return `file://${join(root, "rel")}`;
}

async function hasSha256sum(): Promise<boolean> {
  try {
    const out = await new Deno.Command("sha256sum", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

async function runScript(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  const out = await new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    env: {
      NOJ_INSTALL_SKIP_PLATFORM_CHECK: "1",
      NOJ_INSTALL_SKIP_DOCKER_CHECK: "1",
      ...env,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    out: dec.decode(out.stdout) + dec.decode(out.stderr),
  };
}

const canRun = await hasSha256sum();

Deno.test({
  name: "install.sh：校验通过后以同一标签调用 noj-cli install 并透传参数",
  ignore: !canRun,
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const base = await fakeRelease(root);
      const dir = join(root, "inst");
      const r = await runScript(
        ["--version", VERSION, "--dir", dir, "--", "--yes"],
        { NOJ_INSTALL_BASE_URL: base },
      );
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        r.out,
        `FAKE-NOJ-CLI install --dir ${dir} --ref ${VERSION} --yes`,
      );
      assert((await Deno.stat(dir)).isDirectory, "安装目录应被创建");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "install.sh：SHA-256 不一致时中止且绝不执行二进制",
  ignore: !canRun,
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const base = await fakeRelease(root, true);
      const r = await runScript(
        ["--version", VERSION, "--dir", join(root, "inst")],
        { NOJ_INSTALL_BASE_URL: base },
      );
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "SHA-256 校验失败");
      assertEquals(r.out.includes("FAKE-NOJ-CLI"), false, r.out);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("install.sh：拒绝 main/latest 等可变标签", async () => {
  const r = await runScript(["--version", "main"], {
    NOJ_INSTALL_BASE_URL: "file:///nonexistent",
  });
  assertEquals(r.code, 1, r.out);
  assertStringIncludes(r.out, "版本标签格式不合法");
});

Deno.test("install.sh：bash 语法检查", async () => {
  const out = await new Deno.Command("bash", { args: ["-n", SCRIPT] })
    .output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
});
