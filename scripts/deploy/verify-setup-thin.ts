/** 校验 setup.sh 为“仅下载/校验 noj-cli”的薄引导，不再拉取 bootstrap。 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 返回问题清单；空数组表示通过。 */
export function verifySetupThin(): string[] {
  const problems: string[] = [];
  const text = Deno.readTextFileSync(path.join(ROOT, "setup.sh"));

  if (!text.includes("noj-cli-linux-amd64")) {
    problems.push("setup.sh 未下载 noj-cli-linux-amd64");
  }
  if (!text.includes(".sha256") || !text.includes("sha256sum")) {
    problems.push("setup.sh 缺少 SHA-256 下载/校验");
  }
  if (!text.includes("NOJ_CLI_SHA256")) {
    problems.push("setup.sh 缺少可覆盖的 NOJ_CLI_SHA256 校验变量");
  }
  if (!text.includes("exec ") || !text.includes("noj-cli")) {
    problems.push("setup.sh 未在末尾 exec noj-cli");
  }
  if (/bootstrap|scripts\/deploy\/install\.sh/.test(text)) {
    problems.push("setup.sh 仍引用旧 bootstrap/install.sh（应删除）");
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifySetupThin();
  if (problems.length > 0) {
    console.error("❌ setup.sh 薄引导门禁失败：\n- " + problems.join("\n- "));
    Deno.exit(1);
  }
  console.log("✅ setup.sh 薄引导门禁通过");
}
