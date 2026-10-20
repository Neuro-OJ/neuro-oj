/** 独立执行仓库门禁负例；测试清单与 check-ci 复用，完整门禁仍由 check-ci 验收。 */
import { resolve } from "node:path";
import { GATE_SELF_TESTS } from "./gate-list.ts";
import { run } from "./gate-runner.ts";

if (import.meta.main) {
  await run(
    ["deno", "test", "-A", ...GATE_SELF_TESTS],
    resolve(import.meta.dirname ?? ".", ".."),
  );
}
