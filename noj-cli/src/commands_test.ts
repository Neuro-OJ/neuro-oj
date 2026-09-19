import { assert, assertEquals } from "@std/assert";
import {
  COMMANDS,
  type CommandSpec,
  declaredTopLevelNames,
  findCommand,
  renderCommandList,
} from "./commands.ts";
import { dispatchableTopLevelNames, KNOWN_TOP } from "./cli.ts";
import { PRODUCTION_COMMANDS } from "./production.ts";
import { CONTAINER_COMMANDS } from "./container.ts";

/** 声明中出现的全部别名（反向门禁匹配用）。 */
function declaredAliases(): Set<string> {
  const out = new Set<string>();
  for (const c of COMMANDS) for (const a of c.aliases ?? []) out.add(a);
  return out;
}

/**
 * 校验某条命令的后代：每个父级内子命令名唯一、name/summary 非空，并递归。
 *
 * 唯一性只在**同级**判定：`stack verify`（配置校验）与
 * `stack backup verify`（快照校验）是两个不同命令，跨级同名是合法的。
 */
function assertSubcommandsValid(spec: CommandSpec, path: string): void {
  const siblings = new Set<string>();
  for (const sub of spec.subcommands ?? []) {
    assert(sub.name.length > 0, `${path} 的子命令 name 不得为空`);
    assert(sub.summary.length > 0, `${path} ${sub.name} 的 summary 不得为空`);
    assertEquals(
      siblings.has(sub.name),
      false,
      `${path} 的子命令名重复: ${sub.name}`,
    );
    siblings.add(sub.name);
    assertSubcommandsValid(sub, `${path} ${sub.name}`);
  }
}

Deno.test("COMMANDS: 非空，name/summary 非空，顶层 name 唯一", () => {
  assert(COMMANDS.length > 0, "命令清单不得为空");
  const seen = new Set<string>();
  for (const c of COMMANDS) {
    assert(c.name.length > 0, "顶层 name 不得为空");
    assert(c.summary.length > 0, `${c.name} 的 summary 不得为空`);
    assertEquals(seen.has(c.name), false, `顶层命令名重复: ${c.name}`);
    seen.add(c.name);
    // 子命令（递归）：同级内唯一、name/summary 非空
    assertSubcommandsValid(c, c.name);
  }
});

Deno.test("renderCommandList: 含全部顶层命令、分区标题与退出码", () => {
  const text = renderCommandList();
  // 顶层名必须是某一行的行首 token（避免被同名子命令"顺便"命中）
  const firstTokens = new Set(
    text.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? ""),
  );
  for (const name of declaredTopLevelNames()) {
    assert(firstTokens.has(name), `顶层 help 缺少命令 ${name}`);
  }
  // T23：`JSON 编排模式` 分区已随双模态删除，故不再断言它存在。
  // （断言一个已删除的分区标题存在，等于要求实现保留已删功能。）
  for (
    const title of [
      "生产模式",
      "题目包管理",
      "服务端管理",
      "全局命令与选项",
    ]
  ) {
    assert(text.includes(title), `help 缺少分区标题 ${title}`);
  }
  assert(text.includes("用法: noj-cli"), "help 缺少用法行");
  assert(text.includes("退出码"), "help 缺少退出码分区");
});

Deno.test("防漂移门禁: 声明的顶层命令 ⊆ dispatcher 实际可处理集合", async () => {
  const declared = declaredTopLevelNames();
  const handled = await dispatchableTopLevelNames();
  const undeclared = [...declared].filter((n) => !handled.has(n)).sort();
  assertEquals(
    undeclared,
    [],
    `这些命令出现在 help 但 dispatcher 无法处理（help 漂移）: ${
      undeclared.join(", ")
    }`,
  );
});

Deno.test("防漂移门禁自检: 注入虚构命令必须被判为不可处理（非恒真）", async () => {
  const handled = await dispatchableTopLevelNames();
  const declared = declaredTopLevelNames();
  // 基线：当前真实的漂移（正常应为空集；真有漂移时由主门禁报错）
  const baseline = [...declared].filter((n) => !handled.has(n)).sort();
  // 注入一个 dispatcher 绝不可能处理的虚构名，失败集合必须**恰好**增加它。
  // 这样断言不会掩盖真实漂移，也不会因真实漂移而误报"门禁有效"。
  const planted = new Set([...declared, "frobnicate-xyz"]);
  const withPlant = [...planted].filter((n) => !handled.has(n)).sort();
  assertEquals(
    withPlant,
    [...baseline, "frobnicate-xyz"].sort(),
    "门禁必须能识别出未实现的声明，否则形同虚设",
  );
  assertEquals(handled.has("frobnicate-xyz"), false);
});

Deno.test("完整性: PRODUCTION_COMMANDS 全部出现在声明中", () => {
  const declared = declaredTopLevelNames();
  const aliases = declaredAliases();
  const missing = [...PRODUCTION_COMMANDS]
    .filter((n) => !declared.has(n) && !aliases.has(n))
    .sort();
  assertEquals(
    missing,
    [],
    `生产命令未在 help 声明: ${missing.join(", ")}`,
  );
});

Deno.test("反向门禁: cli.ts 自登记的命令名（KNOWN_TOP）必须已被声明", () => {
  const declared = declaredTopLevelNames();
  const aliases = declaredAliases();
  const missing = [...KNOWN_TOP]
    .filter((n) => !declared.has(n) && !aliases.has(n))
    .sort();
  assertEquals(
    missing,
    [],
    `KNOWN_TOP 中未在 help 声明的命令（help 漏登记）: ${missing.join(", ")}`,
  );
});

