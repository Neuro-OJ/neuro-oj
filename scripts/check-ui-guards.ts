/**
 * noj-ui 设计系统守卫（棘轮）：七条规则 × 三个作用域。
 *
 * 背景：`noj-ui` 的圆角 / 色板 / 动效 / 入场编排 / 暗色 / 原生控件 / 字号，此前
 * 只靠 review 的记忆守住（AGENTS.md 禁令 9）。一次重构就能把 `rounded-xl`、
 * `bg-blue-500` 悄悄加回来，而没有任何机器信号。本门禁把**当前存量**登记成
 * 基线，逐项比对。
 *
 * 为什么是 `!==` 而不是 `>`（硬棘轮）：只拦增长时，`基线 167 → 当前 160` 会
 * "通过"而基线仍是 167——下一个 PR 加回 6 处（166 < 167）依旧通过，等于发了
 * 一张 167 的永久额度。因此**下降也必须红灯**，逼提交者用 `--write-baseline`
 * 把成果写进基线；额度只减不增。
 *
 * 用法（三选一，默认 `--check`）：
 *   deno run -A scripts/check-ui-guards.ts                  # 门禁（CI / check-all）
 *   deno run -A scripts/check-ui-guards.ts --report         # 三 scope 表 + JSON
 *   deno run -A scripts/check-ui-guards.ts --write-baseline # 唯一允许写基线的入口
 *
 * 自检（任一失败即红灯，避免"门禁自动变绿"）：
 *   1. 扫到的 `noj-ui/**\/*.vue` 少于 100 个——扫描根或过滤规则失效；
 *   2. 基线文件缺失 / 不可读——没有可比对的事实源；
 *   3. 内置探针在任一规则上命中数不符——正则写错了，规则形同虚设。
 *
 * 规则与扫描分别在 `lib/ui-guards-rules.ts`、`lib/ui-guards-scan.ts`，
 * 报告渲染在 `lib/ui-guards-report.ts`。
 */

import {
  RULE_NAMES,
  type RuleName,
  verifyProbe,
} from "./lib/ui-guards-rules.ts";
import {
  renderReportJson,
  renderTable,
  summarize,
} from "./lib/ui-guards-report.ts";
import {
  type Scan,
  scanUi,
  SCOPE_NAMES,
  type ScopeName,
  toPosix,
} from "./lib/ui-guards-scan.ts";

/**
 * 仓库根：由 `import.meta.url` 定位（本文件位于 `<repo>/scripts/`），不依赖 cwd。
 */
export const REPO_ROOT = (() => {
  const path = decodeURIComponent(new URL("../", import.meta.url).pathname);
  // Windows 下 pathname 形如 `/E:/neuro-oj/`，去掉盘符前的斜杠。
  return toPosix(/^\/[A-Za-z]:/.test(path) ? path.slice(1) : path);
})();

export const BASELINE_PATH = "scripts/ui-guards-baseline.json";

/** 基线格式版本；结构变更时递增，强制重建。 */
export const BASELINE_VERSION = 1;

/** 自检门槛：扫到的 `.vue` 少于该数即判定扫描失效。 */
export const MIN_SCANNED_FILES = 100;

export interface Baseline {
  version: number;
  generated_by: string;
  scopes: Partial<Record<ScopeName, Partial<Record<RuleName, number>>>>;
}

/** 由当前扫描结果生成基线（键顺序固定，输出可复现；不写时间戳以免无意义 diff）。 */
export function buildBaseline(scan: Scan): Baseline {
  const scopes: Baseline["scopes"] = {};
  for (const scope of SCOPE_NAMES) scopes[scope] = { ...scan[scope].counts };
  return {
    version: BASELINE_VERSION,
    generated_by: "scripts/check-ui-guards.ts --write-baseline",
    scopes,
  };
}

/** 解析并校验基线；格式不对直接抛错（调用方转成门禁失败）。 */
export function parseBaseline(text: string): Baseline {
  const data = JSON.parse(text) as Partial<Baseline>;
  if (data.version !== BASELINE_VERSION) {
    throw new Error(
      `基线版本为 ${String(data.version)}，期望 ${BASELINE_VERSION}`,
    );
  }
  if (!data.scopes || typeof data.scopes !== "object") {
    throw new Error("基线缺少 scopes 字段");
  }
  return data as Baseline;
}

/**
 * 与基线逐项比对：**任何不等都失败**（增长 = 违规回流；下降 = 基线过期）。
 */
