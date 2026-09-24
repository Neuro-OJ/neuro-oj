/**
 * T16 版本解析与版本配置落盘测试。
 *
 * 全部使用**注入的 fetcher**（`Fetcher`，与 T9 `bootstrap.ts` 同一类型），
 * **绝不触网**；文件系统只用临时目录。
 *
 * 逐条覆盖任务书 Step 1 的验收：
 * - 版本解析：draft / prerelease 被排除、缺资产被排除、选中最新合规 tag、
 *   无合规版本 → 报错；
 * - 标签校验：非法 tag 被拒；`v0.1.0` / `0.1.0` 通过；
 * - `write_config_version` 语义：**仅替换 `NOJ_VERSION`**，保留注释/其它键/顺序；
 * - 暂存 → 提交的两段式（失败不污染原配置）。
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { Fetcher } from "./bootstrap.ts";
import {
  commitConfigVersion,
  configuredVersion,
  DEFAULT_UPDATE_REPOSITORY,
  envMissingHint,
  httpsOnlyHint,
  normalizedVersion,
  releaseListHint,
  releasesApiUrl,
  releaseTagHint,
  resolveLatestReleaseTag,
  stageConfigVersion,
  UPDATE_API_URL_HINT,
  UPDATE_RELEASE_ASSETS,
  validateReleaseTag,
  versionConfigText,
  versionMissingHint,
  writeConfigVersion,
} from "./release.ts";

/** 升级要求就绪的资产（与 UPDATE_RELEASE_ASSETS 同源，测试里显式列出便于核对）。 */
const READY_ASSETS = [
  "noj-cli-linux-amd64",
  "noj-cli-linux-amd64.sha256",
  "docker-compose.prod.yml",
  "docker-compose.prod.yml.sha256",
  ".env.prod.example",
  ".env.prod.example.sha256",
];

/** 资产就绪的稳定 Release 条目。 */
function ready(tag: string): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: READY_ASSETS.map((name) => ({ name })),
  };
}

/** 返回固定 JSON 的 fetcher，并记录请求 URL。 */
function jsonFetcher(body: unknown, status = 200): {
  fetcher: Fetcher;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher: Fetcher = (url) => {
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetcher, calls };
}

// ---------------- 版本解析 ----------------

Deno.test("T16 resolveLatestReleaseTag：排除 draft/prerelease，选中最新资产就绪 tag", async () => {
  const { fetcher, calls } = jsonFetcher([
    ready("v0.3.0-rc.1"),
    { tag_name: "v0.3.0", draft: true, prerelease: false, assets: [] },
    // 缺 compose 资产 → 未就绪（issue #431）
    {
      tag_name: "v0.2.9",
      draft: false,
      prerelease: false,
      assets: [
        { name: "noj-cli-linux-amd64" },
        { name: "noj-cli-linux-amd64.sha256" },
      ],
    },
    ready("v0.2.8"),
  ]);
  const tag = await resolveLatestReleaseTag({ fetcher });
  assertEquals(tag, "v0.2.8");
  // 不得使用 /releases/latest（issue #431）
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0],
    "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases?per_page=100",
  );
});

Deno.test("T16 resolveLatestReleaseTag：prerelease 后缀（rc）不算稳定版本", async () => {
  const { fetcher } = jsonFetcher([
    {
      tag_name: "0.1.1-rc.1",
      draft: false,
      prerelease: false,
      assets: READY_ASSETS.map((name) => ({ name })),
    },
    ready("v0.1.0"),
  ]);
  assertEquals(await resolveLatestReleaseTag({ fetcher }), "v0.1.0");
});

Deno.test("T16 resolveLatestReleaseTag：无合规版本 → 报错", async () => {
  const { fetcher } = jsonFetcher([
    { tag_name: "v0.2.0", draft: false, prerelease: false, assets: [] },
    ready("v0.3.0-rc.1"),
  ]);
  await assertRejects(
    () => resolveLatestReleaseTag({ fetcher }),
    Error,
    "没有发现资产就绪的正式 Release",
  );
});

Deno.test("T16 resolveLatestReleaseTag：HTTP 失败 → 可操作文案（含状态码）", async () => {
  const { fetcher } = jsonFetcher({ message: "rate limit" }, 403);
  await assertRejects(
    () => resolveLatestReleaseTag({ fetcher }),
    Error,
    releaseListHint(403),
  );
});

