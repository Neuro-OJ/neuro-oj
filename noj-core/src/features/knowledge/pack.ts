/**
 * 知识图谱内容包：加载与校验（纯函数，不访问数据库）。
 *
 * 内容包格式见 `data/knowledge-graph/` 与
 * openspec/changes/add-knowledge-graph/design.md 第 2 节：
 * - `pack.yaml`：`id`、`name`、`version`、`license`、`syllabi`（映射）、
 *   可选 `extends: <packId>@<version>`；
 * - `areas/<area>.yaml`：`area`、`name`、`nodes[]`（`id`、`name`、`summary`、
 *   `syllabus[]`、可选 `requires[]`、可选 `doc`）。
 *
 * 校验规则（失败信息为中文并指明节点）：
 * 1. 节点 ID 形如 `<领域>.<名称>`（小写字母、数字、连字符，点分隔），全包唯一；
 *    领域文件名必须等于 `area` 字段；领域非空；
 * 2. `name`、`summary` 必填；`syllabus` 非空且每项是 `syllabi` 的键（扩展包
 *    可用被扩展包的键）；
 * 3. `requires` 指向的节点必须存在（扩展包可引用被扩展包节点），不得自依赖，
 *    整体无环（环输出路径）；
 * 4. 扩展包：`extends` 只支持 `official@<version>`（P0），version 必须与当前官方
 *    包一致；扩展包节点/领域 ID 与被扩展包冲突即报错。
 */
import { dirname, join, resolve } from "jsr:@std/path@^1";
import { parse as parseYaml } from "jsr:@std/yaml@^1";

/** 单个知识点（已通过格式校验）。 */
export interface PackNode {
  id: string;
  area: string;
  name: string;
  summary: string;
  syllabus: string[];
  requires: string[];
  /** 讲解文档路径（内容包内相对路径，尚未校验存在性）。 */
  doc?: string;
}

/** 单个领域（对应 `areas/<area>.yaml`）。 */
export interface PackArea {
  id: string;
  name: string;
  /** 在内容包中的文件内顺序。 */
  sort: number;
  nodes: PackNode[];
}

/** 已加载的内容包。 */
export interface KnowledgePack {
  id: string;
  name: string;
  version: string;
  license: string;
  /** `extends: <packId>@<version>` 的包 ID；无扩展时为 null。 */
  extendsPackId: string | null;
  extendsVersion: string | null;
  syllabi: Record<string, string>;
  /** 领域按文件名排序。 */
  areas: PackArea[];
  /** 内容包根目录（绝对路径）。 */
  dir: string;
}

/** 校验上下文：基础包（被扩展包）。 */
export interface ValidatePackOptions {
  /** 被扩展的基础包；扩展包校验时传入。 */
  base?: KnowledgePack;
  /** 当前官方包版本，用于校验 `extends: official@<version>`。 */
  officialVersion?: string;
}

/** 节点 ID 格式：`<领域>.<名称>`，领域为小写字母/数字/连字符，名称为小写字母/数字/连字符。 */
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
/** 领域 ID 格式：小写字母开头，可含数字与连字符。 */
const AREA_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** 扩展只支持官方包（P0）。 */
const OFFICIAL_PACK_ID = "official";
/** 扩展引用格式：`<packId>@<version>`。 */
const EXTENDS_PATTERN = /^([a-z0-9][a-z0-9-]*)@(.+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item).trim());
}

/**
 * 从目录加载内容包（只解析，不做业务校验；用 {@link validatePack}）。
 *
 * 缺少 `pack.yaml`、无 `areas/*.yaml` 或 YAML 解析失败时抛错。
 */
