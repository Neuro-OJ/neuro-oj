import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  ensureNojIgnore,
  inferEntryFile,
  initProblemWorkspace,
  readWorkspaceProblemConfig,
  writeWorkspaceProblemConfig,
} from "../workspace";

test("writeWorkspaceProblemConfig 与 readWorkspaceProblemConfig 往返读写一致", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-ws-cfg-"));
  try {
    await writeWorkspaceProblemConfig(dir, {
      serverUrl: "https://noj.example.com",
      domainSlug: "ai-lab",
      reference: "main:2001",
      versionId: "ver-9",
      version: 9,
      entryFile: "submission.py",
      submissionMode: "artifact",
      judgeType: "dual",
    });

    const loaded = await readWorkspaceProblemConfig(dir);
    assert.deepEqual(loaded, {
      serverUrl: "https://noj.example.com",
      domainSlug: "ai-lab",
      reference: "main:2001",
      versionId: "ver-9",
      version: 9,
      entryFile: "submission.py",
      submissionMode: "artifact",
      judgeType: "dual",
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("initProblemWorkspace 创建 .noj/problem.json、.nojignore 与入口模板且不覆盖非空代码", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-ws-init-"));
  try {
    const first = await initProblemWorkspace(
      dir,
      {
        serverUrl: "https://noj.example.com",
        domainSlug: "school",
        reference: "1001",
        versionId: "v1",
        version: 1,
        entryFile: inferEntryFile("code"),
        submissionMode: "code",
        judgeType: "dual",
      },
      "def solve():\n    return 42\n",
    );
    assert.equal(first.entryCreated, true);
    assert.equal(
      await fs.readFile(first.entryPath, "utf8"),
      "def solve():\n    return 42\n",
    );

    const ignoreContent = await fs.readFile(first.ignorePath, "utf8");
    assert.match(ignoreContent, /\.venv\//);
    assert.match(ignoreContent, /__pycache__\//);
    assert.match(ignoreContent, /\.noj\//);

    // 用户修改入口文件与 .nojignore 后再次初始化不覆盖
    await fs.writeFile(first.entryPath, "# custom solution\n", "utf8");
    await fs.writeFile(first.ignorePath, "custom_ignore/\n", "utf8");

    const second = await initProblemWorkspace(
      dir,
      {
        serverUrl: "https://noj.example.com",
        domainSlug: "school",
        reference: "1001",
        versionId: "v2",
        version: 2,
        entryFile: "submission.py",
        submissionMode: "code",
        judgeType: "dual",
      },
      "def solve():\n    return 99\n",
    );
    assert.equal(second.entryCreated, false);
    assert.equal(
      await fs.readFile(first.entryPath, "utf8"),
      "# custom solution\n",
    );
    assert.equal((await ensureNojIgnore(dir)).created, false);
    assert.equal(
      await fs.readFile(first.ignorePath, "utf8"),
      "custom_ignore/\n",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
