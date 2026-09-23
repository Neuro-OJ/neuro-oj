/**
 * 唯一状态机：所有命令的状态源（M1）。
 *
 * transition / DeployAction / TransitionResult 逐字移植自 src/state/machine.ts，
 * 语义与中文措辞完全一致；prodState 为新增，解决「prod 路径无状态」问题（§2.2）。
 *
 * ## T23：`DeployState` 的定义搬到这里
 *
 * 它原住在 `config/types.ts`（双模态时代的 JSON 配置类型集合）。M1 要求
 * "一套状态机"，而状态的**类型**却定义在另一份已删除的配置模态里，是明显的
 * 遗留错位：`prod/` 依赖它，就必须连整份 JSON 配置类型一起留着。
 * 现在它属于状态机自身，`config/types.ts` 可随之删除。
 */

/** 部署状态机的所有合法状态。 */
export type DeployState =
  | "uninitialized"
  | "stopped"
  | "running"
  | "partial"
  | "error";

/** 部署动作：状态机的唯一输入。 */
export type DeployAction = "init" | "up" | "down" | "restart" | "reset";

/** 状态迁移结果。 */
export interface TransitionResult {
  state: DeployState;
  /** 状态是否发生变化；false 表示 no-op（如 running 时再 up）。 */
  changed: boolean;
  message: string;
}

/** no-op 时的固定提示语（与 src/state/machine.ts 逐字一致）。 */
const NO_OP_MSG: Record<string, string> = {
  up: "已处于 running，无需重复启动",
  down: "已处于 stopped，无需重复关闭",
};

/**
 * 计算状态机在给定状态上执行某动作后的迁移结果。
 *
 * 语义（移植自 src/state/machine.ts，不得改动）：
 * - init / reset 一律进入 stopped；
 * - up 在 running 时为 no-op（changed=false），其余进入 running；
 * - down 在 stopped 时为 no-op（changed=false），其余进入 stopped；
 * - restart 一律进入 running。
 */
export function transition(
  state: DeployState,
  action: DeployAction,
): TransitionResult {
  let next: DeployState;
  let changed = true;

  switch (action) {
    case "init":
      next = "stopped";
      break;
    case "up":
      if (state === "running") {
        next = "running";
        changed = false;
      } else {
        next = "running";
      }
      break;
    case "down":
      if (state === "stopped") {
        next = "stopped";
        changed = false;
      } else {
        next = "stopped";
      }
      break;
    case "restart":
      next = "running";
      break;
    case "reset":
      next = "stopped";
      break;
  }

  return {
    state: next,
    changed,
    message: changed
      ? `状态从 ${state} 转换为 ${next}`
      : (NO_OP_MSG[action] ?? `状态保持 ${next}`),
  };
}

/** 当前状态是否 running（up 应 no-op）。 */
export function upIsNoOp(state: DeployState): boolean {
  return transition(state, "up").changed === false;
}

/** 当前状态是否 stopped（down 应 no-op）。 */
export function downIsNoOp(state: DeployState): boolean {
  return transition(state, "down").changed === false;
}

// ---------------- prodState：从 docker compose ps 推断状态 ----------------

/**
 * prodState 解析规则（不硬编码列下标）：
 *
 * 1. 归一化：按 LF 切行、剥掉行尾 CR；丢弃空行与 docker 警告行
 *    （`WARN[...]` / `time=... level=warning ...`）。
 * 2. 定位表头：首个同时满足「含独立词 STATUS 或 State」且「含另一经典表头词
 *    NAME/IMAGE/COMMAND/SERVICE/CREATED/PORTS」的行视为表头；记录 STATUS/State
 *    词在该行内的**字符起点** statusOffset。表头行本身不计为容器行。
 *    取字符起点而非分词下标，是因为 compose 用 tabwriter 按列对齐，
 *    CREATED（`2 hours ago`）等列值内含单空格，按空白分词会把一列拆成多列。
 * 3. 容器行 = 除去表头行、分隔线（整行只有 - = ─ 与空白）、警告行后仍有内容的行。
 * 4. 逐行判定：优先取 statusOffset 起的子串作为「状态段」，其首个词是
 *    `Up` → running，是 Exited/Exit/Created/Restarting/Dead/Paused/Removing/
 *    Stopped/Down 之一 → 非运行。若状态段无法判定（无表头、行短于该列、
 *    或错位到非状态词），回退为整行按词边界扫描同一组状态词。
 * 5. 汇总：无容器行 → stopped；无 running 行 → stopped；全部 running → running；
 *    两者皆有 → partial。
 *
 * 注意：Restarting 不以 Up 开头，按「状态以 Up 开头即 running」的规则视为非运行。
 */
