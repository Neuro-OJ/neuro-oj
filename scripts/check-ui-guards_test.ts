/**
 * noj-ui 设计系统守卫的自测（2026-11-21）。
 *
 * 守三件必须永久成立的事：
 *   1. 探针文件能让七条规则**全部**命中——正则写坏时先在这里红，而不是安静地
 *      把基线锁死在一个"零命中"的假象上；
 *   2. 基线缺失 → 门禁失败（没有基线就不是棘轮）；
 *   3. 自检失败（扫不到 100 个 `.vue`）→ 门禁失败。
 *
 * 另含硬棘轮的**双向**用例：违规回流（+1）与修复后未更新基线（-1）都必须失败，
 * 否则"基线 167 → 当前 160 通过但不更新 → 下个 PR 加回 6 仍通过"的漏洞会回来。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  BASELINE_PATH,
  buildBaseline,
  checkUiGuards,
  REPO_ROOT,
} from "./check-ui-guards.ts";
import {
  detect,
  PROBE_EXPECTED,
  PROBE_SOURCE,
  RULE_NAMES,
  verifyProbe,
  zeroCounts,
} from "./lib/ui-guards-rules.ts";
import { scanUi } from "./lib/ui-guards-scan.ts";

/** 建一个只有 `noj-ui/` 的临时仓库根。 */
async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "ui-guards-" });
  for (const [rel, content] of Object.entries(files)) {
    const full = `${root}/noj-ui/${rel}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  return root;
}

/** 夹具用的基线文件路径（相对夹具根）。 */
const FIXTURE_BASELINE = "scripts/ui-guards-baseline.json";

async function writeFixtureBaseline(
  root: string,
  text: string,
): Promise<void> {
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  await Deno.writeTextFile(`${root}/${FIXTURE_BASELINE}`, text);
}

Deno.test("ui-guards: 探针源码让七条规则全部命中且计数逐条锁定", () => {
  const counts = detect(PROBE_SOURCE);
  for (const rule of RULE_NAMES) {
    assert(
      counts[rule] >= 1,
      `规则 ${rule} 在探针上零命中——规则已失效：${JSON.stringify(counts)}`,
    );
  }
  assertEquals(counts, PROBE_EXPECTED);
  assertEquals(verifyProbe(), []);
});

Deno.test("ui-guards: 探针文件在三个 scope 都被统计", async () => {
  const root = await makeRepo({ "pages/__guard_probe.vue": PROBE_SOURCE });
  try {
    const scan = await scanUi(root);
    assertEquals(scan.all.files, 1);
    assertEquals(scan.s1.files, 1);
    assertEquals(scan.public.files, 1);
    assertEquals(scan.all.counts, PROBE_EXPECTED);
    assertEquals(scan.s1.counts, PROBE_EXPECTED);
    assertEquals(scan.public.counts, PROBE_EXPECTED);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ui-guards: 反例不计数（CSS 变量 / 非文本 input / 颜色任意值 / 注释）", () => {
  const source = `<template>
  <div class="rounded rounded-md rounded-full rounded-tl-xl bg-primary text-text-muted
              animate-pulse transition-colors hover:bg-bg-panel">
    <input type="checkbox" />
    <input type="radio" />
    <input type="file" />
    <span class="text-[#e6edf3]">x</span>
    <!-- <button>注释里的按钮不算</button> -->
  </div>
</template>
<style>
  :root { --c-bg-dark: #0b0f19; --c-primary-dark: #0369a1; }
</style>
`;
  assertEquals(detect(source), zeroCounts());
});

Deno.test("ui-guards: 作用域排除（admin 不进 public/S1，S2 板块只不进 S1）", async () => {
  const root = await makeRepo({
    // admin：public 与 S1 都不进。
    "pages/admin/x.vue": PROBE_SOURCE,
    "layouts/admin.vue": PROBE_SOURCE,
    // S2 板块：public 计入，S1 豁免。
    "components/editor/y.vue": PROBE_SOURCE,
    "components/problem/ui/UiProblemFrame.vue": PROBE_SOURCE,
    "pages/settings.vue": PROBE_SOURCE,
    "pages/d/[slug]/settings/access.vue": PROBE_SOURCE,
    "pages/d/[slug]/settings/llm/quotas.vue": PROBE_SOURCE,
    "pages/d/[slug]/problems/new.vue": PROBE_SOURCE,
    "pages/problems/new/index.vue": PROBE_SOURCE,
    "pages/my/z.vue": PROBE_SOURCE,
    // S1 计入。
    "pages/home.vue": PROBE_SOURCE,
  });
  try {
    const scan = await scanUi(root);
    assertEquals(scan.all.files, 11);
    assertEquals(scan.public.files, 9);
    assertEquals(scan.s1.files, 1);
    for (const rule of RULE_NAMES) {
      assertEquals(
        scan.all.counts[rule],
        PROBE_EXPECTED[rule] * 11,
        `${rule} 应统计全部 11 个文件`,
      );
      assertEquals(scan.public.counts[rule], PROBE_EXPECTED[rule] * 9);
      assertEquals(scan.s1.counts[rule], PROBE_EXPECTED[rule]);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ui-guards: 基线缺失时门禁失败", async () => {
  const root = await makeRepo({ "pages/a.vue": PROBE_SOURCE });
  try {
    const { errors } = await checkUiGuards(root, { minScannedFiles: 0 });
    assert(
      errors.some((err) => err.includes("基线不可读")),
      `基线缺失必须失败，实际：${JSON.stringify(errors)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ui-guards: 自检失败——扫不到 100 个 .vue", async () => {
  const root = await makeRepo({ "pages/a.vue": PROBE_SOURCE });
  try {
    // 夹具只有 1 个 .vue，默认门槛 100 必须报错。
    const { errors } = await checkUiGuards(root);
    assert(
      errors.some((err) => err.includes("≥ 100")),
      `文件数自检必须失败，实际：${JSON.stringify(errors)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ui-guards: 硬棘轮——增长与下降都必须失败", async () => {
  const dirty =
    `<template><div class="rounded-xl bg-blue-500 text-13px">x</div></template>\n`;
  const dirtier =
    `<template><div class="rounded-xl rounded-2xl bg-blue-500 text-13px">x</div></template>\n`;
  const clean =
    `<template><div class="rounded-md bg-primary text-sm">x</div></template>\n`;
  const file = "noj-ui/pages/a.vue";
  const root = await makeRepo({ "pages/a.vue": dirty });
  try {
    // 基线 = 当前（3 处违规）→ 通过。
    const baseline = buildBaseline(await scanUi(root));
    await writeFixtureBaseline(root, JSON.stringify(baseline, null, 2) + "\n");
    let result = await checkUiGuards(root, { minScannedFiles: 0 });
    assertEquals(result.errors, []);

    // 修好但不更新基线（-1）→ 必须失败，否则额度永远留在旧基线。
    await Deno.writeTextFile(`${root}/${file}`, clean);
    result = await checkUiGuards(root, { minScannedFiles: 0 });
    assert(
      result.errors.some((err) =>
        err.includes("radius") && err.includes("减少")
      ),
      `下降必须失败，实际：${JSON.stringify(result.errors)}`,
    );

    // 回到基线状态 → 再次通过。
    await Deno.writeTextFile(`${root}/${file}`, dirty);
    result = await checkUiGuards(root, { minScannedFiles: 0 });
    assertEquals(result.errors, []);

    // 违规回流（+1）→ 必须失败。
    await Deno.writeTextFile(`${root}/${file}`, dirtier);
    result = await checkUiGuards(root, { minScannedFiles: 0 });
    assert(
      result.errors.some((err) =>
        err.includes("radius") && err.includes("增加")
      ),
      `增长必须失败，实际：${JSON.stringify(result.errors)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ui-guards: 真实仓库通过，且基线可由当前扫描原样复现", async () => {
  const { errors, scan } = await checkUiGuards(REPO_ROOT);
  assertEquals(errors, []);
  // 基线是提交物：必须与 --write-baseline 的输出逐字节一致（含键顺序）。
  assertEquals(
    await Deno.readTextFile(`${REPO_ROOT}/${BASELINE_PATH}`),
    JSON.stringify(buildBaseline(scan), null, 2) + "\n",
  );
});
