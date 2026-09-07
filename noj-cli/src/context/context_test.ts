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

function withTempDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync();
  try {
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("detectKind: production/json/judge/none", () => {
  withTempDir((dir) => {
    writeFixture(dir, {
      ".env.prod": "NOJ_VERSION=v0.1.0\n",
      "docker-compose.prod.yml": "services: {}\n",
    });
    assertEquals(detectKind(dir), "production" as ContextKind);
  });
  withTempDir((dir) => {
    writeFixture(dir, {
      "noj-deploy.json": "{}",
      "noj-secrets.json": "{}",
    });
    assertEquals(detectKind(dir), "json" as ContextKind);
  });
  withTempDir((dir) => {
    writeFixture(dir, {
      ".env.judge": "NOJ_VERSION=v0.1.0\n",
      "docker-compose.judge.yml": "services: {}\n",
    });
    assertEquals(detectKind(dir), "judge" as ContextKind);
  });
  withTempDir((dir) => {
    assertEquals(detectKind(dir), null);
  });
});

Deno.test("findContextDir: 向上查找指定上下文", () => {
  withTempDir((root) => {
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
});

Deno.test("findContextDir: 不存在的起始目录返回 null", () => {
  assertEquals(findContextDir("/definitely/not/a/real/path"), null);
});

Deno.test("resolveContext: --dir 显式指定", () => {
  withTempDir((dir) => {
    writeFixture(dir, {
      ".env.prod": "NOJ_VERSION=v0.1.0\n",
      "docker-compose.prod.yml": "services: {}\n",
    });
    const ctx = resolveContext({ cwd: "/tmp", dir });
    assertEquals(ctx.kind, "production");
    assertEquals(ctx.dir, dir);
  });
});

Deno.test("resolveContext: --dir 显式指定但无上下文标记时保留目录", () => {
  withTempDir((dir) => {
    const ctx = resolveContext({ cwd: "/tmp", dir });
    assertEquals(ctx.kind, "none");
    assertEquals(ctx.dir, dir);
  });
});

Deno.test("resolveContext: --mode 找不到对应上下文时 kind=none 且保留目录", () => {
  withTempDir((dir) => {
    const ctx = resolveContext({ cwd: "/tmp", dir, mode: "json" });
    assertEquals(ctx.kind, "none");
    assertEquals(ctx.dir, dir);
  });
});

Deno.test("resolveContext: 显式 dir 但 mode 不匹配时抛错", () => {
  withTempDir((dir) => {
    writeFixture(dir, {
      ".env.prod": "NOJ_VERSION=v0.1.0\n",
      "docker-compose.prod.yml": "services: {}\n",
    });
    assertThrows(() => resolveContext({ cwd: "/tmp", dir, mode: "json" }));
  });
});

Deno.test("resolveContext: 未指定 --dir 时自动向上识别上下文", () => {
  withTempDir((root) => {
    const prod = `${root}/prod`;
    writeFixture(prod, {
      ".env.prod": "NOJ_VERSION=v0.1.0\n",
      "docker-compose.prod.yml": "services: {}\n",
    });
    const nested = `${prod}/nested/deep`;
    Deno.mkdirSync(nested, { recursive: true });
    const ctx = resolveContext({ cwd: nested });
    assertEquals(ctx.kind, "production");
    assertEquals(ctx.dir, prod);
  });
});