Deno.test("T16 resolveLatestReleaseTag：响应非 JSON → 同样的可操作文案", async () => {
  const fetcher: Fetcher = () =>
    Promise.resolve(new Response("<html>oops</html>", { status: 200 }));
  await assertRejects(
    () => resolveLatestReleaseTag({ fetcher }),
    Error,
    "无法获取 Release 列表",
  );
});

Deno.test("T16 resolveLatestReleaseTag：单个 Release 对象（自定义 API）需显式非 draft/prerelease", async () => {
  const ok = jsonFetcher({
    tag_name: "v0.4.0",
    draft: false,
    prerelease: false,
    assets: [],
  });
  assertEquals(
    await resolveLatestReleaseTag({
      apiUrl: "https://example.test/release.json",
      fetcher: ok.fetcher,
    }),
    "v0.4.0",
  );

  for (
    const bad of [
      { tag_name: "v0.4.0", prerelease: false }, // draft 字段缺失
      { tag_name: "v0.4.0", draft: false, prerelease: true },
      { tag_name: "", draft: false, prerelease: false },
    ]
  ) {
    const { fetcher } = jsonFetcher(bad);
    await assertRejects(
      () =>
        resolveLatestReleaseTag({
          apiUrl: "https://example.test/release.json",
          fetcher,
        }),
      Error,
      "GitHub 返回的最新 Release 无效或仍是预发布版本",
    );
  }
});

Deno.test("T16 releasesApiUrl：仓库形态、自定义 API、HTTPS 与 .git 归一", () => {
  assertEquals(
    releasesApiUrl({}),
    "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases?per_page=100",
  );
  assertEquals(
    releasesApiUrl({ repository: "https://github.com/Neuro-OJ/neuro-oj/" }),
    "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases?per_page=100",
  );
  // bash 会把 .git 拼进 URL 而必然 404；本实现与 install.sh 对齐剥掉
  assertEquals(
    releasesApiUrl({ repository: "https://github.com/Neuro-OJ/neuro-oj.git" }),
    "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases?per_page=100",
  );
  assertEquals(
    releasesApiUrl({
      repository: "https://gitlab.test/x/y",
      apiUrl: "https://api.test/releases",
    }),
    "https://api.test/releases",
  );
  // 自定义 API 也必须 HTTPS
  let error: Error | null = null;
  try {
    releasesApiUrl({ apiUrl: "http://api.test/releases" });
  } catch (err) {
    error = err as Error;
  }
  assertEquals(error?.message, httpsOnlyHint("http://api.test/releases"));
  // 非 github.com 且无自定义 API → 明确报错，不回退
  error = null;
  try {
    releasesApiUrl({ repository: "https://gitlab.test/x/y" });
  } catch (err) {
    error = err as Error;
  }
  assertEquals(error?.message, UPDATE_API_URL_HINT);
});

