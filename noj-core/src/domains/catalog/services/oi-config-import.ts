import { parseDocument } from "yaml";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  type OiRuntimeConfig,
  validateOiRuntimeConfig,
} from "../types/runtime-config.ts";

/** 有限大小题包配置使用安全 YAML 文档解析，拒绝重复键、标签和过量别名展开。 */
export function parseConfigYaml(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length > 1024 * 1024) {
    throw new BadRequestError("YAML 配置超过 1MiB");
  }
  try {
    const doc = parseDocument(new TextDecoder().decode(bytes), {
      uniqueKeys: true,
    });
    if (doc.errors.length || doc.warnings.length) throw new Error("非法 YAML");
    const value = doc.toJS({ maxAliasCount: 50 });
    return object(value);
  } catch {
    throw new BadRequestError("题包配置不是安全的 YAML 对象");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("配置必须是对象");
  }
  return value as Record<string, unknown>;
}
function resource(
  value: unknown,
  fallback: number,
  kind: "time" | "memory",
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new BadRequestError("资源值格式非法");
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|mb|mib|k|kb|kib|g|gb|gib)?$/i.exec(
    value.trim(),
  );
  if (!match) throw new BadRequestError("资源值格式非法");
  const unit = (match[2] ?? (kind === "time" ? "ms" : "m")).toLowerCase();
  const factor = kind === "time"
    ? ({ ms: 1, s: 1000 } as Record<string, number>)[unit]
    : ({
      m: 1,
      mb: 1,
      mib: 1,
      k: 1 / 1024,
      kb: 1 / 1024,
      kib: 1 / 1024,
      g: 1024,
      gb: 1024,
      gib: 1024,
    } as Record<string, number>)[unit];
  if (factor === undefined) throw new BadRequestError("资源单位非法");
  return Number(match[1]) * factor;
}
/** NOJ 的 OI YAML 配置填入批准的默认值，然后执行与 CRUD 相同的验证。 */
export function normalizeNojOiConfig(value: unknown): OiRuntimeConfig {
  const raw = object(value);
  const config = {
    backend: "native",
    languages: ["c", "cc"],
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    checker: { type: "default" },
    ...raw,
  };
  validateOiRuntimeConfig(config);
  return config;
}
/** 将 Hydro 的非交互配置转成统一 OI 子任务契约；不支持的语义明确拒绝。 */
export function normalizeHydroOiConfig(
  value: unknown,
  files: Record<string, Uint8Array>,
): OiRuntimeConfig {
  const raw = object(value);
  if (raw.type !== undefined && raw.type !== "default") {
    throw new BadRequestError("仅支持 Hydro 非交互 default 题型");
  }
  for (
    const key of [
      "interactor",
      "manager",
      "validator",
      "num_processes",
      "multi_pass",
      "time_rate",
      "memory_rate",
    ]
  ) {
    if (raw[key] !== undefined) {
      throw new BadRequestError(`不支持 Hydro 配置 ${key}`);
    }
  }
  const time = resource(raw.time, 1000, "time");
  const memory = resource(raw.memory, 256, "memory");
  const prefix = (v: unknown): string => {
    if (typeof v !== "string" || !v) {
      throw new BadRequestError("Hydro 文件引用必须是字符串");
    }
    return `testdata/${v}`;
  };
  let subtasks = raw.subtasks;
  if (subtasks === undefined) {
    const pairs = Object.keys(files).filter((p) =>
      p.startsWith("testdata/") && p.endsWith(".in")
    ).sort().map((p) => ({
      input: p.slice(9),
      output: `${p.slice(9, -3)}.out`,
    }));
    subtasks = [{ id: "all", score: 100, type: "sum", cases: pairs }];
  }
  if (!Array.isArray(subtasks) || !subtasks.length) {
    throw new BadRequestError("Hydro subtasks 不能为空");
  }
  const groups = subtasks.map(object);
  const ids = new Set(groups.map((g, i) => String(g.id ?? i + 1)));
  if (ids.size !== groups.length) {
    throw new BadRequestError("Hydro 子任务 id 重复");
  }
  const config: OiRuntimeConfig = {
    backend: "native",
    languages: ["c", "cc"],
    time_limit_ms: time,
    memory_limit_mb: memory,
    checker: {
      type:
        (raw.checker_type ?? "default") as OiRuntimeConfig["checker"]["type"],
    },
    subtasks: [],
  };
  if (raw.filename !== undefined) config.filename = raw.filename as string;
  if (raw.checker !== undefined) config.checker.path = prefix(raw.checker);
  for (const key of ["compile_extra_files", "user_extra_files"] as const) {
    if (raw[key] !== undefined) {
      if (!Array.isArray(raw[key])) {
        throw new BadRequestError(`${key} 必须是数组`);
      }
      config[key] = raw[key].map(prefix);
    }
  }
  for (const [index, group] of groups.entries()) {
    if (!Array.isArray(group.cases) || group.cases.length === 0) {
      throw new BadRequestError("Hydro cases 不能为空");
    }
    const id = String(group.id ?? index + 1);
    const scoring = group.type ?? "min";
    if (scoring !== "min" && scoring !== "sum") {
      throw new BadRequestError("Hydro 子任务仅支持 min/sum");
    }
    const score = group.score ?? (100 / groups.length);
    if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) {
      throw new BadRequestError("Hydro 分值非法");
    }
    const dependencies = group.if ?? group.depends_on ?? [];
    if (!Array.isArray(dependencies)) {
      throw new BadRequestError("Hydro 子任务依赖必须是数组");
    }
    if (scoring === "sum" && dependencies.length) {
      throw new BadRequestError("带依赖的 Hydro sum 子任务无法无损转换");
    }
    const cases = group.cases.map((entry) => {
      const c = object(entry);
      return {
        input: prefix(c.input),
        output: prefix(c.output),
        time_limit_ms: resource(
          c.time,
          resource(group.time, time, "time"),
          "time",
        ),
        memory_limit_mb: resource(
          c.memory,
          resource(group.memory, memory, "memory"),
          "memory",
        ),
      };
    });
    if (scoring === "sum") {
      for (const [caseIndex, c] of cases.entries()) {
        config.subtasks.push({
          id: `${id}_${caseIndex + 1}`,
          score: score / cases.length,
          cases: [c],
        });
      }
    } else {
      config.subtasks.push({
        id,
        score,
        depends_on: dependencies.map(String),
        cases,
      });
    }
  }
  validateOiRuntimeConfig(config);
  return config;
}
