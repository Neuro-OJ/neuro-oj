/**
 * 单文件规模棘轮门禁的自测（2026-09-12 架构评审 §3.2）。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkFileSizes,
  countLines,
  MAX_LINES,
  SIZE_BASELINE,
} from "./check-file-size.ts";

Deno.test("check-file-size: 行数统计正确", () => {
  assertEquals(countLines(""), 0);
  assertEquals(countLines("a"), 1);
  assertEquals(countLines("a\nb"), 2);
  assertEquals(countLines("a\nb\n"), 3);
});

Deno.test("check-file-size: 未登记的超阈值文件必须失败", async () => {
  const root = await Deno.makeTempDir({ prefix: "file-size-" });
  try {
    await Deno.mkdir(`${root}/noj-core/src`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/noj-core/src/big.ts`,
      "x\n".repeat(MAX_LINES + 5),
    );
    const { errors, largeFiles } = await checkFileSizes(root);
    assertEquals(largeFiles.length, 1);
    assert(
      errors.some((e) => e.includes("big.ts")),
      `新超限文件必须报错：${JSON.stringify(errors)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check-file-size: 阈值以下文件不参与", async () => {
  const root = await Deno.makeTempDir({ prefix: "file-size-" });
  try {
    await Deno.mkdir(`${root}/noj-core/src`, { recursive: true });
    await Deno.writeTextFile(`${root}/noj-core/src/ok.ts`, "x\n".repeat(10));
    const { errors, stats } = await checkFileSizes(root);
    assertEquals(errors, []);
    assertEquals(stats.over_threshold, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check-file-size: 扫描不到文件时门禁失效", async () => {
  const root = await Deno.makeTempDir({ prefix: "file-size-" });
  try {
    const { errors } = await checkFileSizes(root);
    assert(errors.length > 0, "空目录必须报错");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check-file-size: 真实仓库当前通过（基线与实际一致）", async () => {
  const { errors, largeFiles } = await checkFileSizes(".");
  assertEquals(errors, []);
  // 基线必须与实测一一对应（防止"基线写了个宽松的大数值"）
  assertEquals(
    Object.keys(SIZE_BASELINE).sort(),
    largeFiles.map((f) => f.file).sort(),
  );
});

// ── 2026-09-21 修复：SCAN_ROOTS 遗漏 noj-cli ──
// 触发条件：noj-cli 的超阈值文件此前完全不受棘轮约束。
Deno.test("check-file-size: 真实仓库无未登记的超阈值文件", async () => {
  // 真实仓库：门禁零错误，且任何超阈值文件都已登记基线。
  // 2026-11-08 大文件拆分后 noj-cli 已无超阈值文件；「noj-cli 被纳入扫描」
  // 由下方夹具用例覆盖，不再依赖真实仓库中存在大文件。
  const { largeFiles, errors } = await checkFileSizes(".");
  assertEquals(errors, []);
  for (const f of largeFiles) {
    assertEquals(
      typeof SIZE_BASELINE[f.file],
      "number",
      `${f.file} 必须有基线登记`,
    );
  }
});

Deno.test("check-file-size: 夹具中的 noj-cli 文件超阈值会失败", async () => {
  const root = await Deno.makeTempDir({ prefix: "file-size-cli-" });
  try {
    await Deno.mkdir(`${root}/noj-cli/src`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/noj-cli/src/huge.ts`,
      "x\n".repeat(MAX_LINES + 10),
    );
    const { errors, largeFiles } = await checkFileSizes(root, {
      checkStaleBaseline: false,
    });
    assertEquals(largeFiles.length, 1);
    assert(
      errors.some((e) => e.includes("noj-cli/src/huge.ts")),
      `noj-cli 下超阈值文件必须报错，实际: ${JSON.stringify(errors)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
