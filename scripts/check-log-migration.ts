/**
 * 日志迁移完整性静态校验。
 *
 * 背景：LogTape 的消息模板把 `{...}` 解析为占位符，且**失败是静默的**——
 * 实测 `log.info("集合 {a, b} 非法?", {})` 输出 `集合 null 非法?`，不报错。
 * 同理，残留的 JS 模板字符串（`` `${label}启动` ``）会把 `${` 当作 `$` +
 * 占位符消费。这类问题不会让任何测试变红，只能靠静态检查拦住。
 *
 * 校验规则（针对 `logger.*` 与 `getLogger(...)` 得到的 logger 调用）：
 * 1. message 不得是含插值的模板字符串（应改写为 `{key}` + 属性）；
 * 2. message 中的每个 `{key}` 占位符必须在同一调用的属性对象中有对应键；
 * 3. `{{` / `}}` 视为合法转义，不参与占位符解析。
 *
 * 用法：
 *   deno run -A scripts/check-log-migration.ts
 */

import ts from "npm:typescript@5.9.2";

/** 一个待校验的日志调用点。 */
export interface LogCallSite {
  file: string;
  /** 1-based 行号 */
  line: number;
  level: string;
  msgText: string;
  kind: "template" | "string" | "other";
  placeholders: string[];
  /** 属性对象的静态键；无法静态解析时为 null */
  propertyKeys: string[] | null;
}

/** 从模板原文解析占位符（`{{` 转义不参与）。 */
export function parsePlaceholders(text: string): string[] {
  const cleaned = text.replace(/\{\{/g, "").replace(/\}\}/g, "");
  return [...cleaned.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => m[1]!.trim())
    .filter((k) => k.length > 0);
}

/** 扫描一段源码中的日志调用点。 */
export function scanSource(text: string, file: string): LogCallSite[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const sites: LogCallSite[] = [];

  /** 收集本文件中被当作 logger 使用的标识符（如 `const log = getLogger([...])`）。 */
  const loggerAliases = new Set<string>(["logger"]);
  const collectAliases = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
      ts.isCallExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression) &&
      n.initializer.expression.text === "getLogger"
    ) {
      loggerAliases.add(n.name.text);
    }
    ts.forEachChild(n, collectAliases);
  };
  collectAliases(sf);

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["debug", "info", "warn", "error"].includes(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      const receiverName = ts.isIdentifier(receiver)
        ? receiver.text
        : receiver.getText(sf);
      if (loggerAliases.has(receiverName)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line +
          1;
        const msgArg = node.arguments[0];
        let kind: LogCallSite["kind"] = "other";
        let msgText = "";
        let placeholders: string[] = [];
        if (msgArg) {
          if (ts.isTemplateExpression(msgArg)) {
            kind = "template";
            msgText = msgArg.getText(sf);
          } else if (
            ts.isNoSubstitutionTemplateLiteral(msgArg) ||
            ts.isStringLiteral(msgArg)
          ) {
            kind = "string";
            msgText = msgArg.text;
            placeholders = parsePlaceholders(msgText);
          } else if (ts.isBinaryExpression(msgArg)) {
            // 字符串拼接：可能含模板插值
            const raw = msgArg.getText(sf);
            kind = raw.includes("${") ? "template" : "other";
            msgText = raw;
          } else {
            kind = "other";
            msgText = msgArg.getText(sf);
          }
        }
        // 属性对象键
        let propertyKeys: string[] | null = null;
        const propsArg = node.arguments[1];
        if (propsArg && ts.isObjectLiteralExpression(propsArg)) {
          propertyKeys = [];
          for (const p of propsArg.properties) {
            if (ts.isShorthandPropertyAssignment(p)) {
              propertyKeys.push(p.name.text);
            } else if (ts.isPropertyAssignment(p)) {
              const nm = p.name;
              if (ts.isIdentifier(nm) || ts.isStringLiteral(nm)) {
                propertyKeys.push(nm.text);
              }
            }
          }
        }
        sites.push({
          file,
          line,
          level: node.expression.name.text,
          msgText,
          kind,
          placeholders,
          propertyKeys,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** 判定违规。 */
export function findViolations(
  sites: LogCallSite[],
): { file: string; line: number; message: string }[] {
  const out: { file: string; line: number; message: string }[] = [];
  for (const s of sites) {
    if (s.kind === "template") {
      out.push({
        file: s.file,
        line: s.line,
        message:
          `message 是 JS 模板字符串（含 \${}），LogTape 会把 \${ 当作占位符静默消费。` +
          `请改写为 "{key} 文本" + 属性对象。实际: ${s.msgText.slice(0, 80)}`,
      });
      continue;
    }
    if (s.kind === "string" && s.placeholders.length > 0) {
      if (s.propertyKeys === null) continue; // 属性非字面量对象，无法静态判定
      const missing = s.placeholders.filter((p) =>
        !s.propertyKeys!.includes(p)
      );
      if (missing.length > 0) {
        out.push({
          file: s.file,
          line: s.line,
          message: `占位符 ${
            missing.map((m) => `{${m}}`).join(", ")
          } 在属性对象中无对应键，` +
            `渲染结果为 null。属性键: [${s.propertyKeys.join(", ")}]`,
        });
      }
    }
  }
  return out;
}

/** 递归收集 .ts 文件（跳过 node_modules 与构建产物）。 */
async function collect(dir: string, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (
        [
          "node_modules",
          ".git",
          ".output",
          ".deno",
          "dist",
          "coverage",
          "drizzle",
        ].includes(e.name)
      ) {
        continue;
      }
      await collect(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) {
      out.push(full);
    }
  }
  return out;
}

if (import.meta.main) {
  const roots = ["noj-core/src", "noj-llm-gateway/src"];
  const all: LogCallSite[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await collect(root);
    } catch {
      continue; // 目录不存在（可选模块）时跳过
    }
    for (const f of files) {
      all.push(...scanSource(await Deno.readTextFile(f), f));
    }
  }
  // 防「从错误目录运行 → 扫描 0 个文件 → 报通过」的静默失效：
  // 本脚本的 roots 相对仓库根，在 noj-core/ 下运行会找不到任何文件。
  // 这正是本工具要拦的那类问题（不报错、显示绿色），因此必须显式拒绝。
  if (all.length === 0) {
    console.error(
      "[check-log-migration] 未扫描到任何日志调用点——请在**仓库根目录**运行本脚本" +
        `（当前 CWD: ${Deno.cwd()}，期望存在的根目录: ${roots.join(", ")}）`,
    );
    Deno.exit(1);
  }
  const violations = findViolations(all);
  if (violations.length === 0) {
    console.log(
      `[check-log-migration] 通过：扫描 ${all.length} 个日志调用点，无模板语法问题`,
    );
    Deno.exit(0);
  }
  console.error(`[check-log-migration] 发现 ${violations.length} 个问题：\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`      ${v.message}\n`);
  }
  Deno.exit(1);
}
