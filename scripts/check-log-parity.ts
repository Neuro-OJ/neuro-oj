/**
 * 跨运行时日志渲染一致性校验（noj-core ↔ noj-llm-gateway）。
 *
 * 背景：两个 Deno 模块各自部署，`log-format.ts` 与 `logger.ts` 的渲染实现
 * 是**刻意独立**的（跨模块相对导入会破坏 `deno check` 与 exports 边界）。
 * 独立的代价是容易漂移——上一轮就出现过「`request_id` 豁免只在一侧生效」
 * 这类只在生产才显形的偏差。
 *
 * 本脚本用**同一组 fixture** 分别驱动两侧 formatter，逐字符比对输出。
 * 因为两侧的 import map 不同（各自 deno.json 声明 `@logtape/logtape`），
 * 无法在同一进程内导入，故各自起一个子进程渲染并以 JSON 交换结果。
 *
 * 用法：
 *   deno run -A scripts/check-log-parity.ts
 */

const CORE_DIR = "noj-core";
const GATEWAY_DIR = "noj-llm-gateway";

/** 一份 fixture：驱动两侧渲染同一批记录。 */
export interface Fixture {
  name: string;
  /** 记录字段（两侧共用同一形状）。 */
  record: {
    category: string[];
    level: string;
    rawMessage: string;
    message: unknown[];
    properties: Record<string, unknown>;
  };
  /** 渲染选项。 */
  color: boolean;
  /** 仅在 production 下渲染（脱敏相关 fixture）。 */
  production?: boolean;
  /**
   * 需要重建为**真实 Error 实例**的字段名。
   *
   * fixture 经 JSON 传给子进程，`Error` 会被序列化成普通对象从而丢掉
   * `instanceof Error` 语义——若不重建，Error 详情块这条路径在两侧都**不会
   * 被真正执行**（parity 会「通过」却毫无覆盖）。
   */
  errorFields?: string[];
}

/** 基准 fixture：覆盖布局、颜色、脱敏、Error、边界形状。 */
export const FIXTURES: Fixture[] = [
  {
    name: "info + 字段 + rid",
    color: false,
    record: {
      category: ["noj", "submission"],
      level: "info",
      rawMessage: "评测任务入队 submission={submission_id}",
      message: [
        "评测任务入队 submission=",
        "550e8400-e29b-41d4-a716-446655440000",
      ],
      properties: {
        submission_id: "550e8400-e29b-41d4-a716-446655440000",
        queue_length: 3,
        request_id: "550e8400aa",
      },
    },
  },
  {
    name: "warn 着色",
    color: true,
    record: {
      category: ["noj", "mq"],
      level: "warning",
      rawMessage: "Redis 未就绪，进入 degraded 模式",
      message: ["Redis 未就绪，进入 degraded 模式"],
      properties: { retry_in_ms: 2000 },
    },
  },
  {
    name: "error 着色（整行粗体 + Error 块）",
    color: true,
    errorFields: ["error"],
    record: {
      category: ["noj", "content-review"],
      level: "error",
      rawMessage: "写入失败",
      message: ["写入失败"],
      properties: {
        error: {
          name: "Error",
          message: "connection terminated",
          stack:
            "Error: connection terminated\n    at src/mq/consumer.ts:88:11",
        },
        submission_id: "abc",
      },
    },
  },
  {
    name: "多行 msg 缩进",
    color: false,
    record: {
      category: ["noj", "core"],
      level: "info",
      rawMessage: "第一行\n第二行",
      message: ["第一行\n第二行"],
      properties: {},
    },
  },
  {
    name: "超宽模块名截断",
    color: false,
    record: {
      category: ["noj", "a-very-long-module-name"],
      level: "info",
      rawMessage: "x",
      message: ["x"],
      properties: {},
    },
  },
  {
    name: "无 category（保留列宽）",
    color: false,
    record: {
      category: [],
      level: "info",
      rawMessage: "无模块",
      message: ["无模块"],
      properties: { n: 1 },
    },
  },
  {
    name: "数值 vs 字符串着色",
    color: true,
    record: {
      category: ["noj", "db"],
      level: "debug",
      rawMessage: "连接池",
      message: ["连接池"],
      properties: { pool: 10, channel: "events", flag: true },
    },
  },
  {
    name: "生产脱敏（id 截断 + 敏感键抹除）",
    color: false,
    production: true,
    record: {
      category: ["noj", "identity"],
      level: "info",
      rawMessage: "用户 {user_id} 登录",
      message: ["用户 ", "550e8400-e29b-41d4-a716-446655440000", " 登录"],
      properties: {
        user_id: "550e8400-e29b-41d4-a716-446655440000",
        email: "a@b.com",
        request_id: "abcdefgh-1234",
      },
    },
  },
  {
    name: "无 stack 的非 Error 错误（生产会剥 stack）",
    color: false,
    production: true,
    errorFields: ["error"],
    record: {
      category: ["noj", "content-review"],
      level: "error",
      rawMessage: "写入失败",
      message: ["写入失败"],
      properties: {
        // name 非 "Error" 且**无 stack**：生产会剥掉 stack，此时 core 会补上
        // name（`error: TypeError: boom`）；若 gateway 不补就会渲染成
        // `error: boom`，造成跨服务不一致（review 复审指出）。
        error: { name: "TypeError", message: "boom" },
        submission_id: "550e8400-e29b-41d4-a716-446655440000",
      },
    },
  },
];

