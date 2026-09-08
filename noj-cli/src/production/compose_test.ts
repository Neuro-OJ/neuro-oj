import { assertEquals } from "@std/assert";
import { prodComposeArgs, type ProdComposeOptions } from "./compose.ts";

Deno.test("prodComposeArgs: 参数顺序", () => {
  const opts: ProdComposeOptions = {
    envFile: "/opt/.env.prod",
    composeFile: "/opt/docker-compose.prod.yml",
    projectName: "neuro-oj",
  };
  const args = prodComposeArgs(opts, ["ps"]);
  assertEquals(args[0], "compose");
  assertEquals(args.includes("--project-name"), true);
  assertEquals(args.includes("neuro-oj"), true);
  assertEquals(args.includes("--env-file"), true);
  assertEquals(args.includes("/opt/.env.prod"), true);
  assertEquals(args.includes("--file"), true);
  assertEquals(args.includes("/opt/docker-compose.prod.yml"), true);
  assertEquals(args[args.length - 1], "ps");
});

Deno.test("prodComposeArgs: 无 projectName 时不加", () => {
  const opts: ProdComposeOptions = {
    envFile: "/opt/.env.prod",
    composeFile: "/opt/docker-compose.prod.yml",
  };
  const args = prodComposeArgs(opts, ["ps"]);
  assertEquals(args.includes("--project-name"), false);
});
