import { assertEquals, assertThrows } from "@std/assert";
import {
  type ContextKind,
  detectKind,
  findContextDir,
  resolveContext,
} from "./context.ts";

function writeFixture(dir: string, files: Record<string, string>): void {
  Deno.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${dir}/${name}`, content);
  }
}

Deno.test("detectKind: production/json/judge/none", () => {
  const dir = Deno.makeTempDirSync();
  writeFixture(dir, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  assertEquals(detectKind(dir), "production" as ContextKind);

  const jsonDir = Deno.makeTempDirSync();
  writeFixture(jsonDir, {
    "noj-deploy.json": "{}",
    "noj-secrets.json": "{}",
  });
  assertEquals(detectKind(jsonDir), "json" as ContextKind);

  const judgeDir = Deno.makeTempDirSync();
  writeFixture(judgeDir, {
    ".env.judge": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.judge.yml": "services: {}\n",
  });
  assertEquals(detectKind(judgeDir), "judge" as ContextKind);

  const empty = Deno.makeTempDirSync();
  assertEquals(detectKind(empty), null);
});

Deno.test("findContextDir: 向上查找指定上下文", () => {
  const root = Deno.makeTempDirSync();
  const prod = `${root}/prod`;
  writeFixture(prod, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  const nested = `${prod}/nested/deep`;
  Deno.mkdirSync(nested, { recursive: true });
  assertEquals(findContextDir(nested, "production"), prod);
  assertEquals(findContextDir(nested), prod);
});

Deno.test("resolveContext: --dir 显式指定", () => {
  const dir = Deno.makeTempDirSync();
  writeFixture(dir, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  const ctx = resolveContext({ cwd: "/tmp", dir });
  assertEquals(ctx.kind, "production");
  assertEquals(ctx.dir, dir);
});

Deno.test("resolveContext: --mode 找不到对应上下文时 kind=none", () => {
  const dir = Deno.makeTempDirSync();
  const ctx = resolveContext({ cwd: "/tmp", dir, mode: "json" });
  assertEquals(ctx.kind, "none");
  assertEquals(ctx.dir, null);
});

Deno.test("resolveContext: 显式 dir 但 mode 不匹配时抛错", () => {
  const dir = Deno.makeTempDirSync();
  writeFixture(dir, {
    ".env.prod": "NOJ_VERSION=v0.1.0\n",
    "docker-compose.prod.yml": "services: {}\n",
  });
  assertThrows(() => resolveContext({ cwd: "/tmp", dir, mode: "json" }));
});