/**
 * 渲染路径：直接调 `formatPretty`，或走各模块真实的 formatter 构造器。
 * 两条都要测——只测前者会漏掉"构造器忘记下传 production"的死接线。
 */
export type RenderMode = "direct" | "formatter";

/** 子进程内渲染 fixture 的脚本（各模块用自己的 import map 执行）。 */
function rendererSource(
  absImport: string,
  mode: RenderMode,
  formatterName: string,
): string {
  // production 必须**显式**传给两个运行时：早先只有 core 传、gateway 不传，
  // 且两侧都靠全局 NOJ_ENV 判定，于是「生产脱敏」fixture 在非生产环境下
  // 只是验证了「两边同样没脱敏」——假通过（review P1）。
  //
  // mode=formatter 走各自的**真实构造器**（makePrettyFormatter /
  // makeGatewayPrettyFormatter）。这一路必须覆盖：只测 `formatPretty` 时，
  // "构造器忘了把 production 传下去" 这类死接线完全测不到——复审实测把
  // gateway 的 setup 接线还原成读全局 env，parity 仍报通过。
  const call = mode === "formatter"
    ? `makeFormatter({ color: f.color, production: !!f.production })(record)`
    : `formatPretty({ timestamp: "14:32:07.412", record }, { color: f.color, production: !!f.production })`;
  const imp = mode === "formatter"
    ? `import { ${formatterName} as makeFormatter } from ${JSON.stringify(absImport)};`
    : `import { formatPretty } from ${JSON.stringify(absImport)};`;
  return `
${imp}

const fixtures = JSON.parse(Deno.args[0]);
const out = fixtures.map((f) => {
  const properties = { ...f.record.properties };
  // 重建真实 Error：JSON 传输会丢失 instanceof Error 语义，不重建则
  // Error 详情块路径不会被实际执行（parity 会假通过）。
  for (const key of f.errorFields ?? []) {
    const raw = properties[key];
    if (raw && typeof raw === "object") {
      const err = new Error(raw.message ?? "");
      err.name = raw.name ?? "Error";
      if (typeof raw.stack === "string") err.stack = raw.stack;
      properties[key] = err;
    }
  }
  const record = {
    category: f.record.category,
    level: f.record.level,
    rawMessage: f.record.rawMessage,
    message: f.record.message,
    timestamp: Date.parse("2026-09-12T05:11:45.689Z"),
    properties,
  };
  return ${call};
});
console.log(JSON.stringify(out));
`;
}

