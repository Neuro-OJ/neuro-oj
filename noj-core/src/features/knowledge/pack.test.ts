/**
 * 内容包加载与校验测试（纯函数，不访问数据库）。
 *
 * 用临时目录构造合法/非法内容包；同时断言仓库内真实官方包校验通过。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import {
  loadPackFromDir,
  resolveOfficialPackDir,
  validatePack,
} from "./pack.ts";

interface TempPackOptions {
  pack?: Record<string, unknown>;
  areas?: Record<string, string>;
  rawFiles?: Record<string, string>;
}

/** 在临时目录写入内容包，返回目录路径（测试结束由调用方清理）。 */
async function writePack(options: TempPackOptions = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "noj-knowledge-pack-" });
  const pack = {
    id: "school",
    name: "学校课程包",
    version: "1.0.0",
    license: "CC-BY-SA-4.0",
    syllabi: { ioai: "IOAI 考纲" },
    ...(options.pack ?? {}),
  };
  await Deno.writeTextFile(join(dir, "pack.yaml"), JSON.stringify(pack));
  await Deno.mkdir(join(dir, "areas"));
  const areas = options.areas ?? {
    "ml.yaml": areaYaml("ml", "机器学习", [
      node("ml.linear-regression", ["ml.basics"]),
      node("ml.basics", []),
    ]),
  };
  for (const [file, content] of Object.entries(areas)) {
    await Deno.writeTextFile(join(dir, "areas", file), content);
  }
  for (const [file, content] of Object.entries(options.rawFiles ?? {})) {
    await Deno.writeTextFile(join(dir, file), content);
  }
  return dir;
}

/** 生成一个节点的 YAML 片段。 */
function node(id: string, requires: string[]): Record<string, unknown> {
  return {
    id,
    name: `节点 ${id}`,
    summary: `${id} 的说明`,
    syllabus: ["ioai"],
    ...(requires.length > 0 ? { requires } : {}),
  };
}

/** 生成领域 YAML（JSON 是合法 YAML）。 */
function areaYaml(area: string, name: string, nodes: unknown[]): string {
  return JSON.stringify({ area, name, nodes });
}

async function loadAndValidate(
  dir: string,
  options?: Parameters<typeof validatePack>[1],
): Promise<string[]> {
  return validatePack(await loadPackFromDir(dir), options);
}