Deno.test("T16 validateReleaseTag：非法 tag 被拒，v0.1.0 / 0.1.0 通过", () => {
  assertEquals(validateReleaseTag("v0.1.0"), "v0.1.0");
  assertEquals(validateReleaseTag("0.1.0"), "0.1.0");
  for (
    const bad of ["latest", "v0.1", "0.1.0-rc.1", "v1.2.3.4", "", " 0.1.0"]
  ) {
    let message = "";
    try {
      validateReleaseTag(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assertEquals(message, releaseTagHint(bad), "非法 tag 必须被拒：" + bad);
  }
});

Deno.test("T16 UPDATE_RELEASE_ASSETS：含 CLI 与 compose/example 的资产及其校验文件", () => {
  assertEquals([...UPDATE_RELEASE_ASSETS].sort(), [...READY_ASSETS].sort());
});

Deno.test("T16 normalizedVersion：比较时归一 v 前缀，写入时保留原文", () => {
  assertEquals(normalizedVersion("v0.9.5"), "0.9.5");
  assertEquals(normalizedVersion("0.9.5"), "0.9.5");
  assertEquals(normalizedVersion("v0.9.5"), normalizedVersion("0.9.5"));
});

// ---------------- 配置版本读写 ----------------

const ENV_TEXT = [
  "# NOJ 生产配置",
  "NOJ_VERSION=v0.9.5",
  "",
  "# 站点",
  "DOMAIN=oj.test-oj.cn",
  "NOJ_VERSION=v0.9.5",
  "APP_URL=https://oj.test-oj.cn",
  "",
].join("\n");

Deno.test("T16 versionConfigText：仅替换 NOJ_VERSION，保留注释/其它键/顺序", () => {
  const out = versionConfigText(ENV_TEXT, "v0.10.0");
  assertEquals(out.split("\n"), [
    "# NOJ 生产配置",
    "NOJ_VERSION=v0.10.0",
    "",
    "# 站点",
    "DOMAIN=oj.test-oj.cn",
    "NOJ_VERSION=v0.10.0",
    "APP_URL=https://oj.test-oj.cn",
    "",
  ]);
});

Deno.test("T16 versionConfigText：值未变时逐字节幂等（不重写、不剥引号）", () => {
  const quoted = 'NOJ_VERSION="v0.9.5"\nDOMAIN=x\n';
  assertEquals(versionConfigText(quoted, "v0.9.5"), quoted);
});

Deno.test("T16 versionConfigText：缺 NOJ_VERSION 时追加到末尾", () => {
  const text = "DOMAIN=oj.test-oj.cn\n";
  assertEquals(
    versionConfigText(text, "v0.9.5"),
    "DOMAIN=oj.test-oj.cn\nNOJ_VERSION=v0.9.5\n",
  );
});

Deno.test("T16 configuredVersion：读值、剥引号、缺文件与缺键分别报错", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const envFile = join(dir, ".env.prod");
    await Deno.writeTextFile(envFile, 'NOJ_VERSION="v0.9.5"\nDOMAIN=x\n');
    assertEquals(await configuredVersion(envFile), "v0.9.5");

    await Deno.writeTextFile(envFile, "DOMAIN=x\n");
    await assertRejects(
      () => configuredVersion(envFile),
      Error,
      versionMissingHint(envFile),
    );

    const missing = join(dir, "nope/.env.prod");
    await assertRejects(
      () => configuredVersion(missing),
      Error,
      envMissingHint(missing),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T16 writeConfigVersion：原子写且权限 600、其它键与注释不动", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const envFile = join(dir, ".env.prod");
    await Deno.writeTextFile(envFile, ENV_TEXT);
    await Deno.chmod(envFile, 0o600);

    await writeConfigVersion(envFile, "v0.10.0");
    assertEquals(
      await Deno.readTextFile(envFile),
      versionConfigText(
        ENV_TEXT.replace(/v0\.9\.5/g, "v0.9.5"),
        "v0.10.0",
      ),
    );
    assertEquals(((await Deno.stat(envFile)).mode ?? 0) & 0o777, 0o600);
    assertStringIncludes(await Deno.readTextFile(envFile), "# NOJ 生产配置");

    // 目录内不得残留临时文件
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, [".env.prod"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T16 stageConfigVersion + commitConfigVersion：两段式提交（暂存不改原文件）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const envFile = join(dir, ".env.prod");
    await Deno.writeTextFile(envFile, ENV_TEXT);
    await Deno.chmod(envFile, 0o600);

    const staged = await stageConfigVersion(envFile, "v0.10.0");
    // 暂存期间原配置**逐字节不变**（升级失败时可安全丢弃）
    assertEquals(await Deno.readTextFile(envFile), ENV_TEXT);
    assertEquals(((await Deno.stat(staged)).mode ?? 0) & 0o777, 0o600);
    assertStringIncludes(
      await Deno.readTextFile(staged),
      "NOJ_VERSION=v0.10.0",
    );

    await commitConfigVersion(staged, envFile);
    assertEquals(await configuredVersion(envFile), "v0.10.0");
    assertEquals(((await Deno.stat(envFile)).mode ?? 0) & 0o777, 0o600);
    // 提交后暂存文件已被 rename 掉
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, [".env.prod"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T16 stageConfigVersion：原配置缺失 → 报错且不落任何文件", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const envFile = join(dir, ".env.prod");
    await assertRejects(
      () => stageConfigVersion(envFile, "v0.10.0"),
      Error,
      envMissingHint(envFile),
    );
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T16 commitConfigVersion：暂存文件不存在 → 明确报错（半完成状态可诊断）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const envFile = join(dir, ".env.prod");
    await Deno.writeTextFile(envFile, ENV_TEXT);
    await assertRejects(
      () => commitConfigVersion(join(dir, "missing.tmp"), envFile),
      Error,
      "升级成功但无法提交生产版本配置",
    );
    // 原配置未被破坏
    assertEquals(await Deno.readTextFile(envFile), ENV_TEXT);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("T16 DEFAULT_UPDATE_REPOSITORY：指向官方仓库", () => {
  assertEquals(
    DEFAULT_UPDATE_REPOSITORY,
    "https://github.com/Neuro-OJ/neuro-oj",
  );
});