export async function loadPackFromDir(dir: string): Promise<KnowledgePack> {
  const root = resolve(dir);
  const rawPack = parseYaml(await Deno.readTextFile(join(root, "pack.yaml")));
  if (!isRecord(rawPack)) {
    throw new Error(`内容包 ${root} 的 pack.yaml 不是对象`);
  }

  const syllabi: Record<string, string> = {};
  if (isRecord(rawPack.syllabi)) {
    for (const [key, value] of Object.entries(rawPack.syllabi)) {
      syllabi[key] = String(value ?? "");
    }
  }

  const extendsRaw = asString(rawPack.extends);
  const extendsMatch = extendsRaw ? EXTENDS_PATTERN.exec(extendsRaw) : null;

  const areaFiles: string[] = [];
  for await (const entry of Deno.readDir(join(root, "areas"))) {
    if (entry.isFile && entry.name.endsWith(".yaml")) {
      areaFiles.push(entry.name);
    }
  }
  areaFiles.sort();

  const areas: PackArea[] = [];
  for (const file of areaFiles) {
    const filePath = join(root, "areas", file);
    const rawArea = parseYaml(await Deno.readTextFile(filePath));
    if (!isRecord(rawArea)) throw new Error(`${filePath} 不是对象`);
    const rawNodes = Array.isArray(rawArea.nodes) ? rawArea.nodes : [];
    const areaId = asString(rawArea.area);
    const nodes: PackNode[] = rawNodes.map((item) => {
      const raw = isRecord(item) ? item : {};
      const id = asString(raw.id);
      const requires = asStringArray(raw.requires) ?? [];
      const doc = asString(raw.doc);
      return {
        id,
        // 节点所属领域以 ID 前缀为准，校验阶段再比对文件名与 `area` 字段。
        area: id.includes(".") ? id.slice(0, id.indexOf(".")) : areaId,
        name: asString(raw.name),
        summary: asString(raw.summary),
        syllabus: asStringArray(raw.syllabus) ?? [],
        requires,
        ...(doc ? { doc } : {}),
      };
    });
    areas.push({
      id: areaId,
      name: asString(rawArea.name),
      sort: areas.length,
      nodes,
    });
  }

  return {
    id: asString(rawPack.id),
    name: asString(rawPack.name),
    version: asString(rawPack.version),
    license: asString(rawPack.license),
    extendsPackId: extendsMatch ? extendsMatch[1]! : null,
    extendsVersion: extendsMatch ? extendsMatch[2]! : null,
    syllabi,
    areas,
    dir: root,
  };
}

/**
 * noj-core 目录（与 `scripts/noj.ts` 的 `PROJECT_ROOT` 语义一致：**noj-core 根，不是仓库根**）。
 *
 * - `NOJ_PROJECT_ROOT` 优先：生产镜像为 `/app`（其下直接是 `data/`、`drizzle/`）；
 * - 源码运行（开发、E2E 镜像 `/app/src/...`）：本文件在 `src/features/knowledge/`，上三级即 noj-core；
 * - `deno compile` 二进制且未设环境变量：可执行文件在 `<root>/bin/`，取其上一级。
 */
export function resolveProjectRoot(): string {
  const fromEnv = Deno.env.get("NOJ_PROJECT_ROOT");
  if (fromEnv) return resolve(fromEnv);
  const moduleDir = import.meta.dirname;
  if (
    moduleDir && !moduleDir.includes("$deno$") &&
    !moduleDir.startsWith("/deno-dir/")
  ) {
    return resolve(moduleDir, "../../..");
  }
  return resolve(dirname(Deno.execPath()), "..");
}

/** 官方内容包目录：`<noj-core 根>/data/knowledge-graph`（生产镜像即 `/app/data/knowledge-graph`）。 */
export function resolveOfficialPackDir(): string {
  return join(resolveProjectRoot(), "data", "knowledge-graph");
}

/**
 * 校验内容包；返回错误列表（空数组表示通过）。
 *
 * `options.base` 存在时按「扩展包」校验：节点/领域不得与基础包冲突，可引用
 * 基础包节点与考纲键。`options.officialVersion` 用于校验
 * `extends: official@<version>` 的版本。
 */
