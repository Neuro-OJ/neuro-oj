import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_DRILL_PROJECT,
  DEFAULT_DRILL_SUBNET,
  DEFAULT_RPO_MAX_HOURS,
  DEFAULT_RTO_MAX_MINUTES,
  DEFAULT_WAIT_TIMEOUT,
  parseRestoreDrillArgs,
} from "./options.ts";

Deno.test("parseRestoreDrillArgs: 缺省值", () => {
  const o = parseRestoreDrillArgs(["/bk/snapshot-2026"]);
  assertEquals(o.snapshot, "/bk/snapshot-2026");
  assertEquals(o.projectName, DEFAULT_DRILL_PROJECT);
  assertEquals(o.subnet, DEFAULT_DRILL_SUBNET);
  assertEquals(o.rpoMaxHours, DEFAULT_RPO_MAX_HOURS);
  assertEquals(o.rtoMaxMinutes, DEFAULT_RTO_MAX_MINUTES);
  assertEquals(o.waitTimeout, DEFAULT_WAIT_TIMEOUT);
  assertEquals(o.skipJudge, false);
  assertEquals(o.keep, false);
});

Deno.test("parseRestoreDrillArgs: 选项解析", () => {
  const o = parseRestoreDrillArgs([
    "/bk/snapshot-2026",
    "--env-file",
    "/opt/neuro-oj/.env.prod",
    "--compose-file",
    "/opt/neuro-oj/docker-compose.prod.yml",
    "--passphrase-file",
    "/etc/noj/pass",
    "--project-name",
    "noj-drill-test",
    "--subnet",
    "172.30.0.0/16",
    "--rpo-max-hours",
    "12",
    "--rto-max-minutes",
    "30",
    "--wait-timeout",
    "120",
    "--skip-judge",
    "--keep",
  ]);
  assertEquals(o.envFile, "/opt/neuro-oj/.env.prod");
  assertEquals(o.composeFile, "/opt/neuro-oj/docker-compose.prod.yml");
  assertEquals(o.passphraseFile, "/etc/noj/pass");
  assertEquals(o.projectName, "noj-drill-test");
  assertEquals(o.subnet, "172.30.0.0/16");
  assertEquals(o.rpoMaxHours, 12);
  assertEquals(o.rtoMaxMinutes, 30);
  assertEquals(o.waitTimeout, 120);
  assertEquals(o.skipJudge, true);
  assertEquals(o.keep, true);
});

Deno.test("parseRestoreDrillArgs: 非法 project name", () => {
  assertThrows(() =>
    parseRestoreDrillArgs(["/bk/s", "--project-name", "noj-prod"])
  );
  assertThrows(() =>
    parseRestoreDrillArgs(["/bk/s", "--project-name", "Bad_Name"])
  );
});

Deno.test("parseRestoreDrillArgs: 非法 RPO/RTO", () => {
  assertThrows(() =>
    parseRestoreDrillArgs(["/bk/s", "--rpo-max-hours", "abc"])
  );
  assertThrows(() =>
    parseRestoreDrillArgs(["/bk/s", "--rto-max-minutes", "-1"])
  );
});

Deno.test("parseRestoreDrillArgs: 缺少 snapshot", () => {
  assertThrows(() => parseRestoreDrillArgs([]));
});
