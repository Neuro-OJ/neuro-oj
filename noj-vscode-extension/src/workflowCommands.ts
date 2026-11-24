import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ApiError, type NeuroOjApi } from "./api";
import {
  buildSelfTestFeedback,
  buildSubmissionFeedback,
} from "./feedbackAdapter";
import {
  inferOiLanguage,
  isLocalJudgeAvailable,
  isValidOiRuntimeConfig,
  loadLocalOiRuntimeConfig,
  loadMockLlmConfig,
  runLocalJudgeTrack,
  runPythonMockTrack,
  startLocalLlmMockServer,
} from "./localMock";
import { pollSelfTest, pollSubmission } from "./polling";
import { openReportWebview } from "./reportWebview";
import { openStatementWebview } from "./statementWebview";
import {
  buildCustomSelfTestCases,
  type DirtyDocumentLike,
  getUnsupportedCloudSelfTestMessage,
  isSupportedPredictionFile,
  launchTrackAWithSupportPackage,
  PREDICTION_FILE_EXTENSIONS,
  preparePythonMockDocuments,
  type ResolvedTarget,
  resolveEffectiveWorkspaceRoot,
  resolvePredictionFile,
  resolveSubmissionTransportMode,
  resolveTargetWithWorkspace,
  saveDirtyDocumentsInWorkspace,
  saveDocumentIfDirty,
  supportsCustomSelfTestCases,
} from "./submissionHelpers";
import type {
  Domain,
  EvaluationFeedback,
  Problem,
  SelectedProblem,
  SelfTestCaseInput,
  SubmissionDetail,
} from "./types";
import {
  inferEntryFile,
  initProblemWorkspace,
  readWorkspaceProblemConfig,
  writeWorkspaceProblemConfig,
} from "./workspace";
import { packWorkspaceZip } from "./zipBuilder";

export interface WorkflowHost {
  getApi(): NeuroOjApi;
  getServerUrl(): string;
  getWorkspaceRoot(): string | undefined;
  getCandidateWorkspaceRoots?(
    domainSlug?: string,
    reference?: string,
  ): string[];
  getRememberedWorkspaceRoot?(
    domainSlug: string,
    reference: string,
  ): string | undefined;
  rememberInitializedWorkspace?(
    rootDir: string,
    domainSlug: string,
    reference: string,
  ): Promise<void>;
  activateWorkspaceFolder?(rootDir: string): Promise<void>;
  getDomain(): Domain | undefined;
  getSelectedProblem(): SelectedProblem | undefined;
  updateSelectedProblem?(selected: SelectedProblem): Promise<void>;
  selectProblem(problem?: Problem): Promise<SelectedProblem | undefined>;
  ensureAuthenticated(): Promise<boolean>;
  handleError(prefix: string, error: unknown): Promise<void>;
  readonly output: vscode.OutputChannel;
}

function toDirtyDocumentLike(doc: vscode.TextDocument): DirtyDocumentLike {
  return {
    fileName: doc.fileName,
    fsPath: doc.uri.fsPath,
    scheme: doc.uri.scheme,
    isDirty: doc.isDirty,
    isUntitled: doc.isUntitled,
    save: async () => await doc.save(),
  };
}

function toDirtyDocumentLikes(): DirtyDocumentLike[] {
  return vscode.workspace.textDocuments.map((doc) => toDirtyDocumentLike(doc));
}

async function resolveTargetProblem(
  host: WorkflowHost,
  problemArg?: Problem,
): Promise<ResolvedTarget | undefined> {
  const selected = host.getSelectedProblem();
  return await resolveTargetWithWorkspace({
    workspaceRoot: host.getWorkspaceRoot(),
    candidateWorkspaceRoots: host.getCandidateWorkspaceRoots?.(
      selected?.domainSlug,
      selected?.reference,
    ),
    getRememberedWorkspaceRoot: host.getRememberedWorkspaceRoot,
    selectedProblem: selected,
    problemArg,
    serverUrl: host.getServerUrl(),
    selectProblem: (problem) => host.selectProblem(problem),
    readWorkspaceConfig: readWorkspaceProblemConfig,
    writeWorkspaceConfig: writeWorkspaceProblemConfig,
    onConfigWarning: (message) => {
      vscode.window.showWarningMessage(message);
    },
  });
}

