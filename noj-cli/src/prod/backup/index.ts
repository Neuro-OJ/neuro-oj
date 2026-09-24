/**
 * 备份索引与保留策略（#515）。
 *
 * 解决的问题：
 * - **P6 无 list/prune**：用户无法列举已有备份，也无法显式清理；
 * - **P1 同名不同物**：snapshot-* 目录（旧生产格式）与
 *   snapshot-*.nojbackup（JSON 模式单文件）需要被**同一条路径识别**，
 *   否则存量备份无法恢复。
 *
 * 本模块是**纯逻辑**（无文件系统、无进程），可被 deno task test 直接断言。
 */

/** 备份产物格式。 */
export type SnapshotFormat = "single" | "legacy" | "unknown";

/** 单个备份产物的索引条目。 */
export interface SnapshotEntry {
  /** 文件名/目录名。 */
  name: string;
  /** 绝对路径。 */
  path: string;
  /** 创建时间（ISO）。无法解析时为 Unix epoch，排序时排到最后。 */
  createdAt: string;
  /** 大小（单文件为字节；目录为 null，需调用方按需统计）。 */
  bytes: number | null;
  format: Exclude<SnapshotFormat, "unknown">;
}

/** 识别输入。 */
export interface DetectInput {
  name: string;
  isDir: boolean;
  /** 目录内的条目名（仅 isDir 时需要）。 */
  entries?: string[];
}

/**
 * 识别备份产物格式。
 *
 * - `.nojbackup` 后缀的单文件 → single（#515 统一后的格式）；
 * - 目录且**同时**含 sha256sums.txt 与 SUCCESS → legacy
 *   （旧生产格式；两个哨兵都要有，避免把无关目录误判为备份）；
 * - 其余 → unknown（调用方忽略）。
 */
export function detectSnapshotFormat(input: DetectInput): SnapshotFormat {
  if (!input.isDir && input.name.toLowerCase().endsWith(".nojbackup")) {
    return "single";
  }
  if (input.isDir) {
    const entries = new Set(input.entries ?? []);
    if (entries.has("sha256sums.txt") && entries.has("SUCCESS")) {
      return "legacy";
    }
  }
  return "unknown";
}

/**
 * 从备份名解析创建时间。
 *
 * 支持两种命名：
 * - 单文件：`snapshot-2026-09-17T10-30-00Z.nojbackup`（ISO，冒号换成 `-`）
 * - 旧目录：`snapshot-20260917-103000`（紧凑时间戳）
 *
 * 两种形态都允许**同秒碰撞后缀**（`-1`、`-2`…），见
 * {@link allocateContainerPath}：同一秒内连续备份两次会产出
 * `snapshot-<ts>-1.nojbackup`。早先不识别此后缀，导致这类"合法产物"在
 * `listBackups` 里退化成 epoch，进而在下一次 `backup create` 的自动清理中被
 * 当成"极旧"误删（2026-09-23 复审）。
 *
 * @returns Date；无法解析返回 null（**不抛错**——list 不应因一个坏名字整体失败）。
 */