export function validatePack(
  pack: KnowledgePack,
  options: ValidatePackOptions = {},
): string[] {
  const errors: string[] = [];
  const base = options.base;
  const isExtension = base !== undefined;

  if (!pack.id) errors.push("pack.yaml 缺少 id");
  if (!pack.name) errors.push("pack.yaml 缺少 name");
  if (!pack.version) errors.push("pack.yaml 缺少 version");
  if (!pack.license) errors.push("pack.yaml 缺少 license");
  // 扩展包可只复用基础包的考纲键。
  if (!isExtension && Object.keys(pack.syllabi).length === 0) {
    errors.push("pack.yaml 的 syllabi 至少声明一个考纲键");
  }

  // ── 扩展声明 ──
  if (!isExtension) {
    if (pack.extendsPackId !== null) {
      errors.push(
        `pack.yaml 声明了 extends: ${pack.extendsPackId}@${pack.extendsVersion}，但校验时未提供被扩展包`,
      );
    }
  } else {
    if (pack.extendsPackId === null) {
      errors.push("扩展包缺少 extends: official@<version> 声明");
    } else {
      if (pack.extendsPackId !== OFFICIAL_PACK_ID) {
        errors.push(
          `扩展包只支持扩展官方包（extends: official@<version>），当前为 "${pack.extendsPackId}"`,
        );
      }
      if (
        pack.extendsVersion !== undefined && options.officialVersion &&
        pack.extendsVersion !== options.officialVersion
      ) {
        errors.push(
          `扩展包声明的 extends 版本 "${pack.extendsVersion}" 与官方包版本 "${options.officialVersion}" 不一致`,
        );
      }
    }
    if (pack.id === base.id) {
      errors.push(`扩展包 id "${pack.id}" 与被扩展包重复`);
    }
  }

  // 可用的考纲键：扩展包可复用基础包键。
  const syllabusKeys = new Set<string>(Object.keys(pack.syllabi));
  const areaIds = new Set<string>();
  const baseAreas = new Map<string, PackArea>();
  const baseNodes = new Map<string, PackNode>();
  for (const area of base?.areas ?? []) {
    baseAreas.set(area.id, area);
    for (const node of area.nodes) baseNodes.set(node.id, node);
  }
  for (const key of Object.keys(base?.syllabi ?? {})) syllabusKeys.add(key);

  // ── 领域 ──
  if (pack.areas.length === 0) {
    errors.push("内容包至少包含一个领域（areas/*.yaml）");
  }
  for (const area of pack.areas) {
    const label = `领域 "${area.id || "?"}"`;
    if (!area.id) {
      errors.push(`${label}：缺少 area 字段`);
    } else if (!AREA_ID_PATTERN.test(area.id)) {
      errors.push(
        `${label}：area 必须是小写字母开头，仅含小写字母、数字与连字符`,
      );
    } else {
      if (areaIds.has(area.id)) errors.push(`${label}：领域 ID 重复`);
      areaIds.add(area.id);
      if (isExtension && baseAreas.has(area.id)) {
        errors.push(`${label}：与被扩展包的领域 ID 冲突`);
      }
    }
    if (!area.name) errors.push(`${label}：缺少 name`);
    if (area.nodes.length === 0) errors.push(`${label}：领域内无知识点`);
  }

  // ── 节点 ──
  const nodeById = new Map<string, PackNode>();
  const allNodes: PackNode[] = [];
  const allLookup = new Map<string, PackNode | undefined>();
  for (const area of pack.areas) {
    for (const node of area.nodes) {
      const label = `知识点 "${node.id || "?"}"`;
      if (!node.id) {
        errors.push(`${label}：缺少 id`);
        continue;
      }
      if (!NODE_ID_PATTERN.test(node.id)) {
        errors.push(
          `${label}：ID 必须形如 <领域>.<名称>（小写字母、数字、连字符，点分隔）`,
        );
      }
      const prefix = node.id.includes(".")
        ? node.id.slice(0, node.id.indexOf("."))
        : "";
      if (prefix !== area.id) {
        errors.push(
          `${label}：ID 前缀 "${prefix}" 与所在领域 "${area.id}" 不一致（领域文件名必须等于 area 字段）`,
        );
      }
      if (nodeById.has(node.id) || baseNodes.has(node.id)) {
        errors.push(
          `${label}：ID 重复${
            baseNodes.has(node.id) ? "（与被扩展包节点冲突）" : ""
          }`,
        );
      }
      if (!node.name) errors.push(`${label}：缺少 name`);
      if (!node.summary) errors.push(`${label}：缺少 summary`);
      if (node.syllabus.length === 0) {
        errors.push(`${label}：syllabus 不能为空`);
      }
      for (const key of node.syllabus) {
        if (!syllabusKeys.has(key)) {
          errors.push(
            `${label}：考纲 "${key}" 未在 pack.yaml 的 syllabi 中声明`,
          );
        }
      }
      // 重复 ID 以首次出现者为准，但所有出现都参与后续前置检查，确保错误一次报全。
      allNodes.push(node);
      if (!nodeById.has(node.id)) {
        nodeById.set(node.id, node);
        allLookup.set(node.id, node);
      }
    }
  }
  for (const [id, node] of baseNodes) allLookup.set(id, node);

  // ── 前置关系 ──
  const adjacency = new Map<string, string[]>();
  for (const node of allNodes) {
    const label = `知识点 "${node.id}"`;
    const edges: string[] = [];
    const seen = new Set<string>();
    for (const dep of node.requires) {
      if (dep === node.id) {
        errors.push(`${label}：不能依赖自身`);
        continue;
      }
      if (seen.has(dep)) {
        errors.push(`${label}：requires 重复声明 "${dep}"`);
        continue;
      }
      seen.add(dep);
      if (!allLookup.has(dep)) {
        errors.push(`${label}：前置 "${dep}" 不存在`);
        continue;
      }
      edges.push(dep);
    }
    if (!adjacency.has(node.id)) adjacency.set(node.id, edges);
  }

  // 环检测（只在扩展包自身节点上找环；基础包已单独校验）。
  for (const cycle of findCycles(adjacency)) {
    errors.push(`检测到循环依赖：${cycle.join(" → ")}`);
  }

  return errors;
}