/** 在指定模块目录内渲染全部 fixture，返回渲染结果。 */
async function render(
  moduleDir: string,
  fixtures: Fixture[],
  mode: RenderMode = "direct",
): Promise<string[]> {
  const rel = moduleDir === CORE_DIR
    ? "src/shared/base/log-format.ts"
    : "src/logger.ts";
  // 仓库根 = 本脚本所在目录的上一级。
  const repoRoot = new URL("../", import.meta.url);
  const absImport = new URL(`${moduleDir}/${rel}`, repoRoot).href;
  // core 与 gateway 的构造器导出名不同（历史命名），逐一映射。
  const formatterName = moduleDir === CORE_DIR
    ? "makePrettyFormatter"
    : "makeGatewayPrettyFormatter";
  const script = rendererSource(absImport, mode, formatterName);
  // 临时目录放在系统 tmp：**不得**落在仓库内。放在模块目录下时，一旦本脚本
  // 被中断（如管道给 head 触发 EPIPE）清理就不会执行，残留的 .ts 会被
  // `deno fmt --check` / lint 扫到并让 CI 变红。
  // import map 仍由 `--config` 提供，故 /tmp 下也能解析 bare specifier。
  const tmpDir = await Deno.makeTempDir({
    dir: Deno.build.os === "windows" ? undefined : "/tmp",
  });
  const tmp = `${tmpDir}/render.ts`;
  try {
    await Deno.writeTextFile(tmp, script);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        `${moduleDir}/deno.json`,
        tmp,
        JSON.stringify(fixtures),
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(
        `[${moduleDir}] 渲染失败（exit ${code}）:\n${
          new TextDecoder().decode(stderr)
        }`,
      );
    }
    return JSON.parse(new TextDecoder().decode(stdout).trim()) as string[];
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

/**
 * 契约允许的**跨运行时差异**（其余字段必须逐字符一致）。
 *
 * `log-conventions.md` §6 明确规定：`client_ip` / `ip` / `ips` 是**网关特有**
 * 规则（隐私最小化，core 无此规则）。parity 用同一组 fixture 驱动两侧，
 * 因此这类"故意不同"的字段不能进 fixture，否则会把设计差异误报成漂移。
 * 此处显式登记，防止日后有人误以为"应该一致"而改坏其中一侧。
 */
export const INTENTIONAL_DIVERGENCES: readonly string[] = [
  "client_ip", // 仅 gateway 在生产环境整值抹除（core 保留）
  "ip",
  "ips",
];

/** 逐 fixture 比较两侧输出，返回差异描述（空数组 = 一致）。 */
export function diffRenders(
  a: string[],
  b: string[],
  names: string[],
): string[] {
  const problems: string[] = [];
  for (let i = 0; i < names.length; i++) {
    if (a[i] !== b[i]) {
      problems.push(
        `fixture #${i} 「${names[i]}」渲染不一致：\n` +
          `  core    = ${JSON.stringify(a[i])}\n` +
          `  gateway = ${JSON.stringify(b[i])}`,
      );
    }
  }
  return problems;
}

/**
 * production fixture 的**有效性**断言（防假绿灯）。
 *
 * parity 只比较"两侧是否一致"，若两边都漏了脱敏也照样通过——这正是本次
 * 评审发现的失效形态。因此这里额外断言：标了 `production: true` 的 fixture
 * 渲染结果里，敏感字面量必须已经消失。
 *
 * 三条复审加固（原实现被证明可被绕过）：
 * 1. **两个运行时的输出都要断言**（含 gateway）。此前只查 core，于是把
 *    gateway 的 production 接线还原成读全局 env 后，两侧输出恰好一致、
 *    parity 照样报通过——P1-B 的确切失效形态漏检。
 * 2. **哨兵值从 fixture 自身推导**，不再硬编码副本。硬编码时改掉 fixture
 *    里的明文（如 email 换成 c@d.com）就会让断言静默失效。
 * 3. **必须至少有一个 production fixture**，否则 fail。此前删掉
 *    `production: true` 标记即可让门禁在"零断言"的情况下报绿。
 */
export function assertProductionRedaction(
  coreRendered: string[],
  gatewayRendered: string[],
  fixtures: Fixture[],
): string[] {
  const problems: string[] = [];
  const prodIdx = fixtures
    .map((f, i) => [f, i] as const)
    .filter(([f]) => f.production);

  if (prodIdx.length === 0) {
    problems.push(
      "没有任何 fixture 标记 production:true —— 生产脱敏断言会退化为零断言" +
        "（门禁形同虚设）。请保留至少一个 production fixture。",
    );
    return problems;
  }

  for (const [f, i] of prodIdx) {
    // 哨兵：该 fixture 输入里出现过的、且**不该**原样出现在输出中的明文。
    // 只取明显敏感的长字面量（uuid / 含 @ 的邮箱），避免把模块名等普通
    // 字符串误当哨兵。
    const secrets = collectSentinels(f);
    if (secrets.length === 0) {
      problems.push(
        `fixture #${i} 「${f.name}」标了 production:true，但输入里找不到可用于` +
          `校验的敏感哨兵（uuid 或邮箱）——该 fixture 无法证明脱敏真的生效。`,
      );
    }
    for (const [side, rendered] of [
      ["core", coreRendered],
      ["gateway", gatewayRendered],
    ] as const) {
      const text = rendered[i] ?? "";
      for (const secret of secrets) {
        if (text.includes(secret)) {
          problems.push(
            `fixture #${i} 「${f.name}」声明 production:true，但 ${side} 输出仍含明文 ${secret}：\n` +
              `  ${JSON.stringify(text)}`,
          );
        }
      }
    }
  }
  return problems;
}

/** 从一个 fixture 的输入字面量里推导"必须被脱敏"的哨兵值。 */
export function collectSentinels(fixture: Fixture): string[] {
  const out = new Set<string>();
  const consider = (v: unknown): void => {
    if (typeof v !== "string") return;
    // uuid 形状，或邮箱形状；两类都是不该明文出现在生产日志里的值。
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      out.add(v);
    } else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      out.add(v);
    }
  };
  for (const v of Object.values(fixture.record.properties)) consider(v);
  for (const v of fixture.record.message) consider(v);
  return [...out];
}

