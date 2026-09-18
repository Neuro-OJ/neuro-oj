import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertDrillProjectName,
  assertDrillSnapshotSupported,
  assertSubnetCidr,
  buildDrillArgs,
  type DrillOptions,
  isSingleSnapshotFile,
  resolveDrillReportPath,
  runDrill,
} from "./drill.ts";
import { UsageError } from "../util/args.ts";

function baseOpts(over: Partial<DrillOptions> = {}): DrillOptions {
  return {
    snapshotPath: "/b/snapshot-2026-09-17T10-30-00Z",
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

Deno.test("drill: 项目名非法值抛 UsageError（错误码 2 的前置）", () => {
  // 评审 P2 的同类问题：参数错误必须落 UsageError，否则 CLI 会当作运行失败(1)
  assertThrows(() => assertDrillProjectName("noj-prod"), UsageError);
  assertThrows(() => assertDrillProjectName(""), UsageError);
});

Deno.test("drill: 合法子网 CIDR 通过", () => {
  assertSubnetCidr("172.29.0.0/16");
  assertSubnetCidr("10.0.0.0/8");
  assertSubnetCidr("192.168.1.0/24");
  assertSubnetCidr("172.30.0.0/30");
});

Deno.test("drill: 子网每段必须在 0-255（评审 P2：999.1.1.1/16 曾被放过）", () => {
  for (const bad of ["999.1.1.1/16", "256.0.0.0/8", "1.2.3.300/16"]) {
    assertThrows(
      () => assertSubnetCidr(bad),
      UsageError,
      undefined,
      `应拒绝 ${bad}`,
    );
  }
});

Deno.test("drill: 子网主机位必须为 0（评审 P2：172.29.1.1/16 曾被放过）", () => {
  // Docker 实测：--subnet 172.29.1.1/16 → invalid network config
  for (const bad of ["172.29.1.1/16", "10.1.2.3/8", "1.2.3.255/24"]) {
    assertThrows(
      () => assertSubnetCidr(bad),
      UsageError,
      undefined,
      `应拒绝 ${bad}`,
    );
  }
});

Deno.test("drill: 子网形式与前缀范围（评审 P2）", () => {
  // 形式错误
  for (const bad of ["172.29.0.0", "not-a-cidr", "1.2.3/16", "::1/64"]) {
    assertThrows(() => assertSubnetCidr(bad), UsageError, undefined, bad);
  }
  // 前缀越界：/7 与 /31、/32、/33、/40 均拒绝
  for (
    const bad of [
      "10.0.0.0/7",
      "172.29.0.0/31",
      "172.29.0.0/32",
      "1.2.3.4/33",
      "1.2.3.4/40",
    ]
  ) {
    assertThrows(() => assertSubnetCidr(bad), UsageError, undefined, bad);
  }
});

Deno.test("drill: 非法子网抛 UsageError → CLI 退出码 2（评审 P2 承诺）", async () => {
  // runDrill 在 checkDrillResources 之前做纯参数校验，故无需 Docker 即可断言
  await assertRejects(
    () => runDrill(baseOpts({ subnet: "999.1.1.1/16" })),
    UsageError,
  );
  await assertRejects(
    () => runDrill(baseOpts({ subnet: "172.29.1.1/16" })),
    UsageError,
  );
});

Deno.test("drill: 单文件 .nojbackup 被识别并在参数阶段拒绝（评审 P1）", () => {
  assertEquals(
    isSingleSnapshotFile("/b/snapshot-2026-09-17T10-30-00Z.nojbackup"),
    true,
  );
  assertEquals(isSingleSnapshotFile("/b/SNAPSHOT-X.NOJBACKUP"), true);
  assertEquals(isSingleSnapshotFile("/b/snapshot-2026-09-17T10-30-00Z"), false);
  assertThrows(
    () =>
      assertDrillSnapshotSupported(
        "/b/snapshot-2026-09-17T10-30-00Z.nojbackup",
      ),
    UsageError,
  );
  // 错误信息必须给出**可用的**恢复路径，而不是只说「不支持」
  try {
    assertDrillSnapshotSupported("/b/x.nojbackup");
  } catch (e) {
    const msg = (e as Error).message;
    assertEquals(msg.includes("maintain backup restore"), true);
    assertEquals(msg.includes("maintain backup verify"), true);
  }
  // 目录快照不受影响
  assertDrillSnapshotSupported("/b/snapshot-2026-09-17T10-30-00Z");
});

Deno.test("drill: runDrill 对单文件快照抛 UsageError，且不触达 Docker/脚本", async () => {
  // 若这里先跑 checkDrillResources 或 restore-drill.sh，就会变成「演练失败(1)」
  await assertRejects(
    () =>
      runDrill(
        baseOpts({
          snapshotPath: "/b/snapshot-2026-09-17T10-30-00Z.nojbackup",
        }),
      ),
    UsageError,
  );
});

Deno.test("drill: buildDrillArgs 只传显式给出的选项", () => {
  const minimal = buildDrillArgs(baseOpts());
  assertEquals(minimal.length, 2, "只应有脚本路径与快照路径");
  assertEquals(minimal[1], "/b/snapshot-2026-09-17T10-30-00Z");

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