Deno.test("cli.ts 自洽: KNOWN_TOP ⊆ dispatcher 可处理集合", async () => {
  const handled = await dispatchableTopLevelNames();
  const missing = [...KNOWN_TOP].filter((n) => !handled.has(n)).sort();
  assertEquals(
    missing,
    [],
    `KNOWN_TOP 中 dispatcher 无法处理的命令: ${missing.join(", ")}`,
  );
});

Deno.test("漂移回归: backup 声明包含 list 与 prune，且可从顶层 help 发现", () => {
  const backup = findCommand("backup");
  assert(backup !== undefined, "必须声明 backup");
  const subs = new Set((backup.subcommands ?? []).map((s) => s.name));
  for (const sub of ["create", "verify", "restore", "drill", "list", "prune"]) {
    assert(subs.has(sub), `backup 子命令声明缺少 ${sub}`);
  }
  const text = renderCommandList();
  assert(text.includes("backup list"), "顶层 help 应可发现 backup list");
  assert(text.includes("backup prune"), "顶层 help 应可发现 backup prune");
});

Deno.test("准确: backup 的 help 不得声称支持 schedule（E5 回归，T23 重定向）", () => {
  // T23：原用例检查的是 `stack` 的 backup 条目，但 stack 已删除。
  // E5 的**实质**是"help 不得声明实现不支持的能力"——那条不因模态收敛而失效，
  // 因此改为检查幸存的生产 backup 条目。
  const backup = findCommand("backup");
  assert(backup !== undefined, "必须声明 backup 命令");
  assert(backup.subcommands !== undefined, "backup 必须声明子命令");
  const names = backup.subcommands!.map((s) => s.name);
  // E5 的原缺陷是"**声明了实现不支持的能力**"。T23 之后生产 backup **确实**
  // 实现了 schedule（T20 交付了 crontab 标记区块管理），因此声明它是**准确的**；
  // 反过来断言"不得含 schedule"会把已交付的能力从 help 里删掉。
  // 这里锁住的是"声明与实现一致"这一实质：清单里必须有 schedule。
  assertEquals(
    names.includes("schedule"),
    true,
    "backup 已实现 schedule（T20），help 必须声明它",
  );
  // 同时不得出现旧的合写短语（它对应已删除的 stack 条目，且未列 list/prune）
  assertEquals(
    renderCommandList().includes("create/verify/restore/drill/schedule"),
    false,
    "help 不得使用旧的合写短语（漏列 list/prune）",
  );
});

Deno.test("Tier 3 声明的顶层名必须都能被容器路由识别", () => {
  const tier3Top = new Set(
    CONTAINER_COMMANDS.map((prefix) => prefix[0] ?? "").filter((n) => n !== ""),
  );
  const declaredTier3 = COMMANDS.filter((c) => c.tier === "tier3").map(
    (c) => c.name,
  );
  const missing = declaredTier3.filter((n) => !tier3Top.has(n));
  assertEquals(
    missing,
    [],
    `Tier 3 声明了容器路由不认识的名字: ${missing.join(", ")}`,
  );
});

// ── T23：双模态残留门禁 ──────────────────────────────────────────
//
// M5/M6/M7 的验收"rg 残留为空"在此**门禁化**——只靠一次性 grep 无法防止
// 后来者重新引入旧名（例如复制粘贴一段旧代码）。这里断言的是**行为面**
// 而非文本面：命令注册表与 help 里不得再出现旧命令。

Deno.test("T23 残留门禁: 命令注册表不含已删除的旧命令", () => {
  const removed = ["stack", "deploy", "maintain", "run-server", "doctor"];
  const declared = COMMANDS.map((c) => c.name);
  for (const name of removed) {
    assertEquals(
      declared.includes(name),
      false,
      `命令注册表不得再声明 ${name}（T23 已移除）`,
    );
  }
});

Deno.test("T23 残留门禁: 顶层 help 不列旧命令，且不出现旧分区标题", () => {
  const text = renderCommandList();
  const firstTokens = new Set(
    text.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? ""),
  );
  for (const name of ["stack", "deploy", "maintain", "run-server", "doctor"]) {
    assertEquals(
      firstTokens.has(name),
      false,
      `顶层 help 不得把 ${name} 列为命令`,
    );
  }
  assertEquals(
    text.includes("JSON 编排模式"),
    false,
    "help 不得再出现已删除的 JSON 编排模式分区",
  );
  assertEquals(
    text.includes("noj-deploy.json"),
    false,
    "help 不得再提已删除的双配置文件",
  );
});

Deno.test("T23 残留门禁: Tier 类型与分区表只剩单模态", () => {
  // 类型层面已由 TS 保证（Tier 不含 "stack"），这里锁住**运行期**的分区表：
  // 任何 tier 值都必须在 SECTIONS 里有标题，否则 renderCommandList 会渲染出
  // 无标题的孤儿分区（或抛错）。用渲染结果反推分区表是完整的。
  const text = renderCommandList();
  const tiers = new Set(COMMANDS.map((c) => c.tier));
  for (const tier of tiers) {
    // 每个实际使用的 tier 都必须让 help 里出现对应分区标题
    if (tier === "prod") assertEquals(text.includes("生产模式"), true);
    if (tier === "problem") assertEquals(text.includes("题目包管理"), true);
    if (tier === "tier3") assertEquals(text.includes("服务端管理"), true);
    if (tier === "global") assertEquals(text.includes("全局命令"), true);
  }
});
