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
];

/** 子进程内渲染 fixture 的脚本（各模块用自己的 import map 执行）。 */
function rendererSource(moduleDir: string, absImport: string): string {
  const isCore = moduleDir === CORE_DIR;
  const call = isCore
    ? `formatPretty({ timestamp: "14:32:07.412", record }, { color: f.color, production: !!f.production })`
    : `formatPretty({ timestamp: "14:32:07.412", record }, { color: f.color })`;
  return `
import { formatPretty } from ${JSON.stringify(absImport)};

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
): Promise<string[]> {
  const rel = moduleDir === CORE_DIR
    ? "src/shared/base/log-format.ts"
    : "src/logger.ts";
  // 仓库根 = 本脚本所在目录的上一级。
  const repoRoot = new URL("../", import.meta.url);
  const absImport = new URL(`${moduleDir}/${rel}`, repoRoot).href;
  const script = rendererSource(moduleDir, absImport);
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

if (import.meta.main) {
  const names = FIXTURES.map((f) => f.name);
  const [coreOut, gwOut] = await Promise.all([
    render(CORE_DIR, FIXTURES),
    render(GATEWAY_DIR, FIXTURES),
  ]);
  const problems = diffRenders(coreOut, gwOut, names);
  if (problems.length > 0) {
    console.error(
      `[check-log-parity] 发现 ${problems.length} 处跨运行时渲染漂移：\n`,
    );
    for (const p of problems) console.error(p + "\n");
    Deno.exit(1);
  }
  console.log(
    `[check-log-parity] 通过：${FIXTURES.length} 个 fixture 在 core 与 gateway 渲染一致`,
  );
}
