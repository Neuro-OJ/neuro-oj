import { assertEquals } from "@std/assert";
import {
  composeArgs,
  type DrillComposePaths,
  renderDrillOverride,
} from "./compose.ts";
import type { RestoreDrillOptions } from "./options.ts";

const opts: RestoreDrillOptions = {
  snapshot: "/bk/snapshot-2026",
  envFile: "/opt/neuro-oj/.env.prod",
  composeFile: "/opt/neuro-oj/docker-compose.prod.yml",
  passphraseFile: "/etc/noj/pass",
  projectName: "noj-drill",
  drillDir: undefined,
  report: undefined,
  subnet: "172.29.0.0/16",
  rpoMaxHours: 24,
  rtoMaxMinutes: 60,
  waitTimeout: 300,
  skipJudge: false,
  keep: false,
};

Deno.test("renderDrillOverride: 包含子网与 verifier", () => {
  const text = renderDrillOverride("172.30.0.0/16");
  assertEquals(text.includes("172.30.0.0/16"), true);
  assertEquals(text.includes("verifier"), true);
});

Deno.test("composeArgs: 使用 project/env/file/override/profile", () => {
  const paths: DrillComposePaths = {
    envFile: "/tmp/env",
    overrideFile: "/tmp/override.yml",
    composeFile: "/opt/compose.yml",
  };
  const args = composeArgs(opts, paths, ["up", "-d"]);
  assertEquals(args[0], "compose");
  assertEquals(args.includes("--project-name"), true);
  assertEquals(args.includes("noj-drill"), true);
  assertEquals(args.includes("--profile"), true);
  assertEquals(args.includes("judge"), true);
  assertEquals(args.includes("up"), true);
  assertEquals(args.includes("-d"), true);
});

Deno.test("composeArgs: skipJudge 时不加 judge profile", () => {
  const paths: DrillComposePaths = {
    envFile: "/tmp/env",
    overrideFile: "/tmp/override.yml",
    composeFile: "/opt/compose.yml",
  };
  const args = composeArgs({ ...opts, skipJudge: true }, paths, ["ps"]);
  assertEquals(args.includes("judge"), false);
});