/** 初始化本地题目工作区：落盘 `.noj/problem.json`、`.nojignore` 与模板文件。 */
export async function runInitWorkspace(
  host: WorkflowHost,
  problemArg?: Problem,
): Promise<void> {
  if (!(await host.ensureAuthenticated())) return;
  const target = await resolveTargetProblem(host, problemArg);
  if (!target) return;

  const existingRoot = host.getWorkspaceRoot();
  let targetDir = existingRoot;
  if (existingRoot) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "使用当前工作区目录",
          description: existingRoot,
          useCurrent: true,
        },
        {
          label: "选择其他目录…",
          description: "通过系统目录选择器指定工作区路径",
          useCurrent: false,
        },
      ],
      { title: `初始化题目工作区：${target.reference}` },
    );
    if (!pick) return;
    if (!pick.useCurrent) targetDir = undefined;
  }

  if (!targetDir) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "初始化 Neuro OJ 工作区",
    });
    if (!uris || uris.length === 0) return;
    targetDir = uris[0].fsPath;
  }

  try {
    const api = host.getApi();
    const detail = await api.domainProblem(target.domainSlug, target.reference);
    const rawMode =
      detail.submission_mode ?? detail.content.submission_mode ?? "code";
    const submissionMode =
      rawMode === "artifact" || rawMode === "prediction" ? rawMode : "code";
    const judgeType =
      detail.judge_type === "oi" || detail.content.judge_type === "oi"
        ? "oi"
        : "dual";
    const entryFile = inferEntryFile(submissionMode);

    let templateContent: string | null = null;
    try {
      const tpl = await api.domainTemplate(
        target.domainSlug,
        target.reference,
        detail.version_id,
      );
      templateContent = tpl.template_content;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) {
        throw error;
      }
    }

    const prevConfig = await readWorkspaceProblemConfig(targetDir).catch(
      () => undefined,
    );
    const preservedSupportPackage =
      prevConfig &&
      prevConfig.reference === target.reference &&
      prevConfig.domainSlug === target.domainSlug
        ? prevConfig.supportPackagePath
        : undefined;

    const result = await initProblemWorkspace(
      targetDir,
      {
        serverUrl: host.getServerUrl(),
        domainSlug: target.domainSlug,
        reference: target.reference,
        versionId: detail.version_id,
        version: detail.version,
        entryFile,
        submissionMode,
        judgeType,
        ...(preservedSupportPackage
          ? { supportPackagePath: preservedSupportPackage }
          : {}),
      },
      templateContent,
    );

    await host.rememberInitializedWorkspace?.(
      targetDir,
      target.domainSlug,
      target.reference,
    );
    if (
      !existingRoot ||
      path.resolve(targetDir) !== path.resolve(existingRoot)
    ) {
      await host.activateWorkspaceFolder?.(targetDir);
    }

    const existingSelected = host.getSelectedProblem();
    if (
      host.updateSelectedProblem &&
      existingSelected?.reference === target.reference &&
      (!existingSelected.domainSlug ||
        existingSelected.domainSlug === target.domainSlug)
    ) {
      await host.updateSelectedProblem({
        ...existingSelected,
        domainSlug: target.domainSlug,
        reference: target.reference,
        versionId: detail.version_id,
        version: detail.version,
        submissionMode,
        judgeType,
      });
    }

    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(result.entryPath),
    );
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
      `已初始化 Neuro OJ 工作区：${target.reference}（V${detail.version}）`,
    );
  } catch (error) {
    await host.handleError("初始化工作区失败", error);
  }
}

