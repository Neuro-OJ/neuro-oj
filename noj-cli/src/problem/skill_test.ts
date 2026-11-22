/**
 * `problem skill`（P0-2 C）单元测试：嵌入一致、内容约束、写入与冲突处理。
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { generateSkill } from "./gen-skill.ts";
import { PROBLEM_SETTER_SKILL_FILES } from "./skill.generated.ts";
import {
  installProblemSetterSkill,
  PROBLEM_SETTER_SKILL_NAME,
  PROBLEM_SETTER_SKILL_ROOTS,
} from "./skill.ts";
import { parseProblemArgs, runProblemSkill } from "./command.ts";
import { initProblemScaffold, PROBLEM_TEMPLATE_NAMES } from "./init.ts";
import { collectBundleEntries, packBundle, shouldExclude } from "./pack.ts";
import { UsageError } from "../util/args.ts";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
} from "../cli-commands/exit-codes.ts";

Deno.test("skill：嵌入模块与 skills/ 目录一致", async () => {
  assertEquals(
    await generateSkill(true),
    true,
    "请运行 deno run -A noj-cli/src/problem/gen-skill.ts",
  );
});

Deno.test("skill：SKILL.md frontmatter 与必备内容", () => {
  const skill = PROBLEM_SETTER_SKILL_FILES["SKILL.md"];
  assert(skill, "缺少 SKILL.md");
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert(front, "SKILL.md 必须以 YAML frontmatter 开头");
  assertMatch(
    front[1]!,
    new RegExp(`^name: ${PROBLEM_SETTER_SKILL_NAME}$`, "m"),
  );
  assertMatch(front[1]!, /^description: .{20,}$/m);

  // 覆盖每个模板与完整流程
  for (const name of PROBLEM_TEMPLATE_NAMES) {
    assertStringIncludes(skill, `\`${name}\``);
  }
  for (
    const step of [
      "problem init",
      "--template",
      "problem test",
      "problem lint",
      "problem pack",
      "problem push",
    ]
  ) {
    assertStringIncludes(skill, step);
  }
  // 常见坑与禁止搬运真实题库
  for (
    const pitfall of ["分数刻度", "隐藏用例泄露", "资源限制", "LLM 调用预算"]
  ) {
    assertStringIncludes(skill, pitfall);
  }
  assertStringIncludes(skill, "不要搬运真实题库内容");

  // SKILL.md 引用的相对文件都已嵌入
  for (const [, target] of skill.matchAll(/\]\((references\/[^)#]+)\)/g)) {
    assert(target! in PROBLEM_SETTER_SKILL_FILES, `引用缺失：${target}`);
  }
});

Deno.test("installProblemSetterSkill：写入两处、幂等、冲突需 --force", async () => {
  const root = await Deno.makeTempDir();
  try {
    const first = await installProblemSetterSkill({ root });
    assertEquals(first.map((r) => r.status), ["written", "written"]);
    for (const base of PROBLEM_SETTER_SKILL_ROOTS) {
      const dir = join(root, base, PROBLEM_SETTER_SKILL_NAME);
      for (const [rel, content] of Object.entries(PROBLEM_SETTER_SKILL_FILES)) {
        assertEquals(await Deno.readTextFile(join(dir, rel)), content);
      }
    }

    const again = await installProblemSetterSkill({ root });
    assertEquals(again.map((r) => r.status), ["unchanged", "unchanged"]);

    // 本地改过一处 + 多一个旧文件：默认不覆盖
    const claudeDir = join(root, ".claude/skills", PROBLEM_SETTER_SKILL_NAME);
    await Deno.writeTextFile(join(claudeDir, "SKILL.md"), "edited");
    await Deno.writeTextFile(join(claudeDir, "stale.md"), "old");
    const conflict = await installProblemSetterSkill({ root });
    assertEquals(conflict.map((r) => r.status), ["unchanged", "conflict"]);
    assertEquals(
      await Deno.readTextFile(join(claudeDir, "SKILL.md")),
      "edited",
    );

    // --force：整体替换，旧文件不残留
    const forced = await installProblemSetterSkill({ root, force: true });
    assertEquals(forced.map((r) => r.status), ["unchanged", "written"]);
    assertEquals(
      await Deno.readTextFile(join(claudeDir, "SKILL.md")),
      PROBLEM_SETTER_SKILL_FILES["SKILL.md"],
    );
    let staleExists = true;
    try {
      await Deno.stat(join(claudeDir, "stale.md"));
    } catch {
      staleExists = false;
    }
    assertEquals(staleExists, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("problem skill：参数解析与退出码", async () => {
  const root = await Deno.makeTempDir();
  try {
    const args = parseProblemArgs(["skill", root, "--json"]);
    assertEquals(args.dir, root);
    assertEquals(args.slug, undefined);
    assertEquals(await runProblemSkill(args), EXIT_OK);

    await Deno.writeTextFile(
      join(root, ".agents/skills", PROBLEM_SETTER_SKILL_NAME, "SKILL.md"),
      "edited",
    );
    assertEquals(await runProblemSkill(args), EXIT_FAILURE);
    assertEquals(
      await runProblemSkill(
        parseProblemArgs(["skill", root, "--force", "--json"]),
      ),
      EXIT_OK,
    );

    assertEquals(
      await runProblemSkill(parseProblemArgs(["skill", join(root, "missing")])),
      EXIT_USAGE,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** 路径是否存在（不跟随链接）。 */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 列出目录（不存在返回空）。 */
