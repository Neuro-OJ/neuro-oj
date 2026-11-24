import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { NeuroOjApi, type HttpRequest } from "../api";
import {
  buildCustomSelfTestCases,
  type DirtyDocumentLike,
  DUAL_SUPPORT_PACKAGE_REQUIRED_MESSAGE,
  getUnsupportedCloudSelfTestMessage,
  isSupportedPredictionFile,
  launchTrackAWithSupportPackage,
  OI_SUPPORT_PACKAGE_REQUIRED_MESSAGE,
  OI_TRACK_A_CONFIG_REQUIRED_MESSAGE,
  preparePythonMockDocuments,
  resolveEffectiveWorkspaceRoot,
  resolvePredictionFile,
  resolveSubmissionTransportMode,
  resolveSupportPackagePath,
  resolveTargetWithWorkspace,
  saveDirtyDocumentsInWorkspace,
  saveDocumentIfDirty,
  supportsCloudSelfTest,
  supportsCustomSelfTestCases,
} from "../submissionHelpers";
import {
  initProblemWorkspace,
  isMatchingWorkspaceServer,
  readWorkspaceProblemConfig,
  syncWorkspaceProblemVersion,
  writeWorkspaceProblemConfig,
} from "../workspace";
import { packWorkspaceZip } from "../zipBuilder";

test("resolveSubmissionTransportMode 仅允许 artifact 模式走 ZIP 提交", () => {
  assert.equal(resolveSubmissionTransportMode("code"), "code");
  assert.equal(resolveSubmissionTransportMode("artifact"), "zip");
  assert.equal(resolveSubmissionTransportMode("prediction"), "prediction");
});

test("isSupportedPredictionFile 校验预测数据文件扩展名并拒绝代码与 pickle", () => {
  for (const name of [
    "predictions.csv",
    "out.tsv",
    "preds.jsonl",
    "result.json",
    "ans.txt",
    "tensor.npy",
    "bundle.npz",
    "table.parquet",
  ]) {
    assert.equal(isSupportedPredictionFile(name), true, name);
  }
  for (const name of ["submission.py", "model.pkl", "bundle.zip", "a.pt"]) {
    assert.equal(isSupportedPredictionFile(name), false, name);
  }
});