/** 预览当前或指定题目的 Markdown 题面、样例与版本信息。 */
export async function runPreviewStatement(
  host: WorkflowHost,
  problemArg?: Problem,
): Promise<void> {
  if (!(await host.ensureAuthenticated())) return;
  const target = await resolveTargetProblem(host, problemArg);
  if (!target) return;

  try {
    const detail = await host
      .getApi()
      .domainProblem(target.domainSlug, target.reference);
    openStatementWebview(detail, {
      domainSlug: target.domainSlug,
      reference: target.reference,
    });
  } catch (error) {
    await host.handleError("加载题面失败", error);
  }
}

/** 本地 Mock 运行与调试（轨道 A：`noj-judge run-local`；轨道 B：零 Docker Python 调试）。 */
export async function runLocalMockCommand(host: WorkflowHost): Promise<void> {
  const selected = host.getSelectedProblem();
  const effective = await resolveEffectiveWorkspaceRoot({
    workspaceRoot: host.getWorkspaceRoot(),
    candidateWorkspaceRoots: host.getCandidateWorkspaceRoots?.(
      selected?.domainSlug,
      selected?.reference,
    ),
    selectedProblem: selected,
    serverUrl: host.getServerUrl(),
    readWorkspaceConfig: readWorkspaceProblemConfig,
  });
  const workspaceRoot = effective.workspaceRoot;
  const wsConfig = effective.wsConfig;
  const judgeType = wsConfig?.judgeType ?? selected?.judgeType ?? "dual";

  const document = await resolveLocalMockDocument(
    judgeType,
    wsConfig?.entryFile,
    workspaceRoot,
  );
  if (!document) return;

  const config = vscode.workspace.getConfiguration("neuroOj");
  const judgeBinary = config.get<string>("localJudgeBinary", "noj-judge");
  const pythonBinary = config.get<string>("pythonBinary", "python3");
  const judgeAvailable = await isLocalJudgeAvailable(judgeBinary);

  let track: "judge" | "python" = "python";
  if (judgeAvailable) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "轨道 B：零 Docker 本地 Python + Mock LLM 调试",
          description: "快速验证脚本 / .noj/local_eval.py 与 LLM Trace",
          track: "python" as const,
        },
        {
          label: "轨道 A：noj-judge run-local 容器评测",
          description: "调用本地 noj-judge 与 Docker 沙箱",
          track: "judge" as const,
        },
      ],
      { title: "选择本地 Mock 运行轨道" },
    );
    if (!picked) return;
    track = picked.track;
  }

  const runWithSupportPackage = async (
    supportPackagePath?: string,
    runtimeConfig?: Record<string, unknown>,
  ) => {
    let sampleInput: string | undefined;
    if (track === "python") {
      const input = await vscode.window.showInputBox({
        title: "本地 Mock 样例输入（可选）",
        prompt: "直接回车使用空输入（若存在 .noj/local_eval.py 将优先运行）",
        ignoreFocusOut: true,
      });
      if (input === undefined) return;
      sampleInput = input;
    }

    if (track === "python") {
      const prepResult = await preparePythonMockDocuments(
        toDirtyDocumentLike(document),
        workspaceRoot,
        toDirtyDocumentLikes(),
      );
      if (!prepResult.ok) {
        if (prepResult.reason === "untitled") {
          vscode.window.showWarningMessage(
            `当前 Python 文档 ${path.basename(prepResult.fileName)} 尚未保存到磁盘，请先保存文件后再运行本地 Mock`,
          );
        } else {
          vscode.window.showWarningMessage(
            `文件 ${path.basename(prepResult.fileName)} 保存失败或已取消，已中止本地 Mock 运行${prepResult.detail ? `：${prepResult.detail}` : ""}`,
          );
        }
        return;
      }
    } else if (wsConfig?.submissionMode === "artifact" && workspaceRoot) {
      const saveResult = await saveDirtyDocumentsInWorkspace(
        workspaceRoot,
        toDirtyDocumentLikes(),
      );
      if (!saveResult.ok) {
        vscode.window.showWarningMessage(
          `工作区文件 ${path.basename(saveResult.failedFile)} 保存失败或已取消，已中止本地 Mock 打包${saveResult.reason ? `：${saveResult.reason}` : ""}`,
        );
        return;
      }
    }

    const mockConfig = await loadMockLlmConfig(workspaceRoot);
    const mockServer = await startLocalLlmMockServer(mockConfig);
    const title = wsConfig
      ? `${wsConfig.reference}（本地 Mock）`
      : path.basename(document.fileName);

    try {
      const feedback = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Neuro OJ 本地 Mock · ${title}`,
        },
        async () => {
          if (track === "judge") {
            return await runLocalJudgeTrack({
              binary: judgeBinary,
              title,
              code: document.getText(),
              fileName: path.basename(document.fileName),
              workspaceRoot,
              submissionMode: wsConfig?.submissionMode ?? "code",
              judgeType,
              supportPackagePath,
              runtimeConfig,
              mockServer,
            });
          }
          return await runPythonMockTrack({
            pythonBinary,
            title,
            entryFilePath: document.fileName,
            workspaceRoot,
            sampleInput,
            mockServer,
          });
        },
      );

      logFeedbackSummary(host.output, feedback);
      openReportWebview(feedback, workspaceRoot);
    } catch (error) {
      await host.handleError("本地 Mock 运行失败", error);
    } finally {
      await mockServer.close().catch(() => {});
    }
  };

  if (track === "judge") {
    let oiRuntimeConfig: Record<string, unknown> | undefined;
    if (judgeType === "oi") {
      oiRuntimeConfig = await loadLocalOiRuntimeConfig(workspaceRoot, wsConfig);
      if (!oiRuntimeConfig) {
        const domainSlug = wsConfig?.domainSlug ?? selected?.domainSlug;
        const reference = wsConfig?.reference ?? selected?.reference;
        if (domainSlug && reference) {
          try {
            const detail = await host
              .getApi()
              .domainProblem(domainSlug, reference);
            if (isValidOiRuntimeConfig(detail.content?.runtime_config)) {
              oiRuntimeConfig = detail.content.runtime_config;
            }
          } catch {
            // 离线或无权限读取题目详情时交由下方守卫统一提示
          }
        }
      }
      if (isValidOiRuntimeConfig(oiRuntimeConfig)) {
        const oiLang = inferOiLanguage(path.basename(document.fileName));
        if (!oiLang || !oiRuntimeConfig.languages.includes(oiLang)) {
          vscode.window.showWarningMessage(
            `OI 题目本地容器评测（Track A）仅支持 ${oiRuntimeConfig.languages.join("/")} 源码文件，当前文件 ${path.basename(document.fileName)} 不受支持`,
          );
          return;
        }
      }
    }

    await launchTrackAWithSupportPackage({
      workspaceRoot,
      configuredPath: wsConfig?.supportPackagePath,
      judgeType,
      runtimeConfig: oiRuntimeConfig,
      pickSupportPackage: async () => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: "选择题目支持包 (.zip)",
          filters: { "题目支持包 (ZIP)": ["zip"] },
        });
        return uris?.[0]?.fsPath;
      },
      onMissingSupportPackage: (message) => {
        vscode.window.showWarningMessage(message);
      },
      onMissingOiRuntimeConfig: (message) => {
        vscode.window.showWarningMessage(message);
      },
      launch: (pkgPath) => runWithSupportPackage(pkgPath, oiRuntimeConfig),
    });
    return;
  }

  await runWithSupportPackage();
}

/** 发起云端 Self-Test 并展示可视化评测报告。 */
export async function runSelfTestCommand(host: WorkflowHost): Promise<void> {
  if (!(await host.ensureAuthenticated())) return;
  const target = await resolveTargetProblem(host);
  if (!target) return;

  const unsupportedSelfTestMsg = getUnsupportedCloudSelfTestMessage(
    target.submissionMode,
  );
  if (unsupportedSelfTestMsg) {
    vscode.window.showWarningMessage(unsupportedSelfTestMsg);
    return;
  }

  const workspaceRoot = target.workspaceRoot ?? host.getWorkspaceRoot();
  const document = await resolvePythonDocument(target.entryFile, workspaceRoot);
  if (!document) return;
  const code = document.getText();
  if (!code.trim()) {
    vscode.window.showWarningMessage("当前 Python 文件为空，未发起自测");
    return;
  }

  let cases: SelfTestCaseInput[] | undefined;
  if (supportsCustomSelfTestCases(target.judgeType)) {
    const modePick = await vscode.window.showQuickPick(
      [
        { label: "使用默认样例", custom: false },
        { label: "自定义输入", custom: true },
      ],
      { title: `Neuro OJ Self-Test · ${target.reference}` },
    );
    if (!modePick) return;

    if (modePick.custom) {
      const sample = await vscode.window.showInputBox({
        title: "自定义自测输入",
        prompt: "输入测试数据（stdin）",
        ignoreFocusOut: true,
      });
      if (sample === undefined) return;
      cases = buildCustomSelfTestCases([sample]);
    }
  }

  try {
    const api = host.getApi();
    const config = vscode.workspace.getConfiguration("neuroOj");
    const detail = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Neuro OJ Self-Test · ${target.reference}`,
        cancellable: true,
      },
      async (progress, cancellation) => {
        progress.report({ message: "正在创建云端自测…" });
        const created = await api.createDomainSelfTest(
          target.domainSlug,
          target.reference,
          {
            code,
            language: "python3",
            file_name: path.basename(document.fileName),
            version_id: target.versionId,
            ...(cases ? { cases } : {}),
          },
        );
        host.output.appendLine(
          `\n[Self-Test] ${target.reference} · ${created.id}`,
        );
        return await pollSelfTest(
          () => api.domainSelfTest(target.domainSlug, created.id),
          {
            intervalMs: config.get<number>("pollIntervalSeconds", 2) * 1000,
            timeoutMs: config.get<number>("pollTimeoutSeconds", 180) * 1000,
            isCancelled: () => cancellation.isCancellationRequested,
            onUpdate: (current) => {
              progress.report({ message: `状态：${current.status}` });
            },
          },
        );
      },
    );

    const rawFeedback = await api
      .domainSelfTestFeedback(target.domainSlug, detail.id)
      .catch(() => null);
    const feedback = buildSelfTestFeedback(
      `${target.reference} · Self-Test`,
      detail,
      rawFeedback,
    );
    logFeedbackSummary(host.output, feedback);
    openReportWebview(feedback, workspaceRoot);
  } catch (error) {
    await host.handleError("云端自测失败", error);
  }
}

