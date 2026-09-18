import { assertEquals, assertThrows } from "@std/assert";
import {
  assertDrillProjectName,
  assertSubnetCidr,
  buildDrillArgs,
  type DrillOptions,
  resolveDrillReportPath,
} from "./drill.ts";

function baseOpts(over: Partial<DrillOptions> = {}): DrillOptions {
  return {
    snapshotPath: "/b/snap.nojbackup",
    dir: "/opt/noj",
    skipJudge: false,
    subnet: undefined,
    projectName: undefined,
    report: undefined,
    rpoMaxHours: undefined,
    rtoMaxMinutes: undefined,
    keep: false,
    json: false,
    passphraseFile: undefined,
    ...over,
  };
}

Deno.test("drill: 项目名默认不得含 prod（否则 down -v 会删生产卷）", () => {
  // #516 验收：演练用独立项目名，拒绝包含 prod
  assertDrillProjectName("noj-drill");
  assertThrows(() => assertDrillProjectName("noj-prod"));
  assertThrows(() => assertDrillProjectName("NOJ-PROD-drill"));
  assertThrows(() => assertDrillProjectName("production"));
  assertThrows(() => assertDrillProjectName("  "));
});

Deno.test("drill: 子网必须是合法 CIDR", () => {
  assertSubnetCidr("172.29.0.0/16");
  assertSubnetCidr("10.0.0.0/8");
  assertThrows(() => assertSubnetCidr("172.29.0.0"));
  assertThrows(() => assertSubnetCidr("not-a-cidr"));
  assertThrows(() => assertSubnetCidr("1.2.3.4/40"));
});

Deno.test("drill: buildDrillArgs 只传显式给出的选项", () => {
  const minimal = buildDrillArgs(baseOpts());
  assertEquals(minimal.length, 2, "只应有脚本路径与快照路径");
  assertEquals(minimal[1], "/b/snap.nojbackup");

  const full = buildDrillArgs(baseOpts({
    skipJudge: true,
    subnet: "172.30.0.0/16",
    projectName: "noj-drill-x",
    report: "/tmp/r.txt",
    rpoMaxHours: 12,
    rtoMaxMinutes: 30,
    keep: true,
    passphraseFile: "/etc/noj/pp",
  }));
  const joined = full.join(" ");
  for (
    const expected of [
      "--skip-judge",
      "--subnet 172.30.0.0/16",
      "--project-name noj-drill-x",
      "--report /tmp/r.txt",
      "--rpo-max-hours 12",
      "--rto-max-minutes 30",
      "--keep",
      "--passphrase-file /etc/noj/pp",
    ]
  ) {
    assertEquals(joined.includes(expected), true, `缺少 ${expected}`);
  }
});

Deno.test("drill: 默认不 keep（演练资源必须清理）", () => {
  assertEquals(buildDrillArgs(baseOpts()).includes("--keep"), false);
  assertEquals(
    buildDrillArgs(baseOpts({ keep: true })).includes("--keep"),
    true,
  );
});
Deno.test("drill: resolveDrillReportPath 写在**快照目录之内**（M1）", () => {
  // 快照是目录（restore-drill.sh 的 validate_snapshot_path 强制 [[ -d ]]），
  // 报告写在 snapshot/restore-drill-report.txt（脚本 restore-drill.sh:291）。
  // 早先取 dirname(snapshot) 会恒指向不存在的路径（评测 M1+M2 连带缺陷）。
  assertEquals(
    resolveDrillReportPath(
      "/b/backups/snapshot-2026-09-17T10-30-00Z",
      undefined,
    ),
    "/b/backups/snapshot-2026-09-17T10-30-00Z/restore-drill-report.txt",
  );
  assertEquals(
    resolveDrillReportPath("/b/snap", "/explicit.txt"),
    "/explicit.txt",
  );
  // 尾随斜杠不应产生双斜杠
  assertEquals(
    resolveDrillReportPath("/b/snap/", undefined),
    "/b/snap/restore-drill-report.txt",
  );
});
