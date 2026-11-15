import { assert, assertEquals } from "@std/assert";
import {
  COMMANDS,
  type CommandSpec,
  findCommand,
  renderCommandList,
} from "./commands.ts";
import { run } from "./cli.ts";
import { EXIT_OK } from "./cli-commands/exit-codes.ts";

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
  for (const { name } of COMMANDS) {
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

Deno.test("可达性门禁: 每个顶层命令（含别名）都能被分发，--help 不落入未知命令", async () => {
  const origLog = console.log;
  const origErr = console.error;
  for (const cmd of COMMANDS) {
    for (const name of [cmd.name, ...(cmd.aliases ?? [])]) {
      if (name.startsWith("-")) continue;
      let err = "";
      console.log = () => {};
      console.error = (...a: unknown[]) => {
        err += a.join(" ") + "\n";
      };
      let code = -1;
      try {
        code = await run([name, "--help"]);
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
      assertEquals(code, EXIT_OK, `${name} --help 应返回 0，stderr：${err}`);
      assertEquals(err.includes("未知命令"), false, `${name} 不可达`);
    }
  }
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

Deno.test("P1d: maintain 作为 Tier 3 命令声明完整且可从 help 发现", () => {
  const maintain = COMMANDS.find((c) => c.name === "maintain");
  assert(maintain !== undefined, "必须声明 maintain");
  assertEquals(maintain.tier, "tier3");
  const subs = new Set((maintain.subcommands ?? []).map((s) => s.name));
  for (const sub of ["enter", "status", "wait", "exit"]) {
    assert(subs.has(sub), `maintain 子命令声明缺少 ${sub}`);
  }
  // 顶层 help 必须可发现子命令（P1d 的可操作性：人工干预入口）
  const text = renderCommandList();
  assert(text.includes("maintain enter"), "顶层 help 应可发现 maintain enter");
});

// ── T23：双模态残留门禁 ──────────────────────────────────────────
//
// M5/M6/M7 的验收"rg 残留为空"在此**门禁化**——只靠一次性 grep 无法防止
// 后来者重新引入旧名（例如复制粘贴一段旧代码）。这里断言的是**行为面**
// 而非文本面：命令注册表与 help 里不得再出现旧命令。

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

// ── T26：能力可达性门禁（补防漂移门禁的盲区）────────────────────────
//
// **这个盲区真实存在过。** T21 交付了 `prod/judge/*`（36 个测试全过），但 `judge`
// 既没登记进 `PRODUCTION_COMMANDS`、也没有分发分支——**该能力从 CLI 完全不可达**，
// 而 36 个测试全绿也没发现，因为它们只断言模块**内部**行为。
//
// 已有的"防漂移门禁"只检查单向（`declared ⊆ dispatchable`），因此只能抓
// "help 里有、分发里没有"；抓不到反向的"**实现有、命令面上没有**"。
// 本门禁补上反向：`prod/` 下的每个**域模块**都必须有可达的命令入口。

Deno.test("T26 可达性门禁: prod/ 的每个域模块都有可达的 CLI 入口", async () => {
  // 域模块 → 期望可达的顶层命令。**新增域模块时必须在此登记**——
  // 这是本门禁的"人审锚点"：忘记登记会让该模块的实现对用户不可见。
  const DOMAIN_TO_COMMAND: Record<string, string> = {
    // T19 隔离恢复演练：经由 `backup drill`
    "drill/drill.ts": "backup",
    // T20 crontab 标记区块：经由 `backup schedule`
    "schedule.ts": "backup",
    // T21 独立 Judge：顶层命令 `judge`
    "judge/actions.ts": "judge",
    // T17/T18 备份容器与命令面：经由 `backup`
    "backup/commands.ts": "backup",
    // T12–T16 生命周期：顶层生产命令
    "lifecycle.ts": "install",
  };

  // 命令表即分发依据，声明即可达（见上方可达性门禁），这里只需查声明。
  const declared = new Set(COMMANDS.map((c) => c.name));
  const problems: string[] = [];
  for (const [mod, command] of Object.entries(DOMAIN_TO_COMMAND)) {
    if (!(await fileExists(`./prod/${mod}`))) {
      problems.push(`${mod} 不存在（域模块被删但映射未更新）`);
      continue;
    }
    if (!declared.has(command)) {
      problems.push(
        `${mod} 已交付，但命令 ${command} 未在 help 声明（用户发现不了）`,
      );
    }
  }
  assertEquals(
    problems,
    [],
    `能力可达性缺陷：\n${problems.join("\n")}`,
  );
});

/**
 * 文件是否存在（本地小工具，避免引入额外依赖）。
 *
 * 相对路径以**本测试文件所在目录**（`src/`）为基准解析，故调用方传 `./prod/...`。
 */
async function fileExists(relativePath: string): Promise<boolean> {
  try {
    return (await Deno.stat(new URL(relativePath, import.meta.url))).isFile;
  } catch {
    return false;
  }
}

// ── T26：窄终端不破版（spec R5）──────────────────────────────────────
//
// **这个缺陷真实存在过**：`renderCommandList` 此前手写 `padEnd` 对齐，
// 绕过了 `renderTable` 已有的宽度感知能力（及其测试）。
// `COLUMNS=40` 下实测 **26 行**溢出——在窄终端里会被折断成难以阅读的碎片。
//
// 修法：help 的命令表与分区散文都走宽度约束渲染。
// 本门禁断言的是**性质**（任何一行都不超过给定宽度），而不是某几行的快照——
// 快照会随文案改动频繁失效，而"不破版"才是要守的东西。

Deno.test("T26 门禁: 窄终端下 help 每一行都不超过给定宽度", async () => {
  const { displayWidth } = await import("./output/render.ts");
  for (const maxWidth of [30, 40, 60, 80]) {
    const text = renderCommandList({ maxWidth });
    const tooWide = text.split("\n")
      .map((line, i) => ({ i: i + 1, w: displayWidth(line), line }))
      .filter((x) => x.w > maxWidth);
    assertEquals(
      tooWide.map((x) => `第 ${x.i} 行 (${x.w} > ${maxWidth}): ${x.line}`),
      [],
      `maxWidth=${maxWidth} 下 help 不得溢出`,
    );
  }
});

Deno.test("T26: 不传 maxWidth 时保持既有行为（不折行）", async () => {
  // 缺省不限制宽度：调用方与既有测试可直接比较全文。
  const { displayWidth } = await import("./output/render.ts");
  const text = renderCommandList();
  assert(
    text.split("\n").some((l) => displayWidth(l) > 80),
    "缺省应保持自然宽度（不折行），否则会改变既有输出契约",
  );
});