/** 在邻接表上找环，返回每条环的节点路径（首尾相同）。 */
function findCycles(adjacency: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const seenCycles = new Set<string>();

  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        // 规范化：从最小 ID 起头并固定方向，保证同一环只报告一次。
        const key = [...cycle.slice(0, -1)].sort().join("|");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
        }
      } else if (nextState === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of adjacency.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
  return cycles;
}

/** 讲解文档根目录：`<官方内容包目录>/docs`。 */
export function resolveDocsDir(): string {
  return join(resolveOfficialPackDir(), "docs");
}

/**
 * 读取节点讲解文档（markdown 原文）。
 *
 * `docPath` 来自内容包节点声明的 `doc`（相对路径，如 `docs/<node-id>.md`）。
 * 只允许相对路径且必须落在 docs 目录内（防目录穿越：逐段拒绝 `..` / 绝对路径，
 * 解析后再确认仍在根目录下）。文件不存在或越界返回 null。
 */
export async function readDocMarkdown(docPath: string | null): Promise<
  string | null
> {
  if (!docPath) return null;
  const relative = normalizePackRelativePath(docPath);
  if (!relative) return null;
  const root = resolve(resolveDocsDir());
  // 允许 `docs/<x>.md`（含 `docs/` 前缀）或直接 `<x>.md`：都相对 docs 目录解析。
  const target = resolve(root, relative.replace(/^docs\//, ""));
  if (target === root || !target.startsWith(`${root}${SEP}`)) return null;
  try {
    return await Deno.readTextFile(target);
  } catch {
    return null;
  }
}

/** 平台无关的分隔符（POSIX `/`；Windows 上额外拒绝 `\`）。 */
const SEP = "/";

/**
 * 规范化内容包内相对路径：拒绝绝对路径、反斜杠、NUL 与任一 `..` 段。
 *
 * @returns 合法时返回去掉前导 `./` 的相对路径，否则 null
 */
export function normalizePackRelativePath(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\")) return null;
  if (path.startsWith("/")) return null;
  const cleaned = path.replace(/^\.\//, "");
  const segments = cleaned.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return null;
  }
  return cleaned;
}
