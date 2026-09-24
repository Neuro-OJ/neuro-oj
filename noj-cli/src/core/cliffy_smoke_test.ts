import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";

Deno.test("Cliffy 可实例化并解析 variadic 透传参数", async () => {
  const seen: string[] = [];
  const cli = new Command()
    .name("t").throwErrors().allowEmpty()
    .command("install")
    .arguments("[args...:string]")
    .action((_o, ...args: string[]) => {
      seen.push(...args);
    });
  await cli.parse(["install", "--port", "8080", "--panel", "baota"]);
  assertEquals(seen, ["--port", "8080", "--panel", "baota"]);
});