async function list(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) out.push(e.name);
  } catch {
    // 不存在
  }
  return out.sort();
}

Deno.test("installProblemSetterSkill：路径中有符号链接时拒绝，不写不删链接目标", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    // 情形一：.agents 指向仓库外的共享目录
    await Deno.symlink(outside, join(root, ".agents"), { type: "dir" });
    await assertRejects(
      () => installProblemSetterSkill({ root, force: true }),
      Error,
      "符号链接",
    );
    assertEquals(await list(outside), []);
    // 任一位置不安全时两处都不写
    assertEquals(await exists(join(root, ".claude")), false);
    await Deno.remove(join(root, ".agents"));

    // 情形二：Skill 目录本身指向共享目录，--force 不得删除其内容
    const shared = join(outside, "shared-skill");
    await Deno.mkdir(shared);
    await Deno.writeTextFile(join(shared, "keep.md"), "本地修改");
    await Deno.mkdir(join(root, ".claude/skills"), { recursive: true });
    await Deno.symlink(
      shared,
      join(root, ".claude/skills", PROBLEM_SETTER_SKILL_NAME),
      { type: "dir" },
    );
    await assertRejects(
      () => installProblemSetterSkill({ root, force: true }),
      Error,
      "符号链接",
    );
    assertEquals(
      await Deno.readTextFile(join(shared, "keep.md")),
      "本地修改",
    );
    assertEquals(await exists(join(root, ".agents")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("installProblemSetterSkill：--force 写入失败时保留原目录且不留暂存", async () => {
  const root = await Deno.makeTempDir();
  try {
    await installProblemSetterSkill({ root });
    const dir = join(root, ".agents/skills", PROBLEM_SETTER_SKILL_NAME);
    await Deno.writeTextFile(join(dir, "SKILL.md"), "edited");

    // "a" 是文件又要作为 "a/b" 的父目录：写入暂存目录时必然失败
    await assertRejects(() =>
      installProblemSetterSkill({
        root,
        force: true,
        files: { "SKILL.md": "new", "a": "x", "a/b": "y" },
      })
    );
    assertEquals(await Deno.readTextFile(join(dir, "SKILL.md")), "edited");
    assertEquals(await list(join(root, ".agents/skills")), [
      PROBLEM_SETTER_SKILL_NAME,
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("problem pack：题目目录内安装的 Skill 不进题目包", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { dir } = await initProblemScaffold({
      slug: "with-skill",
      template: "code",
      root,
    });
    await installProblemSetterSkill({ root: dir });
    const packed = packBundle({ entries: await collectBundleEntries(dir) });
    assert(packed.included.length > 0);
    assertEquals(
      packed.included.filter((n) =>
        n.startsWith(".agents") || n.startsWith(".claude")
      ),
      [],
    );
    assert(packed.excluded.some((n) => n.startsWith(".agents/skills/")));
    assert(packed.excluded.some((n) => n.startsWith(".claude/skills/")));

    // 只排除根级目录，不误伤题目数据里同名的子目录
    assertEquals(shouldExclude("data/.agents/x.txt"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("parseProblemArgs：--force 只能用于 problem skill", () => {
  assertEquals(parseProblemArgs(["skill", ".", "--force"]).force, true);
  for (const sub of ["push", "pack", "init", "lint", "test"]) {
    assertThrows(
      () => parseProblemArgs([sub, "x", "--force"]),
      UsageError,
      "--force",
    );
  }
});
