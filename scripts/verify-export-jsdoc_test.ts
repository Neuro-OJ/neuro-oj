// 导出 JSDoc 门禁脚本测试。
import {
  analyzeFile,
  analyzeRoot,
  isBelowThreshold,
} from "./verify-export-jsdoc.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function withTempDir(
  files: Record<string, string>,
  fn: (dir: string) => void,
): void {
  const dir = Deno.makeTempDirSync({ prefix: "export-jsdoc-test-" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const filePath = `${dir}/${rel}`;
      const parent = filePath.slice(0, filePath.lastIndexOf("/"));
      Deno.mkdirSync(parent, { recursive: true });
      Deno.writeTextFileSync(filePath, content);
    }
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("有 JSDoc 的导出函数计为已文档化", () => {
  withTempDir({
    "ok.ts": `/** 文档。 */\nexport function ok(): void {}\n`,
  }, (dir) => {
    const stats = analyzeFile(`${dir}/ok.ts`);
    assert(stats.exports === 1, `exports 应为 1，实际 ${stats.exports}`);
    assert(
      stats.documented === 1,
      `documented 应为 1，实际 ${stats.documented}`,
    );
    assert(stats.coverage === 100, `coverage 应为 100，实际 ${stats.coverage}`);
  });
});

Deno.test("无 JSDoc 的导出函数计为未文档化", () => {
  withTempDir({
    "bad.ts": `export function bad(): void {}\n`,
  }, (dir) => {
    const stats = analyzeFile(`${dir}/bad.ts`);
    assert(stats.exports === 1, `exports 应为 1，实际 ${stats.exports}`);
    assert(
      stats.documented === 0,
      `documented 应为 0，实际 ${stats.documented}`,
    );
    assert(stats.coverage === 0, `coverage 应为 0，实际 ${stats.coverage}`);
  });
});

Deno.test("analyzeRoot 聚合目录覆盖率", () => {
  withTempDir({
    "a.ts": `/** A */\nexport function a(): void {}\n`,
    "b.ts": `export const b = 1;\n`,
  }, (dir) => {
    const stats = analyzeRoot(dir);
    assert(stats.exports === 2, `exports 应为 2，实际 ${stats.exports}`);
    assert(
      stats.documented === 1,
      `documented 应为 1，实际 ${stats.documented}`,
    );
    assert(
      Math.abs(stats.coverage - 50) < 0.001,
      `coverage 应为 50，实际 ${stats.coverage}`,
    );
  });
});

Deno.test("阈值判断", () => {
  assert(
    !isBelowThreshold({ exports: 10, documented: 7, coverage: 70 }, 62.9),
    "70% 不应低于 62.9%",
  );
  assert(
    isBelowThreshold({ exports: 10, documented: 5, coverage: 50 }, 62.9),
    "50% 应低于 62.9%",
  );
});
