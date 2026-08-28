// 轻量 Git hooks 安装脚本。
// 不依赖 npm/lefthook 二进制，直接写入 .git/hooks/pre-commit 与 pre-push。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname ?? ".", "..");
const hooksDir = resolve(root, ".git", "hooks");

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
echo "本地 pre-push 不跑全量；CI 负责完整检查"
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