test("saveDirtyDocumentsInWorkspace 打包前保存工作区内全部脏文档并在取消或失败时中止", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noj-dirty-ws-"));
  const insideA = path.join(root, "submission.py");
  const insideB = path.join(root, "src", "helper.py");
  const outside = path.join(os.tmpdir(), "outside-dirty.py");
  const savedLog: string[] = [];

  try {
    const docs: DirtyDocumentLike[] = [
      {
        fileName: insideA,
        fsPath: insideA,
        scheme: "file",
        isDirty: true,
        save: async () => {
          savedLog.push("insideA");
          return true;
        },
      },
      {
        fileName: insideB,
        fsPath: insideB,
        scheme: "file",
        isDirty: true,
        save: async () => {
          savedLog.push("insideB");
          return true;
        },
      },
      {
        fileName: outside,
        fsPath: outside,
        scheme: "file",
        isDirty: true,
        save: async () => {
          savedLog.push("outside");
          return true;
        },
      },
      {
        fileName: "Untitled-1",
        fsPath: "Untitled-1",
        scheme: "untitled",
        isDirty: true,
        save: async () => {
          savedLog.push("untitled");
          return true;
        },
      },
    ];

    const okRes = await saveDirtyDocumentsInWorkspace(root, docs);
    assert.deepEqual(okRes, { ok: true, savedCount: 2 });
    assert.deepEqual(savedLog, ["insideA", "insideB"]);

    const failRes = await saveDirtyDocumentsInWorkspace(root, [
      docs[0],
      {
        fileName: insideB,
        fsPath: insideB,
        scheme: "file",
        isDirty: true,
        save: async () => false,
      },
    ]);
    assert.deepEqual(failRes, { ok: false, failedFile: insideB });

    const throwRes = await saveDirtyDocumentsInWorkspace(root, [
      {
        fileName: insideA,
        fsPath: insideA,
        scheme: "file",
        isDirty: true,
        save: async () => {
          throw new Error("disk full");
        },
      },
    ]);
    assert.deepEqual(throwRes, {
      ok: false,
      failedFile: insideA,
      reason: "disk full",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("prediction 模式解析配置入口、保存脏文件并按原文件名通过 multipart 上传", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noj-pred-flow-"));
  try {
    const csvPath = path.join(root, "predictions.csv");
    await fs.writeFile(csvPath, "id,pred\n1,0.1\n", "utf8");

    // 1) 配置入口文件（例如 predictions.csv / .jsonl / .npy）优先解析
    const resolvedCsv = await resolvePredictionFile({
      workspaceRoot: root,
      configuredEntryFile: "predictions.csv",
      activeFilePath: path.join(root, "train.py"),
    });
    assert.equal(resolvedCsv, csvPath);

    // 2) 若在编辑器打开且脏，先保存再读取上传
    const docs: DirtyDocumentLike[] = [
      {
        fileName: csvPath,
        fsPath: csvPath,
        scheme: "file",
        isDirty: true,
        save: async () => {
          await fs.writeFile(csvPath, "id,pred\n1,0.95\n", "utf8");
          return true;
        },
      },
    ];
    const saveResult = await saveDocumentIfDirty(resolvedCsv!, docs);
    assert.deepEqual(saveResult, { ok: true, saved: true });

    const requests: HttpRequest[] = [];
    const api = new NeuroOjApi("https://noj.example.com", 5000, async (req) => {
      requests.push(req);
      return {
        status: 201,
        headers: {},
        body: JSON.stringify({ data: { id: "pred-1", status: "pending" } }),
      };
    });
    api.setToken("jwt-token");
    const fileBuffer = await fs.readFile(resolvedCsv!);
    await api.submitDomainPrediction(
      "ai-lab",
      "main:3001",
      fileBuffer,
      path.basename(resolvedCsv!),
      "ver-5",
    );

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url.pathname,
      "/api/v1/domains/ai-lab/submissions",
    );
    const bodyText = Buffer.isBuffer(requests[0].body)
      ? requests[0].body.toString("utf8")
      : String(requests[0].body ?? "");
    assert.match(bodyText, /name="file"; filename="predictions\.csv"/);
    assert.match(bodyText, /id,pred\n1,0\.95/);
    assert.doesNotMatch(bodyText, /"language":"python3"/);

    // 3) 保存取消时中止提交
    const cancelSave = await saveDocumentIfDirty(csvPath, [
      {
        fileName: csvPath,
        fsPath: csvPath,
        scheme: "file",
        isDirty: true,
        save: async () => false,
      },
    ]);
    assert.deepEqual(cancelSave, { ok: false, failedFile: csvPath });

    // 4) 无配置入口时支持用户选择单个 .npy / .jsonl 数据文件
    const npyPath = path.join(root, "output.npy");
    await fs.writeFile(npyPath, Buffer.from("\x93NUMPYdummy"));
    const resolvedNpy = await resolvePredictionFile({
      workspaceRoot: root,
      configuredEntryFile: "missing.csv",
      workspacePredictionFiles: async () => [csvPath, npyPath],
      pickFromList: async () => npyPath,
    });
    assert.equal(resolvedNpy, npyPath);

    const browsedJsonl = path.join(root, "manual.jsonl");
    const resolvedBrowsed = await resolvePredictionFile({
      workspaceRoot: root,
      configuredEntryFile: "missing.csv",
      workspacePredictionFiles: async () => [],
      browseSingleFile: async () => browsedJsonl,
    });
    assert.equal(resolvedBrowsed, browsedJsonl);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("显式重新选题更新 SelectedProblem.versionId 后覆盖过期 .noj/problem.json 版本", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noj-ver-sync-"));
  try {
    await writeWorkspaceProblemConfig(root, {
      serverUrl: "https://noj.example.com",
      domainSlug: "school",
      reference: "main:1001",
      versionId: "v1-stale",
      version: 1,
      entryFile: "submission.py",
      submissionMode: "code",
      judgeType: "dual",
    });

    // 场景 A：409 后用户在侧栏重新 selectProblem，SelectedProblem 已更新为 v2-fresh
    const resolved = await resolveTargetWithWorkspace({
      workspaceRoot: root,
      serverUrl: "https://noj.example.com",
      selectedProblem: {
        domainSlug: "school",
        reference: "main:1001",
        id: "main:1001",
        displayId: "main:1001",
        title: "更新后的题目",
        versionId: "v2-fresh",
        version: 2,
        submissionMode: "artifact",
        judgeType: "dual",
      },
      selectProblem: async () => undefined,
      readWorkspaceConfig: readWorkspaceProblemConfig,
      writeWorkspaceConfig: writeWorkspaceProblemConfig,
    });

    assert.equal(resolved?.versionId, "v2-fresh");
    assert.equal(resolved?.version, 2);
    assert.equal(resolved?.submissionMode, "artifact");
    const persisted = await readWorkspaceProblemConfig(root);
    assert.equal(persisted?.versionId, "v2-fresh");
    assert.equal(persisted?.version, 2);
    assert.equal(persisted?.submissionMode, "artifact");

    // 场景 B：通过 syncWorkspaceProblemVersion 直接同步重新选题结果
    const synced = await syncWorkspaceProblemVersion(
      root,
      {
        domainSlug: "school",
        reference: "main:1001",
        id: "main:1001",
        displayId: "main:1001",
        title: "更新后的题目",
        versionId: "v3-newest",
        version: 3,
        submissionMode: "prediction",
        judgeType: "dual",
      },
      "https://noj.example.com",
    );
    assert.equal(synced?.versionId, "v3-newest");
    assert.equal(synced?.entryFile, "predictions.csv");
    assert.equal(
      (await readWorkspaceProblemConfig(root))?.versionId,
      "v3-newest",
    );

    // 场景 C：不同题目不会误覆盖当前工作区的 .noj/problem.json
    await syncWorkspaceProblemVersion(root, {
      domainSlug: "school",
      reference: "main:9999",
      id: "main:9999",
      displayId: "main:9999",
      title: "其他题目",
      versionId: "other-v1",
      version: 1,
      submissionMode: "code",
      judgeType: "dual",
    });
    assert.equal(
      (await readWorkspaceProblemConfig(root))?.reference,
      "main:1001",
    );
    assert.equal(
      (await readWorkspaceProblemConfig(root))?.versionId,
      "v3-newest",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildCustomSelfTestCases 为自定义自测用例生成唯一合法 id", () => {
  const cases = buildCustomSelfTestCases(["1 2\n", "3 4\n"]);
  assert.deepEqual(cases, [
    { id: "custom-1", input: "1 2\n" },
    { id: "custom-2", input: "3 4\n" },
  ]);
  const ids = new Set(cases.map((c) => c.id));
  assert.equal(ids.size, cases.length);
  for (const item of cases) {
    assert.match(item.id, /^[A-Za-z0-9_-]{1,100}$/);
  }
});

test("preparePythonMockDocuments 在轨道 B 启动前保存脏文档并拦截未命名或取消保存路径", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noj-trackb-prep-"));
  const entryPath = path.join(root, "submission.py");
  const helperPath = path.join(root, "helper.py");
  try {
    // 1) 未命名 untitled 文档直接中止
    const untitledRes = await preparePythonMockDocuments(
      {
        fileName: "Untitled-1",
        fsPath: "Untitled-1",
        scheme: "untitled",
        isDirty: true,
        isUntitled: true,
        save: async () => true,
      },
      root,
      [],
    );
    assert.deepEqual(untitledRes, {
      ok: false,
      reason: "untitled",
      fileName: "Untitled-1",
    });

    // 2) 入口文档或工作区文件取消保存（save 返回 false）中止运行
    const cancelEntryRes = await preparePythonMockDocuments(
      {
        fileName: entryPath,
        fsPath: entryPath,
        scheme: "file",
        isDirty: true,
        isUntitled: false,
        save: async () => false,
      },
      root,
      [],
    );
    assert.deepEqual(cancelEntryRes, {
      ok: false,
      reason: "save_failed",
      fileName: entryPath,
    });

    // 3) 入口文档保存成功，但工作区辅助文件保存异常时中止
    const throwWsRes = await preparePythonMockDocuments(
      {
        fileName: entryPath,
        fsPath: entryPath,
        scheme: "file",
        isDirty: false,
        isUntitled: false,
        save: async () => true,
      },
      root,
      [
        {
          fileName: helperPath,
          fsPath: helperPath,
          scheme: "file",
          isDirty: true,
          save: async () => {
            throw new Error("permission denied");
          },
        },
      ],
    );
    assert.deepEqual(throwWsRes, {
      ok: false,
      reason: "save_failed",
      fileName: helperPath,
      detail: "permission denied",
    });

    // 4) 入口文档和工作区脏文件均先保存落盘后再运行
    const savedOrder: string[] = [];
    const entryDoc: DirtyDocumentLike = {
      fileName: entryPath,
      fsPath: entryPath,
      scheme: "file",
      isDirty: true,
      isUntitled: false,
      save: async () => {
        savedOrder.push("entry");
        return true;
      },
    };
    const helperDoc: DirtyDocumentLike = {
      fileName: helperPath,
      fsPath: helperPath,
      scheme: "file",
      isDirty: true,
      save: async () => {
        savedOrder.push("helper");
        return true;
      },
    };
    const okRes = await preparePythonMockDocuments(entryDoc, root, [
      entryDoc,
      helperDoc,
    ]);
    assert.deepEqual(okRes, { ok: true, savedCount: 2 });
    assert.deepEqual(savedOrder, ["entry", "helper"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveSupportPackagePath 支持配置路径、默认路径与交互选择，取消时中止而不启动 Track A", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noj-support-pkg-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "noj-support-ext-"));
  try {
    // 1) 配置路径解析（相对工作区 + 绝对路径）；有效时不会弹出选择框
    const relZip = path.join(root, "assets", "custom-support.zip");
    await fs.mkdir(path.dirname(relZip), { recursive: true });
    await fs.writeFile(relZip, Buffer.from("PK\x05\x06" + "\0".repeat(18)));
    let pickerCalls = 0;
    const fromRelative = await resolveSupportPackagePath({
      workspaceRoot: root,
      configuredPath: "assets/custom-support.zip",
      pickSupportPackage: async () => {
        pickerCalls++;
        return undefined;
      },
    });
    assert.equal(fromRelative, relZip);
    assert.equal(pickerCalls, 0);

    const absZip = path.join(outside, "abs-support.zip");
    await fs.writeFile(absZip, Buffer.from("PK\x05\x06" + "\0".repeat(18)));
    const fromAbsolute = await resolveSupportPackagePath({
      workspaceRoot: root,
      configuredPath: absZip,
      pickSupportPackage: async () => {
        pickerCalls++;
        return undefined;
      },
    });
    assert.equal(fromAbsolute, absZip);
    assert.equal(pickerCalls, 0);

    // 非法或不存在的配置路径不放行
    const invalidConfigured = await resolveSupportPackagePath({
      workspaceRoot: root,
      configuredPath: "assets/not-a-zip.txt",
    });
    assert.equal(invalidConfigured, undefined);

    // 2) 未配置时自动探测工作区内 .noj/support-package.zip
    const defaultZip = path.join(root, ".noj", "support-package.zip");
    await fs.mkdir(path.dirname(defaultZip), { recursive: true });
    await fs.writeFile(defaultZip, Buffer.from("PK\x05\x06" + "\0".repeat(18)));
    const fromDefault = await resolveSupportPackagePath({
      workspaceRoot: root,
      pickSupportPackage: async () => {
        pickerCalls++;
        return undefined;
      },
    });
    assert.equal(fromDefault, defaultZip);
    assert.equal(pickerCalls, 0);

    // 3) 无配置且无默认路径时向用户请求选择
    await fs.rm(defaultZip);
    const fromPicker = await resolveSupportPackagePath({
      workspaceRoot: root,
      pickSupportPackage: async () => {
        pickerCalls++;
        return absZip;
      },
    });
    assert.equal(fromPicker, absZip);
    assert.equal(pickerCalls, 1);

    // 选择非 .zip 或不存在文件仍被拒绝
    const notZipFile = path.join(outside, "readme.txt");
    await fs.writeFile(notZipFile, "hello", "utf8");
    const rejectedNonZip = await resolveSupportPackagePath({
      workspaceRoot: root,
      pickSupportPackage: async () => notZipFile,
    });
    assert.equal(rejectedNonZip, undefined);

    // 4) 用户取消选择时中止，绝不调用 runLocalJudgeTrack / launch
    let launched = false;
    let warning = "";
    const ok = await launchTrackAWithSupportPackage({
      workspaceRoot: root,
      judgeType: "dual",
      pickSupportPackage: async () => undefined,
      onMissingSupportPackage: (msg) => {
        warning = msg;
      },
      launch: async () => {
        launched = true;
      },
    });
    assert.equal(ok, false);
    assert.equal(launched, false);
    assert.equal(warning, DUAL_SUPPORT_PACKAGE_REQUIRED_MESSAGE);

    // 提供有效支持包后正常进入 launch 并透传路径
    let passedPath: string | undefined;
    const launchedOk = await launchTrackAWithSupportPackage({
      workspaceRoot: root,
      judgeType: "dual",
      pickSupportPackage: async () => absZip,
      launch: async (pkgPath) => {
        launched = true;
        passedPath = pkgPath;
      },
    });
    assert.equal(launchedOk, true);
    assert.equal(launched, true);
    assert.equal(passedPath, absZip);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("supportsCustomSelfTestCases 仅对 oi 题型启用自定义自测输入", () => {
  assert.equal(supportsCustomSelfTestCases("oi"), true);
  assert.equal(supportsCustomSelfTestCases("dual"), false);
  assert.equal(supportsCustomSelfTestCases("ai"), false);
  assert.equal(supportsCustomSelfTestCases(undefined), false);
});

test("工作区在目录 A、初始化在目录 B 后，后续读取与提交解析到的目录为 B", async () => {
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "noj-ws-a-"));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "noj-ws-b-"));
  try {
    // 目录 A 为默认工作区（包含无关文件与不同题目的旧绑定）
    const fileA = path.join(dirA, "unrelated.py");
    await fs.writeFile(fileA, "print('from dir A')\n", "utf8");
    await writeWorkspaceProblemConfig(dirA, {
      serverUrl: "https://noj.example.com",
      domainSlug: "school",
      reference: "main:0001",
      versionId: "v0",
      version: 0,
      entryFile: "unrelated.py",
      submissionMode: "code",
      judgeType: "dual",
    });

    // 用户通过 initWorkspace 将 main:2002 初始化到目录 B
    await initProblemWorkspace(
      dirB,
      {
        serverUrl: "https://noj.example.com",
        domainSlug: "school",
        reference: "main:2002",
        versionId: "v1",
        version: 1,
        entryFile: "submission.py",
        submissionMode: "artifact",
        judgeType: "dual",
        supportPackagePath: ".noj/custom-pkg.zip",
      },
      "print('from dir B')\n",
    );
    const helperB = path.join(dirB, "helper.py");
    await fs.writeFile(helperB, "VALUE = 42\n", "utf8");

    const selected = {
      domainSlug: "school",
      reference: "main:2002",
      id: "main:2002",
      displayId: "main:2002",
      title: "多文件目录 B 题目",
      versionId: "v2",
      version: 2,
      submissionMode: "artifact" as const,
      judgeType: "dual" as const,
    };

    const resolved = await resolveTargetWithWorkspace({
      workspaceRoot: dirA,
      candidateWorkspaceRoots: [dirB],
      getRememberedWorkspaceRoot: (slug, ref) =>
        slug === "school" && ref === "main:2002" ? dirB : undefined,
      selectedProblem: selected,
      serverUrl: "https://noj.example.com",
      selectProblem: async () => undefined,
      readWorkspaceConfig: readWorkspaceProblemConfig,
      writeWorkspaceConfig: writeWorkspaceProblemConfig,
    });

    assert.equal(resolved?.workspaceRoot, dirB);
    assert.equal(resolved?.versionId, "v2");
    assert.equal(resolved?.submissionMode, "artifact");
    // 目录 B 配置已同步更新且保留 supportPackagePath；目录 A 配置未被触动
    const cfgB = await readWorkspaceProblemConfig(dirB);
    assert.equal(cfgB?.versionId, "v2");
    assert.equal(cfgB?.supportPackagePath, ".noj/custom-pkg.zip");
    assert.equal(
      (await readWorkspaceProblemConfig(dirA))?.reference,
      "main:0001",
    );

    // runLocalMock 侧工作区解析同样落到目录 B
    const effective = await resolveEffectiveWorkspaceRoot({
      workspaceRoot: dirA,
      candidateWorkspaceRoots: [dirB],
      selectedProblem: selected,
      readWorkspaceConfig: readWorkspaceProblemConfig,
    });
    assert.equal(effective.workspaceRoot, dirB);
    assert.equal(effective.wsConfig?.reference, "main:2002");

    // 后续 saveDirtyDocumentsInWorkspace 与 packWorkspaceZip 仅针对目录 B，不会误提交目录 A 的文件
    const savedPaths: string[] = [];
    const saveRes = await saveDirtyDocumentsInWorkspace(
      resolved!.workspaceRoot!,
      [
        {
          fileName: fileA,
          fsPath: fileA,
          scheme: "file",
          isDirty: true,
          save: async () => {
            savedPaths.push(fileA);
            return true;
          },
        },
        {
          fileName: helperB,
          fsPath: helperB,
          scheme: "file",
          isDirty: true,
          save: async () => {
            savedPaths.push(helperB);
            return true;
          },
        },
      ],
    );
    assert.deepEqual(saveRes, { ok: true, savedCount: 1 });
    assert.deepEqual(savedPaths, [helperB]);

    const zip = await packWorkspaceZip(resolved!.workspaceRoot!);
    assert.ok(zip.files.includes("submission.py"));
    assert.ok(zip.files.includes("helper.py"));
    assert.equal(zip.files.includes("unrelated.py"), false);
  } finally {
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  }
});

test("launchTrackAWithSupportPackage 对 OI 题目校验完整 runtime_config 与支持包 .zip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-oi-launch-"));
  const zipPath = path.join(dir, "oi.zip");
  try {
    await fs.writeFile(zipPath, Buffer.from("PK\x05\x06" + "\0".repeat(18)));

    // 1) 缺少完整 runtime_config 时直接拦截，不弹出支持包选择，也不调用 launch
    let pickerCalls = 0;
    let launched = false;
    let oiWarning = "";
    const missingRcOk = await launchTrackAWithSupportPackage({
      workspaceRoot: dir,
      judgeType: "oi",
      pickSupportPackage: async () => {
        pickerCalls++;
        return zipPath;
      },
      onMissingOiRuntimeConfig: (msg) => {
        oiWarning = msg;
      },
      launch: async () => {
        launched = true;
      },
    });
    assert.equal(missingRcOk, false);
    assert.equal(pickerCalls, 0);
    assert.equal(launched, false);
    assert.equal(oiWarning, OI_TRACK_A_CONFIG_REQUIRED_MESSAGE);

    const validRc: Record<string, unknown> = {
      backend: "native",
      languages: ["cc"],
      time_limit_ms: 1000,
      memory_limit_mb: 256,
      checker: { type: "default" },
      subtasks: [
        { id: "s1", score: 100, cases: [{ input: "1.in", output: "1.out" }] },
      ],
    };

    // 2) runtime_config 完整但缺少支持包时提示用户并中止
    let pkgWarning = "";
    const missingPkgOk = await launchTrackAWithSupportPackage({
      workspaceRoot: dir,
      judgeType: "oi",
      runtimeConfig: validRc,
      pickSupportPackage: async () => undefined,
      onMissingSupportPackage: (msg) => {
        pkgWarning = msg;
      },
      launch: async () => {
        launched = true;
      },
    });
    assert.equal(missingPkgOk, false);
    assert.equal(launched, false);
    assert.equal(pkgWarning, OI_SUPPORT_PACKAGE_REQUIRED_MESSAGE);

    // 3) runtime_config 完整且提供支持包 .zip 时放行
    let passedPkg: string | undefined;
    const ok = await launchTrackAWithSupportPackage({
      workspaceRoot: dir,
      judgeType: "oi",
      runtimeConfig: validRc,
      pickSupportPackage: async () => zipPath,
      launch: async (pkg) => {
        launched = true;
        passedPkg = pkg;
      },
    });
    assert.equal(ok, true);
    assert.equal(launched, true);
    assert.equal(passedPkg, zipPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("supportsCloudSelfTest 与 getUnsupportedCloudSelfTestMessage 仅允许 code 模式走云端自测", () => {
  assert.equal(supportsCloudSelfTest("code"), true);
  assert.equal(supportsCloudSelfTest(undefined), true);
  assert.equal(getUnsupportedCloudSelfTestMessage("code"), undefined);

  assert.equal(supportsCloudSelfTest("artifact"), false);
  assert.match(
    getUnsupportedCloudSelfTestMessage("artifact") ?? "",
    /artifact|多文件/,
  );

  assert.equal(supportsCloudSelfTest("prediction"), false);
  assert.match(
    getUnsupportedCloudSelfTestMessage("prediction") ?? "",
    /prediction|预测/,
  );

  assert.equal(supportsCloudSelfTest("ui"), false);
  assert.match(getUnsupportedCloudSelfTestMessage("ui") ?? "", /ui|code/);
});

test("resolveTargetWithWorkspace 校验工作区绑定 serverUrl，拒绝跨服务器误用并兼容大小写/尾部斜杠规范化", async () => {
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "noj-srv-a-"));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "noj-srv-b-"));
  try {
    // 1) 大小写、默认端口与尾部斜杠规范化后视为同一服务器
    assert.equal(
      isMatchingWorkspaceServer(
        "HTTPS://NOJ.Example.com:443///",
        "https://noj.example.com/",
      ),
      true,
    );
    assert.equal(
      isMatchingWorkspaceServer(
        "http://localhost:3000/",
        "HTTP://LOCALHOST:3000",
      ),
      true,
    );
    assert.equal(
      isMatchingWorkspaceServer(
        "https://a.example.com",
        "https://b.example.com",
      ),
      false,
    );

    await writeWorkspaceProblemConfig(dirA, {
      serverUrl: "https://server-a.example.com/",
      domainSlug: "school",
      reference: "main:1001",
      versionId: "ver-from-a",
      version: 1,
      entryFile: "submission.py",
      submissionMode: "code",
      judgeType: "dual",
    });

    // 2) 尾部斜杠/大小写差异匹配同一服务器时，直接复用工作区绑定
    const matchedNormalized = await resolveTargetWithWorkspace({
      workspaceRoot: dirA,
      serverUrl: "HTTPS://SERVER-A.EXAMPLE.COM",
      selectProblem: async () => {
        throw new Error("不应触发重新选题");
      },
      readWorkspaceConfig: readWorkspaceProblemConfig,
      writeWorkspaceConfig: writeWorkspaceProblemConfig,
    });
    assert.equal(matchedNormalized?.domainSlug, "school");
    assert.equal(matchedNormalized?.reference, "main:1001");
    assert.equal(matchedNormalized?.versionId, "ver-from-a");

    // 3) 切换到服务器 B 且未选新题时，不得复用服务器 A 的绑定，应提示并触发重新选题
    const warnings: string[] = [];
    let selectCalls = 0;
    const cancelledOnB = await resolveTargetWithWorkspace({
      workspaceRoot: dirA,
      serverUrl: "https://server-b.example.com",
      selectProblem: async () => {
        selectCalls++;
        return undefined;
      },
      readWorkspaceConfig: readWorkspaceProblemConfig,
      writeWorkspaceConfig: writeWorkspaceProblemConfig,
      onConfigWarning: (msg) => warnings.push(msg),
    });
    assert.equal(cancelledOnB, undefined);
    assert.equal(selectCalls, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /不一致/);

    // 4) 在服务器 B 选了同域同题号时，不会使用也不覆盖服务器 A 的 .noj/problem.json
    const pickedOnB = await resolveTargetWithWorkspace({
      workspaceRoot: dirA,
      serverUrl: "https://server-b.example.com",
      selectedProblem: {
        domainSlug: "school",
        reference: "main:1001",
        id: "main:1001",
        displayId: "main:1001",
        title: "B 站题目",
        versionId: "ver-from-b",
        version: 2,
        submissionMode: "code",
        judgeType: "dual",
      },
      selectProblem: async () => undefined,
      readWorkspaceConfig: readWorkspaceProblemConfig,
      writeWorkspaceConfig: writeWorkspaceProblemConfig,
    });
    assert.equal(pickedOnB?.versionId, "ver-from-b");
    assert.equal(pickedOnB?.workspaceRoot, undefined);
    assert.equal(
      (await readWorkspaceProblemConfig(dirA))?.versionId,
      "ver-from-a",
    );
    await syncWorkspaceProblemVersion(
      dirA,
      {
        domainSlug: "school",
        reference: "main:1001",
        id: "main:1001",
        displayId: "main:1001",
        title: "B 站题目",
        versionId: "ver-from-b",
        version: 2,
        submissionMode: "code",
        judgeType: "dual",
      },
      "https://server-b.example.com",
    );
    assert.equal(
      (await readWorkspaceProblemConfig(dirA))?.versionId,
      "ver-from-a",
    );

    // 5) 若候选工作区存在服务器 B 的绑定，自动选用目录 B 而非目录 A
    await writeWorkspaceProblemConfig(dirB, {
      serverUrl: "https://server-b.example.com/",
      domainSlug: "lab-b",
      reference: "main:2002",
      versionId: "ver-b2",
      version: 3,
      entryFile: "submission.py",
      submissionMode: "artifact",
      judgeType: "dual",
    });
    const switchedToCandidateB = await resolveTargetWithWorkspace({
      workspaceRoot: dirA,
      candidateWorkspaceRoots: [dirB],
      serverUrl: "https://server-b.example.com",
      selectProblem: async () => {
        throw new Error("候选目录 B 已匹配服务器 B，不应再次弹窗");
      },
      readWorkspaceConfig: readWorkspaceProblemConfig,
      writeWorkspaceConfig: writeWorkspaceProblemConfig,
    });
    assert.equal(switchedToCandidateB?.workspaceRoot, dirB);
    assert.equal(switchedToCandidateB?.domainSlug, "lab-b");
    assert.equal(switchedToCandidateB?.versionId, "ver-b2");
  } finally {
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  }
});