export function parseBackupName(name: string): Date | null {
  const raw = name.replace(/\.nojbackup$/i, "").replace(/^snapshot-/, "");
  // 同秒碰撞后缀：`-1` / `-2` …（`allocateContainerPath` 的产物）。
  //
  // 只在**两种已知时间戳形态都匹配失败**时才尝试剥掉后缀——否则会吃掉紧凑形态的
  // 秒字段（`20260917-103000` 末尾的 `-103000` 会被误剥）。因此这里先按原样匹配，
  // 失败后再按剥后缀重试。
  const base = raw;

  /** 按给定字符串解析两种时间戳形态；解析不出返回 null。 */
  const parseExact = (candidate: string): Date | null => {
    // ISO 形式：2026-09-17T10-30-00Z（冒号被替换为 -）
    const isoMatch = candidate.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z?$/,
    );
    if (isoMatch) {
      const [, y, mo, d, h, mi, s] = isoMatch;
      const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    // 紧凑形式：20260917-103000
    const compact = candidate.match(
      /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/,
    );
    if (compact) {
      const [, y, mo, d, h, mi, s] = compact;
      const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  };

  // 先按原样解析（覆盖绝大多数产物）
  const exact = parseExact(base);
  if (exact !== null) return exact;

  // 再尝试剥掉同秒碰撞后缀（`-1`/`-2`…）后解析
  const withoutSuffix = base.replace(/-\d+$/, "");
  if (withoutSuffix !== base) return parseExact(withoutSuffix);

  return null;
}

/** prune 选项。 */
export interface PruneOptions {
  /** 保留最近 N 份。 */
  keep?: number;
  /** 删除早于 N 天的备份（语义对齐 `find -mtime +N`：需**超过** N×24 小时）。 */
  olderThanDays?: number;
  /** 判定「现在」的时刻（测试可注入）。 */
  now?: Date;
  /**
   * 是否允许删除 legacy 目录。
   *
   * 默认 **false**：旧格式承载存量数据，误删不可逆。用户在 issue 中
   * 明确要求「旧格式不被 prune 误删（除非显式指定）」。
   */
  includeLegacy?: boolean;
  /**
   * 无论如何都不删除的路径（2026-09-23 复审新增）。
   *
   * `backup create` 用它排除**刚创建的这一份**：`--retention-days 0` 的语义是
   * "不留旧快照"，而按 `ageDays > 0` 判定时刚产出的快照（ageDays≈0，但在时钟
   * 精度/时区边界下可能 >0）会被当场删除，只剩孤儿 `.sha256`。
   */
  excludePaths?: ReadonlySet<string>;
}

/** prune 计划（**不执行**删除；调用方在 --confirm 后才落地）。 */
export interface PrunePlan {
  keep: SnapshotEntry[];
  remove: SnapshotEntry[];
}

/** 解析时间，失败时回退到 epoch（排序靠后 = 视为最新，避免被误删）。 */
function timeOf(entry: SnapshotEntry): number {
  const t = Date.parse(entry.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 计算保留/删除计划。
 *
 * **默认 dry-run**：本函数只做计算，不做任何文件操作——issue 要求
 * prune 默认 dry-run、需 --confirm 才真删。
 *
 * 语义：
 * - `keep`：按时间倒序排列的全部遗产；前 N 个（若指定）保住；
 * - `remove`：**同时**满足「不在 keep 名单内」与「超过 olderThanDays」的项；
 *   若只给了 `olderThanDays`，则只按年龄过滤；若只给了 `keep`，则只按数量过滤。
 * - 两个条件都不给 → **不删任何东西**（安全默认，避免误删全部）。
 * - legacy 默认不删（见 {@link PruneOptions.includeLegacy}）。
 * - `excludePaths` 里的条目**永不删除**（见该字段说明）。
 */
export function planPrune(
  entries: SnapshotEntry[],
  options: PruneOptions = {},
): PrunePlan {
  // 时间倒序（最新在前）
  const sorted = [...entries].sort((a, b) => timeOf(b) - timeOf(a));

  const {
    keep,
    olderThanDays,
    now,
    includeLegacy = false,
    excludePaths,
  } = options;

  // 先按数量确定「数量上受保护」的集合
  const protectedByCount = keep === undefined
    ? new Set<string>()
    : new Set(sorted.slice(0, Math.max(0, keep)).map((e) => e.path));

  const nowMs = (now ?? new Date()).getTime();
  const hasAge = olderThanDays !== undefined;

  const result: PrunePlan = { keep: [], remove: [] };
  for (const entry of sorted) {
    // 无任何条件：全部保留（安全默认）
    if (keep === undefined && !hasAge) {
      result.keep.push(entry);
      continue;
    }
    // 显式排除（如"刚创建的这一份"）优先于一切删除条件
    if (excludePaths?.has(entry.path) === true) {
      result.keep.push(entry);
      continue;
    }
    if (protectedByCount.has(entry.path)) {
      result.keep.push(entry);
      continue;
    }
    if (entry.format === "legacy" && !includeLegacy) {
      result.keep.push(entry);
      continue;
    }
    // 数量条件已给出且未被保护 → 该删；
    // 若同时给了年龄条件，则还必须超龄（交集语义）。
    //
    // 年龄按**整天向下取整**比较，与 bash `find -mtime +N` 一致（2026-09-23 复审）：
    // `-mtime +0` 只匹配"满 24 小时以上"的条目，而浮点比较会让刚产出的快照
    // （ageDays≈1e-5 > 0）当场被删——`backup create --retention-days 0` 因此
    // 会删掉自己刚写出的备份，只剩孤儿 `.sha256`。
    if (hasAge) {
      const ageDays = Math.floor(
        (nowMs - timeOf(entry)) / (24 * 60 * 60 * 1000),
      );
      if (ageDays <= olderThanDays!) {
        result.keep.push(entry);
        continue;
      }
    }
    result.remove.push(entry);
  }
  return result;
}
