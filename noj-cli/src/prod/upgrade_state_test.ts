import { assertEquals, assertThrows } from "@std/assert";
import {
  advanceUpgradeState,
  createUpgradeState,
  readUpgradeState,
  upgradeStatePath,
  writeUpgradeState,
} from "./upgrade-state.ts";

Deno.test("升级 checkpoint 只允许单调推进并原子读回", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-upgrade-state-" });
  try {
    const path = upgradeStatePath(dir);
    let state = createUpgradeState({
      runId: "run-1",
      from: "v0.10.4",
      to: "v0.10.5",
    });
    state = advanceUpgradeState(state, "backed_up", {
      backup_path: "/safe/backup.nojbackup",
    });
    state = advanceUpgradeState(state, "pulled");
    await writeUpgradeState(path, state);
    assertEquals((await readUpgradeState(path))?.phase, "pulled");
    assertThrows(() => advanceUpgradeState(state, "resolved"), Error, "回退");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("升级 checkpoint 不能把失败或完成状态伪造为完成", () => {
  const initial = createUpgradeState({
    runId: "run-2",
    from: "v0.10.4",
    to: "v0.10.5",
  });
  const failed = advanceUpgradeState(initial, "failed", {
    error: "pull failed",
  });
  assertThrows(() => advanceUpgradeState(failed, "completed"), Error, "失败");
  assertThrows(
    () => advanceUpgradeState(initial, "completed"),
    Error,
    "started",
  );
  const completed = advanceUpgradeState(
    advanceUpgradeState(initial, "started"),
    "completed",
  );
  assertEquals(completed.phase, "completed");
});