/**
 * 自检：fixture 不得包含「契约允许的跨运行时差异」字段。
 *
 * 若有人把 `client_ip` 之类放进 fixture，parity 会立刻报漂移——但那是**设计
 * 差异**而非缺陷，报错信息会误导。这里提前拦下并说明原因，避免把差异当 bug 修。
 */
export function assertNoDivergentFixtureKeys(
  fixtures: Fixture[],
): string[] {
  const problems: string[] = [];
  fixtures.forEach((f, i) => {
    for (const key of INTENTIONAL_DIVERGENCES) {
      if (Object.prototype.hasOwnProperty.call(f.record.properties, key)) {
        problems.push(
          `fixture #${i} 「${f.name}」包含契约允许差异的字段 \`${key}\`：` +
            `它是网关特有规则（log-conventions.md §6），core 侧刻意不实现，` +
            `放进 parity fixture 会把设计差异误报为漂移。请移出该字段。`,
        );
      }
    }
  });
  return problems;
}

if (import.meta.main) {
  const names = FIXTURES.map((f) => f.name);
  const problems: string[] = [];

  // 两条渲染路径都要过：direct（formatPretty）与 formatter（真实构造器）。
  // 后者能抓到"构造器/装配忘了下传 production"的死接线——复审实测该缺陷
  // 在只测 direct 时完全漏检。
  for (const mode of ["direct", "formatter"] as const) {
    const [coreOut, gwOut] = await Promise.all([
      render(CORE_DIR, FIXTURES, mode),
      render(GATEWAY_DIR, FIXTURES, mode),
    ]);
    const prefix = `[${mode}] `;
    problems.push(
      ...diffRenders(coreOut, gwOut, names).map((p) => prefix + p),
      // 两侧一致还不够：必须确认 production fixture 真的执行了脱敏。
      ...assertProductionRedaction(coreOut, gwOut, FIXTURES).map((p) =>
        prefix + p
      ),
    );
  }

  // fixture 自身不得混入契约允许的跨运行时差异字段。
  problems.push(...assertNoDivergentFixtureKeys(FIXTURES));

  if (problems.length > 0) {
    console.error(
      `[check-log-parity] 发现 ${problems.length} 处问题：\n`,
    );
    for (const p of problems) console.error(p + "\n");
    Deno.exit(1);
  }
  console.log(
    `[check-log-parity] 通过：${FIXTURES.length} 个 fixture 在 core 与 gateway ` +
      `渲染一致（direct + formatter 两条路径），且 production fixture 确认已脱敏`,
  );
}
