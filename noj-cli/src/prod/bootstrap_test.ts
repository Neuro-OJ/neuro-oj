/** bootstrap 测试：全部使用注入 fetcher，绝不触网。 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { makeTempDir } from "../testing/helpers.ts";
import { sha256Hex } from "../util/hash.ts";
import {
  downloadReleaseFiles,
  type Fetcher,
  RELEASE_FILES,
  releaseAssetUrl,
  validateRef,
  validateRepository,
  validateTargetDir,
} from "./bootstrap.ts";

const REPO = "https://github.com/Neuro-OJ/neuro-oj";
const REF = "0.9.5";
const COMPOSE = "docker-compose.prod.yml";
const ENV_EXAMPLE = ".env.prod.example";

const encoder = new TextEncoder();

/** 列出目录内的条目名（排序，便于逐字比较）。 */
async function dirNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

/** 目标目录内不得残留任何临时文件。 */
async function assertNoTempLeftovers(dir: string): Promise<void> {
  const leftovers = (await dirNames(dir)).filter((name) =>
    name.startsWith(".bootstrap-")
  );
  assertEquals(leftovers, []);
}

/** 构造确定性假 fetcher；checksumOverrides 可替换 .sha256 正文。 */
function makeFetcher(
  calls: string[],
  assets: Record<string, Uint8Array<ArrayBuffer>>,
  checksumOverrides: Record<string, string> = {},
): Fetcher {
  return async (url: string) => {
    calls.push(url);
    const name = url.split("/").pop() ?? "";
    if (name.endsWith(".sha256")) {
      const base = name.slice(0, -".sha256".length);
      const override = checksumOverrides[base];
      if (override !== undefined) {
        return new Response(override, { status: 200 });
      }
      const body = assets[base];
      if (body === undefined) return new Response("missing", { status: 404 });
      const digest = await sha256Hex(body);
      return new Response(`${digest}  ${base}\n`, { status: 200 });
    }
    const body = assets[name];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

/** 两个资产的默认假内容。 */
function fixtureAssets(): Record<string, Uint8Array<ArrayBuffer>> {
  return {
    [COMPOSE]: encoder.encode("services:\n  noj-server:\n    image: noj\n"),
    [ENV_EXAMPLE]: encoder.encode("NOJ_VERSION=0.9.5\nJWT_SECRET=\n"),
  };
}

Deno.test("downloadReleaseFiles: 成功下载、校验并逐字节写入目标目录", async () => {
  const dir = await makeTempDir();
  try {
    const assets = fixtureAssets();
    const calls: string[] = [];
    const files = await downloadReleaseFiles({
      repository: REPO,
      ref: REF,
      targetDir: dir,
      fetcher: makeFetcher(calls, assets),
    });

    assertEquals(files, [join(dir, COMPOSE), join(dir, ENV_EXAMPLE)]);
    assertEquals(await Deno.readFile(join(dir, COMPOSE)), assets[COMPOSE]);
    assertEquals(
      await Deno.readFile(join(dir, ENV_EXAMPLE)),
      assets[ENV_EXAMPLE],
    );
    // URL 形状：<repo>/releases/download/<ref>/<asset>[.sha256]
    assertEquals(calls, [
      `${REPO}/releases/download/${REF}/${COMPOSE}`,
      `${REPO}/releases/download/${REF}/${COMPOSE}.sha256`,
      `${REPO}/releases/download/${REF}/${ENV_EXAMPLE}`,
      `${REPO}/releases/download/${REF}/${ENV_EXAMPLE}.sha256`,
    ]);
    await assertNoTempLeftovers(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 大写十六进制摘要同样通过校验", async () => {
  const dir = await makeTempDir();
  try {
    const assets = fixtureAssets();
    const upper: Record<string, string> = {};
    for (const name of RELEASE_FILES) {
      upper[name] = (await sha256Hex(assets[name]!)).toUpperCase();
    }
    await downloadReleaseFiles({
      repository: REPO,
      ref: REF,
      targetDir: dir,
      fetcher: makeFetcher([], assets, upper),
    });
    assertEquals(await Deno.readFile(join(dir, COMPOSE)), assets[COMPOSE]);
    assertEquals(
      await Deno.readFile(join(dir, ENV_EXAMPLE)),
      assets[ENV_EXAMPLE],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 第二个文件校验失败时不写入任何文件", async () => {
  const dir = await makeTempDir();
  try {
    const assets = fixtureAssets();
    const calls: string[] = [];
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir: dir,
          // 第一个文件校验通过，第二个失败：证明"全部通过才提交"。
          fetcher: makeFetcher(calls, assets, {
            [ENV_EXAMPLE]: "0".repeat(64),
          }),
        }),
      Error,
      "SHA-256 校验失败",
    );
    assertEquals(await dirNames(dir), []);
    await assertNoTempLeftovers(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 校验失败时不覆盖已存在的目标文件", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), "original\n");
    const assets = fixtureAssets();
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir: dir,
          overwrite: true,
          fetcher: makeFetcher([], assets, { [COMPOSE]: "f".repeat(64) }),
        }),
      Error,
      "SHA-256 校验失败",
    );
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), "original\n");
    assertEquals(await dirNames(dir), [COMPOSE]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 校验文件非 64 位 hex 时抛错且不落盘", async () => {
  const dir = await makeTempDir();
  try {
    const assets = fixtureAssets();
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir: dir,
          fetcher: makeFetcher([], assets, { [COMPOSE]: "not-a-sha256\n" }),
        }),
      Error,
      "校验文件格式非法",
    );
    assertEquals(await dirNames(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 目标文件已存在时默认拒绝覆盖且不发起请求", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), "user-edited\n");
    const calls: string[] = [];
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir: dir,
          fetcher: makeFetcher(calls, fixtureAssets()),
        }),
      Error,
      "已存在同名文件",
    );
    assertEquals(calls, []);
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), "user-edited\n");
    assertEquals(await dirNames(dir), [COMPOSE]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: overwrite=true 时原子覆盖现有文件", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), "stale\n");
    await Deno.writeTextFile(join(dir, ENV_EXAMPLE), "stale\n");
    const assets = fixtureAssets();
    await downloadReleaseFiles({
      repository: REPO,
      ref: REF,
      targetDir: dir,
      overwrite: true,
      fetcher: makeFetcher([], assets),
    });
    assertEquals(await Deno.readFile(join(dir, COMPOSE)), assets[COMPOSE]);
    assertEquals(
      await Deno.readFile(join(dir, ENV_EXAMPLE)),
      assets[ENV_EXAMPLE],
    );
    await assertNoTempLeftovers(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 提交阶段第二个 rename 失败时整体回滚", async () => {
  const dir = await makeTempDir();
  try {
    // 第一个目标：已存在的旧文件（可被备份 + 覆盖）。
    await Deno.writeTextFile(join(dir, COMPOSE), "旧 compose\n");
    // 第二个目标：占位目录，令 rename(tmp, target) 以 EISDIR 失败，
    // 从而在"第一个已提交"之后制造失败点。
    await Deno.mkdir(join(dir, ENV_EXAMPLE));

    const assets = fixtureAssets();
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir: dir,
          overwrite: true,
          fetcher: makeFetcher([], assets),
        }),
      Error,
    );

    // 回滚生效：第一个目标必须是原始字节，而非新下载的字节。
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), "旧 compose\n");
    // 目录不得残留备份或暂存文件（含 .bootstrap-*.tmp 与 .bootstrap-*.bak）。
    assertEquals(
      (await dirNames(dir)).filter((n) => n.startsWith(".bootstrap-")),
      [],
    );
    // 失败点自身的占位目录仍在（不属于本次提交的产物）。
    assertEquals((await Deno.stat(join(dir, ENV_EXAMPLE))).isDirectory, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 非 HTTPS 仓库被拒绝且不发起请求", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[] = [];
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: "http://github.com/Neuro-OJ/neuro-oj",
          ref: REF,
          targetDir: dir,
          fetcher: makeFetcher(calls, fixtureAssets()),
        }),
      Error,
      "HTTPS",
    );
    assertEquals(calls, []);
    assertEquals(await dirNames(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: 非法 ref 被拒绝且不发起请求", async () => {
  for (const ref of ["..", "/0.9.5", "0.9.5/", "0.9.5 rc", "a//b", ""]) {
    const dir = await makeTempDir();
    try {
      const calls: string[] = [];
      await assertRejects(
        () =>
          downloadReleaseFiles({
            repository: REPO,
            ref,
            targetDir: dir,
            fetcher: makeFetcher(calls, fixtureAssets()),
          }),
        Error,
        "Release ref 非法",
      );
      assertEquals(calls, []);
      assertEquals(await dirNames(dir), []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("downloadReleaseFiles: 下载 HTTP 404 时不落盘", async () => {
  const dir = await makeTempDir();
  try {
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir: dir,
          fetcher: () => Promise.resolve(new Response("nope", { status: 404 })),
        }),
      Error,
      "HTTP 404",
    );
    assertEquals(await dirNames(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadReleaseFiles: fetcher 抛出网络错误时不落盘", async () => {
  const dir = await makeTempDir();
  try {
    let seen = 0;
    const fetcher: Fetcher = () => {
      seen++;
      return Promise.reject(new Error("connection reset"));
    };
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir: dir,
          fetcher,
        }),
      Error,
      "connection reset",
    );
    assertEquals(seen, 1);
    assertEquals(await dirNames(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateRef: 接受版本号与分支路径两种形态", () => {
  for (
    const ref of ["0.9.5", "v0.9.5", "0.9.5-rc.1", "release/0.9.5", "a_b.c"]
  ) {
    validateRef(ref);
  }
});

Deno.test("validateTargetDir: 拒绝空 / 根 / 点目录 / 换行", () => {
  for (const dir of ["", "   ", "/", ".", "..", "/\n", "a\rb", "/opt/x\n"]) {
    assertThrows(() => validateTargetDir(dir), Error);
  }
});

Deno.test("validateTargetDir: 归一化后返回非空目录且不改写合法输入", () => {
  assertEquals(validateTargetDir("/opt/neuro-oj"), "/opt/neuro-oj");
  assertEquals(validateTargetDir("/opt/neuro-oj/"), "/opt/neuro-oj");
  assertEquals(validateTargetDir("relative/dir"), "relative/dir");
  assertEquals(validateTargetDir("relative/dir/"), "relative/dir");
});

Deno.test("downloadReleaseFiles: targetDir 为 / 或空时拒绝且不写入 CWD", async () => {
  const cwd = Deno.cwd();
  const before = await dirNames(cwd);
  for (const targetDir of ["/", "", "."]) {
    const calls: string[] = [];
    await assertRejects(
      () =>
        downloadReleaseFiles({
          repository: REPO,
          ref: REF,
          targetDir,
          fetcher: makeFetcher(calls, fixtureAssets()),
        }),
      Error,
      "安装目录不安全或为空",
    );
    assertEquals(calls, []);
  }
  // 关键回归：绝不把资产静默写进当前工作目录。
  assertEquals(await dirNames(cwd), before);
});

Deno.test("validateRepository: 归一化尾斜杠与 .git 后缀", () => {
  assertEquals(
    validateRepository("https://github.com/Neuro-OJ/neuro-oj/"),
    "https://github.com/Neuro-OJ/neuro-oj",
  );
  assertEquals(
    validateRepository("https://github.com/Neuro-OJ/neuro-oj.git"),
    "https://github.com/Neuro-OJ/neuro-oj",
  );
  assertThrows(() => validateRepository("http://x.test/a/b"), Error, "HTTPS");
});

Deno.test("releaseAssetUrl: 拼出 GitHub Release 资产地址", () => {
  assertEquals(
    releaseAssetUrl({
      repository: REPO,
      ref: REF,
      asset: COMPOSE,
    }),
    `${REPO}/releases/download/${REF}/${COMPOSE}`,
  );
});

Deno.test("release workflow: 发布 bootstrap 依赖的全部资产", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../../../.github/workflows/release.yml", import.meta.url),
  );
  const uploadAt = workflow.indexOf("gh release upload");
  assertEquals(uploadAt >= 0, true, "release.yml 缺少 gh release upload 步骤");
  const upload = workflow.slice(uploadAt);
  // 行锚定匹配：每个资产必须独占一行（可带续行反斜杠）。若退化为
  // substring 匹配，"x.yml.sha256" 会误命中 "x.yml"，删掉普通资产行也不报错。
  const lines = upload.split(/\r?\n/).map((line) => line.trim());
  const isListed = (asset: string): boolean =>
    lines.some((line) => line === asset || line === asset + " \\");
  for (const name of RELEASE_FILES) {
    for (const suffix of ["", ".sha256"]) {
      const asset = `${name}${suffix}`;
      assertEquals(
        isListed(asset),
        true,
        `Release 未发布 bootstrap 依赖的资产：${asset}`,
      );
    }
  }
});
