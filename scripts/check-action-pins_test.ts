import { assertEquals } from "jsr:@std/assert@^1";
import { checkActionPins, findUnpinnedUses } from "./check-action-pins.ts";

/** 仓库根目录：基于本文件位置解析，避免依赖 cwd。 */
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SHA = "11d5960a326750d5838078e36cf38b85af677262";

Deno.test("check-action-pins: 浮动 tag / 分支 / 缺注释均判违规", () => {
  const content = [
    "      - uses: actions/checkout@v4",
    "        uses: dtolnay/rust-toolchain@stable",
    `      - uses: actions/checkout@${SHA}`,
    "      - uses: docker://rhysd/actionlint:1.7.7",
    `      - uses: 'actions/cache@v4' # v4.3.0`,
  ].join("\n");
  const reasons = findUnpinnedUses("x.yml", content).map((v) =>
    `${v.line}:${v.reason}`
  );
  assertEquals(reasons, [
    "1:未固定到 40 位 commit SHA",
    "2:未固定到 40 位 commit SHA",
    "3:SHA 固定缺少版本注释（如 `# v4.4.0`）",
    "4:docker 镜像未固定 @sha256 digest",
    "5:未固定到 40 位 commit SHA",
  ]);
});

Deno.test("check-action-pins: SHA + 版本注释、digest、本地 action 与注释行均放行", () => {
  const content = [
    `      - uses: actions/checkout@${SHA} # v4.4.0`,
    `        uses: github/codeql-action/init@${SHA} # v3.0.0`,
    "      - uses: docker://rhysd/actionlint@sha256:" + "a".repeat(64) +
    " # 1.7.7",
    "      - uses: ./.github/actions/e2e-domain",
    "      # - uses: actions/checkout@v4",
  ].join("\n");
  assertEquals(findUnpinnedUses("x.yml", content), []);
});

Deno.test("check-action-pins: 仓库现状全部固定（防回退）", async () => {
  const { errors, scanned } = await checkActionPins(REPO_ROOT);
  assertEquals(errors, []);
  assertEquals(scanned > 100, true);
});