Deno.test("knowledge pack: 合法内容包校验通过", async () => {
  const dir = await writePack();
  try {
    const errors = await loadAndValidate(dir);
    assertEquals(errors, []);
    const pack = await loadPackFromDir(dir);
    assertEquals(pack.id, "school");
    assertEquals(pack.areas.length, 1);
    assertEquals(pack.areas[0]!.nodes.length, 2);
    assertEquals(pack.areas[0]!.nodes[0]!.area, "ml");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: 重复节点 ID 报错并指明节点", async () => {
  const dir = await writePack({
    areas: {
      "ml.yaml": areaYaml("ml", "机器学习", [
        node("ml.a", []),
        node("ml.a", []),
      ]),
    },
  });
  try {
    const errors = await loadAndValidate(dir);
    assertEquals(
      errors.some((e) => e.includes("ml.a") && e.includes("重复")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: 悬挂前置引用报错", async () => {
  const dir = await writePack({
    areas: {
      "ml.yaml": areaYaml("ml", "机器学习", [node("ml.a", ["ml.missing"])]),
    },
  });
  try {
    const errors = await loadAndValidate(dir);
    assertEquals(
      errors.some((e) =>
        e.includes("ml.a") && e.includes("ml.missing") && e.includes("不存在")
      ),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: 自依赖与循环依赖报错并输出路径", async () => {
  const dir = await writePack({
    areas: {
      "ml.yaml": areaYaml("ml", "机器学习", [
        node("ml.a", ["ml.b"]),
        node("ml.b", ["ml.c"]),
        node("ml.c", ["ml.a"]),
        node("ml.self", ["ml.self"]),
      ]),
    },
  });
  try {
    const errors = await loadAndValidate(dir);
    assertEquals(
      errors.some((e) => e.includes("ml.self") && e.includes("自身")),
      true,
    );
    const cycle = errors.find((e) => e.includes("循环依赖"));
    assertEquals(cycle !== undefined, true);
    for (const id of ["ml.a", "ml.b", "ml.c"]) {
      assertEquals(cycle!.includes(id), true);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: 未声明考纲与空考纲报错", async () => {
  const dir = await writePack({
    areas: {
      "ml.yaml": areaYaml("ml", "机器学习", [
        { id: "ml.a", name: "A", summary: "S", syllabus: ["noai"] },
        { id: "ml.b", name: "B", summary: "S", syllabus: [] },
      ]),
    },
  });
  try {
    const errors = await loadAndValidate(dir);
    assertEquals(
      errors.some((e) => e.includes("ml.a") && e.includes("noai")),
      true,
    );
    assertEquals(
      errors.some((e) => e.includes("ml.b") && e.includes("syllabus")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: name/summary 必填、ID 格式与文件名不符报错", async () => {
  const dir = await writePack({
    areas: {
      "ml.yaml": areaYaml("ml", "机器学习", [
        { id: "ml.a", name: "", summary: "", syllabus: ["ioai"] },
        { id: "Math.Bad", name: "X", summary: "S", syllabus: ["ioai"] },
        // 文件名 ml.yaml 但 area 字段为 dl
        { id: "dl.c", name: "C", summary: "S", syllabus: ["ioai"] },
      ]),
    },
  });
  try {
    const errors = await loadAndValidate(dir);
    assertEquals(
      errors.some((e) => e.includes("ml.a") && e.includes("name")),
      true,
    );
    assertEquals(
      errors.some((e) => e.includes("ml.a") && e.includes("summary")),
      true,
    );
    assertEquals(
      errors.some((e) => e.includes("Math.Bad") && e.includes("ID 必须形如")),
      true,
    );
    assertEquals(
      errors.some((e) => e.includes("dl.c") && e.includes("领域")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: 领域为空报错", async () => {
  const dir = await writePack({ areas: {} });
  try {
    const errors = await loadAndValidate(dir);
    assertEquals(errors.some((e) => e.includes("至少包含一个领域")), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: 扩展包可引用被扩展包节点与考纲", async () => {
  const baseDir = await writePack();
  const extDir = await writePack({
    pack: {
      id: "school-ext",
      extends: "official@1.0.0",
      syllabi: {},
    },
    areas: {
      "school.yaml": areaYaml("school", "校本课", [
        node("school.extra", ["ml.linear-regression", "ml.basics"]),
      ]),
    },
  });
  try {
    const base = await loadPackFromDir(baseDir);
    assertEquals(validatePack(base), []);
    // 基础包版本与 extends 版本一致即通过（不要求 id 为 official 以外的情况）
    const errors = validatePack(await loadPackFromDir(extDir), {
      base,
      officialVersion: "1.0.0",
    });
    assertEquals(errors, []);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(extDir, { recursive: true });
  }
});

Deno.test("knowledge pack: 扩展包节点冲突、版本不符、扩展非官方包报错", async () => {
  const baseDir = await writePack();
  const conflictDir = await writePack({
    pack: { id: "school-ext", extends: "official@9.9.9" },
    areas: {
      "ml2.yaml": areaYaml("ml2", "扩展", [
        node("ml.linear-regression", []),
        node("ml2.new", []),
      ]),
    },
  });
  const otherBaseDir = await writePack({
    pack: { id: "school-ext", extends: "otherpackage@1.0.0" },
  });
  try {
    const base = await loadPackFromDir(baseDir);
    const conflict = validatePack(await loadPackFromDir(conflictDir), {
      base,
      officialVersion: "1.0.0",
    });
    assertEquals(
      conflict.some((e) =>
        e.includes("ml.linear-regression") && e.includes("冲突")
      ),
      true,
    );
    assertEquals(
      conflict.some((e) => e.includes("9.9.9") && e.includes("不一致")),
      true,
    );
    const other = validatePack(await loadPackFromDir(otherBaseDir), { base });
    assertEquals(other.some((e) => e.includes("只支持扩展官方包")), true);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(conflictDir, { recursive: true });
    await Deno.remove(otherBaseDir, { recursive: true });
  }
});

Deno.test("knowledge pack: 领域 ID 与被扩展包冲突报错", async () => {
  const baseDir = await writePack();
  const extDir = await writePack({
    pack: { id: "school-ext", extends: "official@1.0.0" },
    areas: {
      "ml.yaml": areaYaml("ml", "重复领域", [node("ml.dup", [])]),
    },
  });
  try {
    const base = await loadPackFromDir(baseDir);
    const errors = validatePack(await loadPackFromDir(extDir), {
      base,
      officialVersion: "1.0.0",
    });
    assertEquals(
      errors.some((e) => e.includes("领域") && e.includes("冲突")),
      true,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(extDir, { recursive: true });
  }
});

Deno.test("knowledge pack: 缺少 pack.yaml 或 areas 目录时抛错", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-knowledge-empty-" });
  try {
    await assertRejects(() => loadPackFromDir(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("knowledge pack: 真实官方包校验通过（14 领域 / 181 节点）", async () => {
  const pack = await loadPackFromDir(resolveOfficialPackDir());
  const errors = validatePack(pack);
  assertEquals(errors, []);
  assertEquals(pack.id, "official");
  assertEquals(pack.areas.length, 14);
  assertEquals(pack.areas.reduce((n, area) => n + area.nodes.length, 0), 181);
});

Deno.test("knowledge pack: NOJ_PROJECT_ROOT 指向 noj-core 根（生产镜像 /app 布局）", () => {
  const previous = Deno.env.get("NOJ_PROJECT_ROOT");
  try {
    // 生产镜像：NOJ_PROJECT_ROOT=/app，其下直接是 data/，不能再拼 noj-core/。
    Deno.env.set("NOJ_PROJECT_ROOT", "/app");
    assertEquals(resolveOfficialPackDir(), "/app/data/knowledge-graph");
  } finally {
    if (previous === undefined) Deno.env.delete("NOJ_PROJECT_ROOT");
    else Deno.env.set("NOJ_PROJECT_ROOT", previous);
  }
});

Deno.test("knowledge pack: 未设环境变量时按源码位置推导到 noj-core/data", () => {
  const previous = Deno.env.get("NOJ_PROJECT_ROOT");
  try {
    Deno.env.delete("NOJ_PROJECT_ROOT");
    const dir = resolveOfficialPackDir();
    assertEquals(dir.endsWith("/noj-core/data/knowledge-graph"), true, dir);
    assertEquals(Deno.statSync(`${dir}/pack.yaml`).isFile, true);
  } finally {
    if (previous !== undefined) Deno.env.set("NOJ_PROJECT_ROOT", previous);
  }
});
