// Agent Note 格式校验脚本测试。
// 使用 Deno 内置测试，不依赖外部断言库。
import {
  verifyAgentNote,
  verifyAgentNotePath,
} from "./verify-agent-note-format.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

const VALID_NOTE = `# Agent Note: Agent Note 制度

Status: implemented

## Problem

缺少实现期决策记录。

## Decision

新增 .agents/notes/implemented 目录与格式约定。

## Alternatives considered

不引入独立 wiki；理由：决策应与代码同仓库。

## Consequences

非平凡 PR 需要附带 Agent Note。
`;

function withTempNote(
  relativePath: string,
  content: string,
  fn: (filePath: string) => void,
): void {
  const dir = Deno.makeTempDirSync({ prefix: "agent-note-test-" });
  try {
    const filePath = `${dir}/${relativePath}`;
    const parentDir = filePath.slice(0, filePath.lastIndexOf("/"));
    Deno.mkdirSync(parentDir, { recursive: true });
    Deno.writeTextFileSync(filePath, content);
    fn(filePath);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("合法 implemented note 通过路径与内容校验", () => {
  const rel = "implemented/process/2026-08-28-agent-note-system.md";
  withTempNote(rel, VALID_NOTE, (filePath) => {
    assert(
      verifyAgentNotePath(rel).length === 0,
      `路径校验应通过: ${verifyAgentNotePath(rel).join("; ")}`,
    );
    assert(
      verifyAgentNote(filePath).length === 0,
      `内容校验应通过: ${verifyAgentNote(filePath).join("; ")}`,
    );
  });
});

Deno.test("implemented 目录下 Status 必须是 implemented", () => {
  const rel = "implemented/process/2026-08-28-bad-status.md";
  const bad = VALID_NOTE.replace("Status: implemented", "Status: proposed");
  withTempNote(rel, bad, (filePath) => {
    const errors = verifyAgentNote(filePath);
    assert(errors.length > 0, "应当报错");
    assert(errors.some((e) => e.includes("Status")), "错误应提到 Status");
  });
});

Deno.test("缺少 Decision 章节报错", () => {
  const rel = "implemented/process/2026-08-28-missing-decision.md";
  const bad = VALID_NOTE.replace(
    "## Decision\n\n新增 .agents/notes/implemented 目录与格式约定。\n\n",
    "",
  );
  withTempNote(rel, bad, (filePath) => {
    const errors = verifyAgentNote(filePath);
    assert(errors.some((e) => e.includes("Decision")), "错误应提到 Decision");
  });
});

Deno.test("缺少 Alternatives considered 章节报错", () => {
  const rel = "implemented/process/2026-08-28-missing-alt.md";
  const bad = VALID_NOTE.replace(
    "## Alternatives considered\n\n不引入独立 wiki；理由：决策应与代码同仓库。\n\n",
    "",
  );
  withTempNote(rel, bad, (filePath) => {
    const errors = verifyAgentNote(filePath);
    assert(
      errors.some((e) => e.includes("Alternatives considered")),
      "错误应提到 Alternatives considered",
    );
  });
});

Deno.test("路径分类不在白名单时报错", () => {
  const rel = "implemented/foo/2026-08-28-bad-class.md";
  const errors = verifyAgentNotePath(rel);
  assert(errors.length > 0, "路径校验应报错");
  assert(errors.some((e) => e.includes("分类")), "错误应提到分类");
});