export function prodState(composePsOutput: string): DeployState {
  const lines = splitPsLines(composePsOutput).filter((l) => !isWarningLine(l));
  let statusOffset = -1;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const offset = findStatusColumn(line);
    if (offset >= 0) {
      statusOffset = offset;
      headerIndex = i;
      break;
    }
  }

  let running = 0;
  let notRunning = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || i === headerIndex || isSeparatorLine(line)) {
      continue;
    }
    const verdict = classifyRow(line, statusOffset);
    if (verdict === null) continue;
    if (verdict) running++;
    else notRunning++;
  }

  if (running === 0) return "stopped";
  return notRunning === 0 ? "running" : "partial";
}

/** 按 LF 切行并剥掉行尾 CR（兼容 CRLF）；保留行首空白以维持列对齐。 */
function splitPsLines(text: string): string[] {
  return text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** docker 输出到 stderr 的警告行（可能混入 stdout），不参与状态判定。 */
function isWarningLine(line: string): boolean {
  const t = line.trim();
  return /^WARN[[(]/i.test(t) || /^time=.*level=warning/i.test(t);
}

/** 分隔线：整行只由 - = ─ 与空白组成（v1 表头下方会打印）。 */
function isSeparatorLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && /^[-=─\s]+$/.test(t);
}

/** 表头旁证词：用于避免把含 state/status 的容器行误判为表头。 */
const HEADER_HINT_RE = /^(name|image|command|service|ports|created)$/i;

/**
 * 若该行是表头，返回 STATUS/State 词的字符起点；否则返回 -1。
 *
 * 判定条件：分词后含 status 或 state，且还含至少一个其他经典表头词
 * （v2：name/image/command/service/created/ports；v1：name/command/ports）。
 */
function findStatusColumn(line: string): number {
  const words = [...line.matchAll(/\S+/g)];
  const lower = words.map((m) => (m[0] ?? "").toLowerCase());
  const statusIdx = lower.findIndex((w) => w === "status" || w === "state");
  if (statusIdx < 0) return -1;
  const hints = lower.filter((w) => HEADER_HINT_RE.test(w)).length;
  if (hints < 1) return -1;
  return words[statusIdx]?.index ?? -1;
}

/** 非运行状态词（小写比较）；不含 Up。 */
const NON_RUNNING = new Set([
  "exited",
  "exit",
  "created",
  "restarting",
  "dead",
  "paused",
  "removing",
  "stopped",
  "down",
]);

/** 状态词的整行回退匹配（词边界，避免命中 upstream 之类）。 */
const ROW_RUNNING_RE = /(^|\s)Up(\s|$)/;
const ROW_NON_RUNNING_RE =
  /(^|\s)(Exited|Exit|Created|Restarting|Dead|Paused|Removing|Stopped|Down)(\s|$)/i;

/** 取状态段的首个词；取不到返回空串。 */
function firstWord(segment: string): string {
  const token = segment.trim().split(/\s+/)[0];
  return token ?? "";
}

/**
 * 判定单个容器行是否运行：true=running，false=非运行，null=无法判定（忽略该行）。
 * 先按表头列位取状态段，无法判定时回退整行扫描。
 */
function classifyRow(row: string, statusOffset: number): boolean | null {
  if (statusOffset >= 0 && statusOffset < row.length) {
    const word = firstWord(row.slice(statusOffset));
    if (/^Up\b/.test(word)) return true;
    if (NON_RUNNING.has(word.toLowerCase())) return false;
  }
  if (ROW_RUNNING_RE.test(row)) return true;
  if (ROW_NON_RUNNING_RE.test(row)) return false;
  return null;
}