/** 统一提交流程：按题目模式分别支持单文件代码、多文件 ZIP 产物与单文件预测结果提交，并展示可视化报告。 */
export async function runSubmitCommand(host: WorkflowHost): Promise<void> {
  if (!(await host.ensureAuthenticated())) return;
  const target = await resolveTargetProblem(host);
  if (!target) return;

  const workspaceRoot = target.workspaceRoot ?? host.getWorkspaceRoot();
  const mode = resolveSubmissionTransportMode(target.submissionMode);

  let zipBundle: { buffer: Buffer; files: string[] } | undefined;
  let document: vscode.TextDocument | undefined;
  let predictionFile:
    { filePath: string; fileName: string; buffer: Buffer } | undefined;

  if (mode === "zip") {
    if (!workspaceRoot) {
      vscode.window.showWarningMessage("提交多文件 ZIP 包需要先打开工作区目录");
      return;
    }
    const saveResult = await saveDirtyDocumentsInWorkspace(
      workspaceRoot,
      toDirtyDocumentLikes(),
    );
    if (!saveResult.ok) {
      vscode.window.showWarningMessage(
        `工作区文件 ${path.basename(saveResult.failedFile)} 保存失败或已取消，已中止 ZIP 打包提交${saveResult.reason ? `：${saveResult.reason}` : ""}`,
      );
      return;
    }
    zipBundle = await packWorkspaceZip(workspaceRoot);
    const confirmZip = await vscode.window.showInformationMessage(
      `打包并提交 ${zipBundle.files.length} 个文件（${(zipBundle.buffer.length / 1024).toFixed(1)} KiB）到 ${target.reference}？`,
      { modal: true },
      "提交评测",
    );
    if (confirmZip !== "提交评测") return;
  } else if (mode === "prediction") {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const documents = toDirtyDocumentLikes();
    const resolvedPath = await resolvePredictionFile({
      workspaceRoot,
      configuredEntryFile: target.entryFile ?? inferEntryFile("prediction"),
      activeFilePath:
        activeUri?.scheme === "file" ? activeUri.fsPath : undefined,
      documents,
      workspacePredictionFiles: async () => {
        if (!workspaceRoot) return [];
        const extPattern = PREDICTION_FILE_EXTENSIONS.map((ext) =>
          ext.slice(1),
        ).join(",");
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspaceRoot, `**/*.{${extPattern}}`),
          "**/{node_modules,.git,.venv,venv,.noj}/**",
          30,
        );
        return uris.map((uri) => uri.fsPath);
      },
      pickFromList: async (candidates) => {
        const items: Array<{
          label: string;
          description?: string;
          value: string;
        }> = candidates.map((filePath) => ({
          label: workspaceRoot
            ? path.relative(workspaceRoot, filePath) || path.basename(filePath)
            : path.basename(filePath),
          description: filePath,
          value: filePath,
        }));
        items.push({
          label: "选择其他本地数据文件…",
          description: "通过系统文件选择器选择单个预测结果文件",
          value: "browse",
        });
        const picked = await vscode.window.showQuickPick(items, {
          title: `选择预测结果文件 · ${target.reference}`,
        });
        return picked?.value;
      },
      browseSingleFile: async () => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: "选择预测结果文件",
          filters: {
            预测数据文件: PREDICTION_FILE_EXTENSIONS.map((ext) => ext.slice(1)),
          },
        });
        return uris?.[0]?.fsPath;
      },
    });
    if (!resolvedPath) {
      vscode.window.showWarningMessage(
        "未选择预测结果文件，请准备或选择支持的单文件（如 predictions.csv / .jsonl / .npy）",
      );
      return;
    }
    if (!isSupportedPredictionFile(resolvedPath)) {
      vscode.window.showWarningMessage(
        `不支持的预测文件格式：${path.basename(resolvedPath)}（支持 ${PREDICTION_FILE_EXTENSIONS.join(" / ")}）`,
      );
      return;
    }

    const saveResult = await saveDocumentIfDirty(resolvedPath, documents);
    if (!saveResult.ok) {
      vscode.window.showWarningMessage(
        `预测文件 ${path.basename(saveResult.failedFile)} 保存失败或已取消，已中止提交${saveResult.reason ? `：${saveResult.reason}` : ""}`,
      );
      return;
    }

    const buffer = await fs.readFile(resolvedPath);
    if (buffer.length === 0) {
      vscode.window.showWarningMessage(
        `预测文件 ${path.basename(resolvedPath)} 为空，未提交`,
      );
      return;
    }
    const fileName = path.basename(resolvedPath);
    const confirmPred = await vscode.window.showInformationMessage(
      `提交预测文件 ${fileName}（${(buffer.length / 1024).toFixed(1)} KiB）到 ${target.reference} ${target.title}？`,
      { modal: true },
      "提交评测",
    );
    if (confirmPred !== "提交评测") return;
    predictionFile = { filePath: resolvedPath, fileName, buffer };
  } else {
    document = await resolvePythonDocument(target.entryFile, workspaceRoot);
    if (!document) return;
    if (!document.getText().trim()) {
      vscode.window.showWarningMessage("当前 Python 文件为空，未提交");
      return;
    }
    const confirmCode = await vscode.window.showInformationMessage(
      `提交 ${path.basename(document.fileName)} 到 ${target.reference} ${target.title}？`,
      { modal: true },
      "提交评测",
    );
    if (confirmCode !== "提交评测") return;
  }

  try {
    const api = host.getApi();
    const config = vscode.workspace.getConfiguration("neuroOj");
    const detail = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Neuro OJ · ${target.reference}`,
        cancellable: true,
      },
      async (progress, cancellation) => {
        progress.report({ message: "正在上传…" });
        const created =
          mode === "zip" && zipBundle
            ? await api.submitDomainArtifact(
                target.domainSlug,
                target.reference,
                zipBundle.buffer,
                `${target.reference.replace(/:/g, "-")}.zip`,
                target.versionId,
              )
            : mode === "prediction" && predictionFile
              ? await api.submitDomainPrediction(
                  target.domainSlug,
                  target.reference,
                  predictionFile.buffer,
                  predictionFile.fileName,
                  target.versionId,
                )
              : await api.submitDomainCode(
                  target.domainSlug,
                  target.reference,
                  document!.getText(),
                  path.basename(document!.fileName),
                  target.versionId,
                );

        host.output.appendLine(`\n[提交] ${target.reference} ${target.title}`);
        host.output.appendLine(
          mode === "zip"
            ? `产物：多文件 ZIP（${zipBundle?.files.length ?? 0} 个文件）`
            : mode === "prediction" && predictionFile
              ? `预测文件：${predictionFile.filePath}`
              : `文件：${document!.fileName}`,
        );
        host.output.appendLine(`提交编号：${created.public_id ?? created.id}`);

        return await pollSubmission(
          () => api.domainSubmission(target.domainSlug, created.id),
          {
            intervalMs: config.get<number>("pollIntervalSeconds", 2) * 1000,
            timeoutMs: config.get<number>("pollTimeoutSeconds", 180) * 1000,
            isCancelled: () => cancellation.isCancellationRequested,
            onUpdate: (current) => {
              const queue =
                current.queue_position == null
                  ? ""
                  : `，队列第 ${current.queue_position} 位`;
              progress.report({
                message: `${statusLabel(current.status)}${queue}`,
              });
            },
          },
        );
      },
    );

    await showSubmissionResult(host, target, detail);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      vscode.window.showWarningMessage(
        "作答版本已变化，当前文件保留。请刷新并重新选择题目，确认新题面后再次提交。",
      );
    }
    await host.handleError("提交或评测失败", error);
  }
}

async function showSubmissionResult(
  host: WorkflowHost,
  target: ResolvedTarget,
  detail: SubmissionDetail,
): Promise<void> {
  if (detail.result_visibility === "hidden") {
    host.output.appendLine("已受理，结果按比赛规则暂未公开");
    host.output.show(true);
    vscode.window.showInformationMessage("Neuro OJ：提交已受理，结果暂未公开");
    return;
  }

  const rawFeedback = await host
    .getApi()
    .domainSubmissionFeedback(target.domainSlug, detail.id)
    .catch(() => null);
  const feedback = buildSubmissionFeedback(
    `${target.reference} ${target.title}`,
    detail,
    rawFeedback,
  );
  logFeedbackSummary(host.output, feedback);

  if (detail.status === "error") {
    vscode.window.showErrorMessage("Neuro OJ 评测失败，详情已写入输出面板");
  } else {
    const score =
      feedback.score !== null
        ? `${feedback.score.toFixed(2)} 分`
        : "结果已完成";
    vscode.window.showInformationMessage(`Neuro OJ 评测完成：${score}`);
  }
  openReportWebview(feedback, target.workspaceRoot ?? host.getWorkspaceRoot());
}

function logFeedbackSummary(
  output: vscode.OutputChannel,
  feedback: EvaluationFeedback,
): void {
  output.appendLine(`状态：${feedback.status}`);
  if (feedback.score !== null) {
    output.appendLine(
      `得分：${feedback.score.toFixed(2)} / ${feedback.maxScore}`,
    );
  }
  if (feedback.timeMs != null) output.appendLine(`耗时：${feedback.timeMs} ms`);
  if (feedback.memoryKb != null) {
    output.appendLine(`内存：${feedback.memoryKb} KiB`);
  }
  if (feedback.metering) {
    output.appendLine(
      `LLM Token：${feedback.metering.totalTokens}（调用 ${feedback.metering.callCount} 次）`,
    );
  }
  if (feedback.output) {
    output.appendLine("\n评测输出：");
    output.appendLine(feedback.output);
    if (feedback.outputTruncated) {
      output.appendLine("[输出已由服务端截断]");
    }
  }
  output.show(true);
}

async function resolveLocalMockDocument(
  judgeType: "dual" | "oi",
  preferredEntry?: string,
  workspaceRoot?: string,
): Promise<vscode.TextDocument | undefined> {
  if (judgeType !== "oi") {
    return await resolvePythonDocument(preferredEntry, workspaceRoot);
  }
  const active = vscode.window.activeTextEditor?.document;
  if (
    active &&
    (inferOiLanguage(path.basename(active.fileName)) !== undefined ||
      active.languageId === "python" ||
      active.fileName.toLowerCase().endsWith(".py"))
  ) {
    return active;
  }
  const pattern = workspaceRoot
    ? new vscode.RelativePattern(
        workspaceRoot,
        preferredEntry || "**/*.{c,cc,cpp,cxx,py}",
      )
    : preferredEntry || "**/*.{c,cc,cpp,cxx,py}";
  const files = await vscode.workspace.findFiles(
    pattern,
    "**/{node_modules,.git,.venv,venv}/**",
    2,
  );
  if (files.length >= 1) {
    const document = await vscode.workspace.openTextDocument(files[0]);
    await vscode.window.showTextDocument(document);
    return document;
  }
  return await resolvePythonDocument(preferredEntry, workspaceRoot);
}

async function resolvePythonDocument(
  preferredEntry?: string,
  workspaceRoot?: string,
): Promise<vscode.TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (
    active &&
    (active.languageId === "python" ||
      active.fileName.toLowerCase().endsWith(".py"))
  ) {
    return active;
  }

  const targetName = preferredEntry || "submission.py";
  const pattern = workspaceRoot
    ? new vscode.RelativePattern(workspaceRoot, `**/${targetName}`)
    : `**/${targetName}`;
  const files = await vscode.workspace.findFiles(
    pattern,
    "**/{node_modules,.git,.venv,venv}/**",
    2,
  );
  if (files.length === 1) {
    const document = await vscode.workspace.openTextDocument(files[0]);
    await vscode.window.showTextDocument(document);
    return document;
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        uri,
      })),
      { title: `选择 ${targetName}` },
    );
    if (picked) return await vscode.workspace.openTextDocument(picked.uri);
    return undefined;
  }

  vscode.window.showWarningMessage(
    `请打开一个 Python 文件，或在工作区创建 ${targetName}`,
  );
  return undefined;
}

function statusLabel(status: SubmissionDetail["status"]): string {
  if (status === undefined) return "已受理";
  return {
    pending: "等待评测",
    judging: "评测中",
    finished: "评测完成",
    error: "评测错误",
  }[status];
}
