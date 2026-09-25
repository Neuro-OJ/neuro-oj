/**
 * 题目包离线校验（#514）。
 *
 * 出题人在**本地**即可知道自己的 `problem.json` 能否通过导入校验，
 * 而不必等到服务端导入时才失败（P2）。同时执行 SHOULD 层质量规则（P3），
 * 这些规则**只告警不阻断**，`--strict` 时才计入退出码。
 *
 * ⚠️ 校验逻辑与 `noj-core/src/domains/catalog/types/problem-bundle.ts` 是
 * **刻意的两份实现**（issue #514 已确认的取舍）。两侧都对
 * `fixtures/problem-bundle-manifest.json` 断言，任一漂移即红灯。
 */
import { validateBundleManifest } from "./vendor/problem-bundle.ts";

/** 单条校验发现。 */
export interface LintFinding {
  /** error 影响退出码（除非 --strict 关闭）；warn 仅在 --strict 下影响。 */
  level: "error" | "warn";
  /** 机器可读的规则 id，便于 CI 断言与文档索引。 */
  rule: string;
  /** 人类可读说明。 */
  message: string;
  /** 相关文件（相对题目目录），无则为 null。 */
  file: string | null;
}

/** 题目包目录的文件快照。 */
export interface BundleFiles {
  /** 相对路径 → 文本内容（二进制文件不在其中）。 */
  texts: Record<string, string>;
  /** 全部条目名（含二进制）。 */
  names: string[];
}

/** 校验结果。 */
export interface LintReport {
  findings: LintFinding[];
  /** 是否存在 error 级发现。 */
  hasError: boolean;
  /** 是否存在 warn 级发现。 */
  hasWarn: boolean;
}

/** 质量规则触发的判定所需的最小信息。 */
export interface QualityContext {
  files: BundleFiles;
  manifest: Record<string, unknown>;
}

/**
 * SHOULD 层质量规则（P3）。
 *
 * 这些规则**不阻止导入**（与 quality.md 一致），但能提前暴露常见问题：
 * - 模板文件里出现看似完整的实现 → 出题人可能把参考答案写进了 template.py，
 *   选手可直接提交拿满分；
 * - 隐藏用例内容出现在可见文件里 → 泄题。
 */
export function runQualityRules(ctx: QualityContext): LintFinding[] {
  const findings: LintFinding[] = [];
  const { files, manifest } = ctx;

  // Q1：模板文件不得包含「可满分实现」的痕迹
  const templateName = typeof manifest.template === "string"
    ? manifest.template
    : "template.py";
  const template = files.texts[templateName];
  if (template !== undefined) {
    // 启发式：模板中出现完整函数体 + 返回语句，且未被注释占位
    const suspicious = /^\s*(def |class )/m.test(template) &&
      /^\s*return /m.test(template) &&
      !/TODO|pass\s*$|NotImplementedError|# 请在此实现|raise NotImplementedError/m
        .test(template);
    if (suspicious) {
      findings.push({
        level: "warn",
        rule: "quality/template-may-be-complete",
        message:
          `模板文件 ${templateName} 看起来包含完整实现（有 def 与 return，且无 TODO/占位）。` +
          "模板是选手的初始代码，若已可直接满分请移除实现。",
        file: templateName,
      });
    }
  }

  // Q2：隐藏用例内容不得出现在可见文件中
  const hiddenName = files.names.find((n) => n === "hidden.jsonl");
  if (hiddenName) {
    const hidden = files.texts[hiddenName] ?? "";
    const hiddenLines = hidden.split("\n").filter((l) => l.trim() !== "");
    for (const [name, content] of Object.entries(files.texts)) {
      if (name === hiddenName) continue;
      for (const line of hiddenLines) {
        // 只比对足够长的行，避免误报（如 "{}"）
        if (line.length < 16) continue;
        if (content.includes(line)) {
          findings.push({
            level: "warn",
            rule: "quality/hidden-case-leak",
            message: `隐藏用例的一行内容出现在可见文件 ${name} 中，可能泄题。`,
            file: name,
          });
          break;
        }
      }
    }
  }

  // Q3：README 未填写待办（脚手架默认内容）
  const readme = files.texts["README.md"];
  if (readme !== undefined && readme.includes("- [ ]")) {
    findings.push({
      level: "warn",
      rule: "quality/readme-todos",
      message: "README.md 仍有未完成的待办清单（- [ ]），确认题目已补齐。",
      file: "README.md",
    });
  }

  // Q4：已废弃字段 samples（2026-09-24 审计 A2-2）
  // 该字段从不落库、没有任何消费者。导入仍会容忍（兼容存量题包），
  // 但新增题包不应再写，题面样例请直接写进题面正文。
  if (manifest.samples !== undefined) {
    findings.push({
      level: "warn",
      rule: "quality/deprecated-samples",
      message:
        "manifest.samples 已废弃（从不落库，导入时被忽略）。题面样例请直接写进题面正文，删除该字段。",
      file: "problem.json",
    });
  }

  return findings;
}

/**
 * 执行完整校验：MUST（manifest 结构）+ SHOULD（质量规则）。
 *
 * MUST 失败以 error 呈现；后续质量规则仍会执行（给出尽可能完整的报告）。
 */
export function lintBundle(files: BundleFiles): LintReport {
  const findings: LintFinding[] = [];
  let manifest: Record<string, unknown> = {};

  const rawManifest = files.texts["problem.json"];
  if (rawManifest === undefined) {
    findings.push({
      level: "error",
      rule: "must/missing-manifest",
      message: "缺少 problem.json（统一题目包的根级清单）",
      file: "problem.json",
    });
  } else {
    try {
      manifest = JSON.parse(rawManifest) as Record<string, unknown>;
    } catch (err) {
      findings.push({
        level: "error",
        rule: "must/invalid-json",
        message: `problem.json 不是合法 JSON：${(err as Error).message}`,
        file: "problem.json",
      });
    }
  }

  if (Object.keys(manifest).length > 0 || rawManifest !== undefined) {
    try {
      validateBundleManifest(manifest);
    } catch (err) {
      findings.push({
        level: "error",
        rule: "must/manifest-invalid",
        message: (err as Error).message,
        file: "problem.json",
      });
    }
  }

  // 打包必需文件（非客观题要求 evaluate.py）
  if (manifest.is_objective !== true) {
    if (!files.names.includes("evaluate.py")) {
      findings.push({
        level: "error",
        rule: "must/missing-evaluator",
        message: "缺少 evaluate.py（编程题必须提供评测脚本）",
        file: "evaluate.py",
      });
    }
  } else if (!files.names.includes("questions.json")) {
    findings.push({
      level: "error",
      rule: "must/missing-questions",
      message: "客观题套卷缺少 questions.json",
      file: "questions.json",
    });
  }

  findings.push(...runQualityRules({ files, manifest }));

  return {
    findings,
    hasError: findings.some((f) => f.level === "error"),
    hasWarn: findings.some((f) => f.level === "warn"),
  };
}
