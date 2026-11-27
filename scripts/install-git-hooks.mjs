// 轻量 Git hooks 安装脚本。
// 不依赖 npm/lefthook 二进制，直接写入 Git 公共 hooks 目录（.git/hooks 或 worktree 的公共目录）。
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname ?? ".", "..");

// 链接 worktree 里的 `.git` 是文件，hooks 在公共 git 目录下；直接拼 `.git/hooks`
// 会写错位置（在 worktree 里甚至不是目录）。交给 git 自己解析。
const hooksDir = resolve(
  root,
  execFileSync("git", ["-C", root, "rev-parse", "--git-path", "hooks"], {
    encoding: "utf8",
  }).trim(),
);

mkdirSync(hooksDir, { recursive: true });

const preCommit = `#!/bin/sh
set -e
FILES=$(git diff --cached --name-only --diff-filter=ACM -- '*.ts' '*.tsx' '*.vue' '*.rs')
if [ -n "$FILES" ]; then
  deno fmt --check $FILES
fi
git diff --cached --check
`;

const prePush = `#!/bin/sh
# 分支安全自检：git 通过 stdin 传入待推送引用（每行 local-ref local-sha remote-ref remote-sha），
# 检查器按 remote-sha..local-sha 逐条检查（新分支用 --not --remotes 求新增提交）。
# .git/hooks 由所有 worktree 共享：先探测当前检出分支有没有这个任务，旧分支没有
# check:branch-safety 时打印一行并放行，不能阻断无关推送。
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
if ! grep -q '"check:branch-safety"' deno.json 2>/dev/null; then
  echo "pre-push: 当前分支没有 check:branch-safety 任务，跳过分支安全自检" >&2
  exit 0
fi
# exec 保留 stdin 与退出码；检查器用 --pushed-refs - 读取待推送引用。
exec deno task check:branch-safety --pushed-refs -
`;

const preCommitPath = resolve(hooksDir, "pre-commit");
const prePushPath = resolve(hooksDir, "pre-push");

writeFileSync(preCommitPath, preCommit);
writeFileSync(prePushPath, prePush);
chmodSync(preCommitPath, 0o755);
chmodSync(prePushPath, 0o755);

console.log("Git hooks installed:");
console.log(`- ${preCommitPath}`);
console.log(`- ${prePushPath}`);