export function compareWithBaseline(
  scan: Scan,
  baseline: Baseline,
): string[] {
  const errors: string[] = [];
  for (const scope of SCOPE_NAMES) {
    for (const rule of RULE_NAMES) {
      const current = scan[scope].counts[rule];
      const base = baseline.scopes[scope]?.[rule];
      if (typeof base !== "number") {
        errors.push(
          `${scope}/${rule} 未登记基线（当前 ${current}）——请运行 --write-baseline 建立`,
        );
        continue;
      }
      if (current === base) continue;
      const diff = current - base;
      errors.push(
        diff > 0
          ? `${scope}/${rule} 增加：基线 ${base} → 当前 ${current}（+${diff}）——设计系统违规不允许回流`
          : `${scope}/${rule} 减少：基线 ${base} → 当前 ${current}（${diff}）——棘轮要求逐项相等，请运行 --write-baseline 把成果写进基线`,
      );
    }
  }
  return errors;
}

/** 与基线无关的自检项（文件数 + 探针）。 */
export function selfCheck(
  scan: Scan,
  minScannedFiles = MIN_SCANNED_FILES,
): string[] {
  const errors: string[] = [];
  if (scan.all.files < minScannedFiles) {
    errors.push(
      `只扫到 ${scan.all.files} 个 noj-ui/**/*.vue（自检要求 ≥ ${minScannedFiles}）——扫描根或排除规则已失效`,
    );
  }
  errors.push(...verifyProbe());
  return errors;
}

export interface CheckOptions {
  /** 自检门槛；夹具测试可用 0 绕过（CLI 不暴露）。 */
  minScannedFiles?: number;
  /** 基线路径（相对扫描根）。 */
  baselinePath?: string;
}

export interface CheckResult {
  scan: Scan;
  errors: string[];
}

/** 读基线；缺失或格式错误时返回 `null` 与失败原因（调用方转成门禁失败）。 */
export async function loadBaseline(
  root: string,
  baselinePath = BASELINE_PATH,
): Promise<{ baseline: Baseline | null; errors: string[] }> {
  try {
    return {
      baseline: parseBaseline(
        await Deno.readTextFile(`${toPosix(root)}/${baselinePath}`),
      ),
      errors: [],
    };
  } catch (err) {
    return {
      baseline: null,
      errors: [
        `基线不可读：${baselinePath}（${
          err instanceof Error ? err.message : String(err)
        }）——首次建立请运行 deno run -A scripts/check-ui-guards.ts --write-baseline`,
      ],
    };
  }
}

/** 完整门禁：扫描 → 自检 → 读基线 → 逐项比对。 */
export async function checkUiGuards(
  root: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const scan = await scanUi(root);
  const errors = selfCheck(scan, options.minScannedFiles);
  const loaded = await loadBaseline(root, options.baselinePath);
  errors.push(...loaded.errors);
  if (loaded.baseline) {
    errors.push(...compareWithBaseline(scan, loaded.baseline));
  }
  return { scan, errors };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const mode = Deno.args.includes("--write-baseline")
    ? "write"
    : Deno.args.includes("--report")
    ? "report"
    : "check";

  const scan = await scanUi(REPO_ROOT);
  const selfErrors = selfCheck(scan);
  if (selfErrors.length > 0) {
    console.error("设计系统守卫自检失败（门禁当前不可信）：");
    for (const err of selfErrors) console.error(`- ${err}`);
    Deno.exit(1);
  }

  if (mode === "write") {
    const baseline = buildBaseline(scan);
    await Deno.writeTextFile(
      `${REPO_ROOT}/${BASELINE_PATH}`,
      JSON.stringify(baseline, null, 2) + "\n",
    );
    console.log(`基线已写入 ${BASELINE_PATH}（${summarize(scan)}）`);
    Deno.exit(0);
  }

  if (mode === "report") {
    console.log(renderTable(scan));
    console.log("");
    console.log(renderReportJson(scan));
    Deno.exit(0);
  }

  const loaded = await loadBaseline(REPO_ROOT);
  if (!loaded.baseline) {
    console.error(`设计系统守卫失败：${loaded.errors[0]}`);
    Deno.exit(1);
  }

  const errors = compareWithBaseline(scan, loaded.baseline);
  if (errors.length > 0) {
    console.error("设计系统守卫失败（当前与基线不逐项相等）：");
    for (const err of errors) console.error(`- ${err}`);
    console.error(
      "\n违规回流：改用设计系统 token / U* 组件；\n" +
        "已修复导致下降：运行 deno run -A scripts/check-ui-guards.ts --write-baseline 锁住成果。",
    );
    Deno.exit(1);
  }
  console.log(
    `设计系统守卫通过（${summarize(scan)}；与 ${BASELINE_PATH} 逐项相等）`,
  );
}
