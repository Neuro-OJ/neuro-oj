import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isValidOiRuntimeConfig } from "./localMock";
import type {
  Problem,
  SelectedProblem,
  SelfTestCaseInput,
  WorkspaceProblemConfig,
} from "./types";
import {
  inferEntryFile,
  isMatchingWorkspaceServer,
  NOJ_DIR,
  normalizeServerUrlForComparison,
} from "./workspace";

export const DEFAULT_SUPPORT_PACKAGE_REL_PATH = path.join(
  NOJ_DIR,
  "support-package.zip",
);

/** 与后端 prediction-format.ts 对齐的预测数据文件扩展名白名单。 */
export const PREDICTION_FILE_EXTENSIONS = [
  ".csv",
  ".tsv",
  ".jsonl",
  ".json",
  ".txt",
  ".npy",
  ".npz",
  ".parquet",
] as const;

export type SubmissionTransportMode = "code" | "zip" | "prediction";

export interface ResolvedTarget {
  domainSlug: string;
  reference: string;
  title: string;
  versionId: string;
  version: number | null;
  submissionMode: "code" | "artifact" | "prediction";
  judgeType: "dual" | "oi";
  entryFile?: string;
  workspaceRoot?: string;
}

export interface DirtyDocumentLike {
  fileName: string;
  fsPath: string;
  scheme: string;
  isDirty: boolean;
  isUntitled?: boolean;
  save(): Promise<boolean>;
}

/** 仅 artifact 模式允许打包多文件 ZIP；code 与 prediction 各自走单文件提交路径。 */
export function resolveSubmissionTransportMode(
  submissionMode: "code" | "artifact" | "prediction",
): SubmissionTransportMode {
  if (submissionMode === "artifact") return "zip";
  if (submissionMode === "prediction") return "prediction";
  return "code";
}

/** 判断路径是否属于支持上传的预测数据文件扩展名。 */
export function isSupportedPredictionFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (PREDICTION_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/** 判断文件是否位于指定工作区根目录内。 */
export function isPathWithinRoot(filePath: string, rootDir: string): boolean {
  const rel = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 打包 ZIP 前保存工作区内所有未保存文档；任一取消或失败即中止提交。 */
export async function saveDirtyDocumentsInWorkspace(
  workspaceRoot: string,
  documents: readonly DirtyDocumentLike[],
): Promise<
  | { ok: true; savedCount: number }
  | { ok: false; failedFile: string; reason?: string }
> {
  let savedCount = 0;
  for (const doc of documents) {
    if (
      !doc.isDirty ||
      doc.scheme !== "file" ||
      !isPathWithinRoot(doc.fsPath, workspaceRoot)
    ) {
      continue;
    }
    try {
      const saved = await doc.save();
      if (!saved) {
        return { ok: false, failedFile: doc.fileName };
      }
      savedCount++;
    } catch (error) {
      return {
        ok: false,
        failedFile: doc.fileName,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true, savedCount };
}

/** 若目标单文件在编辑器中打开且存在未保存修改，则在读取上传前先保存。 */
export async function saveDocumentIfDirty(
  filePath: string,
  documents: readonly DirtyDocumentLike[],
): Promise<
  | { ok: true; saved: boolean }
  | { ok: false; failedFile: string; reason?: string }
> {
  const target = path.resolve(filePath);
  const matched = documents.find(
    (doc) => doc.scheme === "file" && path.resolve(doc.fsPath) === target,
  );
  if (!matched || !matched.isDirty) {
    return { ok: true, saved: false };
  }
  try {
    const saved = await matched.save();
    if (!saved) {
      return { ok: false, failedFile: matched.fileName };
    }
    return { ok: true, saved: true };
  } catch (error) {
    return {
      ok: false,
      failedFile: matched.fileName,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export type PrepareTrackBResult =
  | { ok: true; savedCount: number }
  | {
      ok: false;
      reason: "untitled" | "save_failed";
      fileName: string;
      detail?: string;
    };

/**
 * 轨道 B 启动前检查入口 Python 文档及工作区脏文件：
 * - 若入口文档尚未命名保存（`untitled`），中止并提示先保存到磁盘；
 * - 若入口文档或工作区内文件存在未保存修改，则先落盘保存，避免评测磁盘旧内容。
 */
export async function preparePythonMockDocuments(
  entryDocument: DirtyDocumentLike,
  workspaceRoot: string | undefined,
  documents: readonly DirtyDocumentLike[],
): Promise<PrepareTrackBResult> {
  if (entryDocument.isUntitled || entryDocument.scheme === "untitled") {
    return {
      ok: false,
      reason: "untitled",
      fileName: entryDocument.fileName,
    };
  }

  let savedCount = 0;
  if (entryDocument.isDirty && entryDocument.scheme === "file") {
    try {
      const saved = await entryDocument.save();
      if (!saved) {
        return {
          ok: false,
          reason: "save_failed",
          fileName: entryDocument.fileName,
        };
      }
      savedCount++;
    } catch (error) {
      return {
        ok: false,
        reason: "save_failed",
        fileName: entryDocument.fileName,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (workspaceRoot) {
    const entryResolved =
      entryDocument.scheme === "file"
        ? path.resolve(entryDocument.fsPath)
        : undefined;
    const remainingDocs = entryResolved
      ? documents.filter(
          (doc) =>
            !(
              doc.scheme === "file" &&
              path.resolve(doc.fsPath) === entryResolved
            ),
        )
      : documents;
    const wsSave = await saveDirtyDocumentsInWorkspace(
      workspaceRoot,
      remainingDocs,
    );
    if (!wsSave.ok) {
      return {
        ok: false,
        reason: "save_failed",
        fileName: wsSave.failedFile,
        detail: wsSave.reason,
      };
    }
    savedCount += wsSave.savedCount;
  }

  return { ok: true, savedCount };
}

/** 仅 OI 题型支持提交自定义自测用例；双容器（dual）或未知题型一律走默认自测。 */
export function supportsCustomSelfTestCases(judgeType?: string): boolean {
  return judgeType === "oi";
}

/** 仅单文件代码提交模式（code）支持云端代码自测（Self-Test）。 */
export function supportsCloudSelfTest(submissionMode?: string): boolean {
  return !submissionMode || submissionMode === "code";
}

/** 若当前提交模式不支持云端代码自测，返回面向用户的说明文案；支持时返回 `undefined`。 */
export function getUnsupportedCloudSelfTestMessage(
  submissionMode?: string,
): string | undefined {
  if (supportsCloudSelfTest(submissionMode)) return undefined;
  if (submissionMode === "artifact") {
    return "当前题目为多文件产物提交模式（artifact），不支持云端代码自测（Self-Test），请使用本地 Mock 调试或直接提交 ZIP 产物";
  }
  if (submissionMode === "prediction") {
    return "当前题目为预测结果提交模式（prediction），不支持云端代码自测（Self-Test），请使用本地调试或直接提交预测文件";
  }
  return `当前题目提交模式（${submissionMode}）不支持云端代码自测（Self-Test），仅支持 code 模式题目`;
}

/** 构造带唯一合法 id（匹配服务端 `[A-Za-z0-9_-]{1,100}`）的自定义自测用例列表。 */
export function buildCustomSelfTestCases(
  inputs: readonly string[],
  prefix = "custom",
): SelfTestCaseInput[] {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "") || "custom";
  return inputs.map((input, idx) => ({
    id: `${safePrefix}-${idx + 1}`,
    input,
  }));
}

export interface SupportPackageResolverDeps {
  workspaceRoot?: string;
  configuredPath?: string;
  pickSupportPackage?: () => Promise<string | undefined>;
}

async function isValidSupportPackageZip(filePath: string): Promise<boolean> {
  if (path.extname(filePath).toLowerCase() !== ".zip") {
    return false;
  }
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 解析 Track A（`noj-judge run-local`）所需的题目支持包 `.zip` 路径：
 * 1. 若配置了 `configuredPath`（相对工作区或绝对路径），校验其为存在且后缀为 `.zip` 的文件；
 * 2. 否则自动探测工作区内 `.noj/support-package.zip`；
 * 3. 若仍未找到，调用 `pickSupportPackage` 向用户请求选择，并在取消或文件无效时返回 `undefined`。
 */
export async function resolveSupportPackagePath(
  deps: SupportPackageResolverDeps,
): Promise<string | undefined> {
  const configured = deps.configuredPath?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) && !deps.workspaceRoot) {
      return undefined;
    }
    const resolved = path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(deps.workspaceRoot!, configured);
    return (await isValidSupportPackageZip(resolved)) ? resolved : undefined;
  }

  if (deps.workspaceRoot) {
    const defaultZip = path.resolve(
      deps.workspaceRoot,
      DEFAULT_SUPPORT_PACKAGE_REL_PATH,
    );
    if (await isValidSupportPackageZip(defaultZip)) {
      return defaultZip;
    }
  }

  const picked = deps.pickSupportPackage
    ? await deps.pickSupportPackage()
    : undefined;
  if (!picked) return undefined;
  const resolvedPicked = path.resolve(picked);
  return (await isValidSupportPackageZip(resolvedPicked))
    ? resolvedPicked
    : undefined;
}

export const DUAL_SUPPORT_PACKAGE_REQUIRED_MESSAGE =
  "双容器本地评测需要题目的支持包（.zip），或请切换轻量 Python Mock 模式（Track B）";

export const OI_TRACK_A_CONFIG_REQUIRED_MESSAGE =
  "OI 题目本地容器评测（Track A）需要完整的 OI runtime_config（包含 languages、checker 与非空 subtasks）和题目支持包（.zip）；当前工作区缺少完整配置，请改用云端自测（Self-Test）或使用 noj-cli problem test 验题";

export const OI_SUPPORT_PACKAGE_REQUIRED_MESSAGE =
  "OI 题目本地容器评测（Track A）需要包含测试数据的题目支持包（.zip），请先提供支持包或改用云端自测（Self-Test）";

export interface TrackASupportPackageLaunchDeps {
  workspaceRoot?: string;
  configuredPath?: string;
  judgeType?: "dual" | "oi";
  runtimeConfig?: Record<string, unknown>;
  pickSupportPackage?: () => Promise<string | undefined>;
  onMissingSupportPackage?: (message: string) => void;
  onMissingOiRuntimeConfig?: (message: string) => void;
  launch: (supportPackagePath?: string) => Promise<void>;
}

/**
 * 轨道 A 启动前解析支持包并校验前置条件：
 * - OI 题必须具备完整的 `OiRuntimeConfig` 与包含测试数据的支持包 `.zip`；
 * - 双容器题必须具备支持包 `.zip`；
 * 未满足时通知用户并中止，绝不调用 `launch` / `runLocalJudgeTrack`。
 */
export async function launchTrackAWithSupportPackage(
  deps: TrackASupportPackageLaunchDeps,
): Promise<boolean> {
  const judgeType = deps.judgeType ?? "dual";
  if (judgeType === "oi" && !isValidOiRuntimeConfig(deps.runtimeConfig)) {
    (deps.onMissingOiRuntimeConfig ?? deps.onMissingSupportPackage)?.(
      OI_TRACK_A_CONFIG_REQUIRED_MESSAGE,
    );
    return false;
  }

  const supportPackagePath = await resolveSupportPackagePath({
    workspaceRoot: deps.workspaceRoot,
    configuredPath: deps.configuredPath,
    pickSupportPackage: deps.pickSupportPackage,
  });
  if (!supportPackagePath) {
    deps.onMissingSupportPackage?.(
      judgeType === "oi"
        ? OI_SUPPORT_PACKAGE_REQUIRED_MESSAGE
        : DUAL_SUPPORT_PACKAGE_REQUIRED_MESSAGE,
    );
    return false;
  }
  await deps.launch(supportPackagePath);
  return true;
}

export interface PredictionFileResolverDeps {
  workspaceRoot?: string;
  configuredEntryFile?: string;
  activeFilePath?: string;
  documents?: readonly DirtyDocumentLike[];
  workspacePredictionFiles?: () => Promise<string[]>;
  pickFromList?: (
    candidates: string[],
  ) => Promise<string | "browse" | undefined>;
  browseSingleFile?: () => Promise<string | undefined>;
}

async function statFileSize(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析 prediction 模式的单文件提交目标：
 * 1. 当前激活编辑器本身是支持的数据文件时优先使用；
 * 2. 否则检查工作区配置的预测入口文件（如 `predictions.csv` / `.jsonl` / `.npy`）；
 * 3. 再否则扫描工作区数据文件供选择，或弹出单文件选择器。
 */
export async function resolvePredictionFile(
  deps: PredictionFileResolverDeps,
): Promise<string | undefined> {
  if (deps.activeFilePath && isSupportedPredictionFile(deps.activeFilePath)) {
    return deps.activeFilePath;
  }

  let configuredPath: string | undefined;
  let configuredSize: number | undefined;
  if (
    deps.workspaceRoot &&
    deps.configuredEntryFile &&
    isSupportedPredictionFile(deps.configuredEntryFile)
  ) {
    configuredPath = path.resolve(deps.workspaceRoot, deps.configuredEntryFile);
    const resolvedConfigured = configuredPath;
    const isDirtyInEditor = Boolean(
      deps.documents?.some(
        (doc) =>
          doc.scheme === "file" &&
          doc.isDirty &&
          path.resolve(doc.fsPath) === resolvedConfigured,
      ),
    );
    configuredSize = await statFileSize(configuredPath);
    if (
      isDirtyInEditor ||
      (configuredSize !== undefined && configuredSize > 0)
    ) {
      return configuredPath;
    }
  }

  const candidates = deps.workspacePredictionFiles
    ? await deps.workspacePredictionFiles()
    : [];
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1 && deps.pickFromList) {
    const picked = await deps.pickFromList(candidates);
    if (picked === undefined) return undefined;
    if (picked !== "browse") return picked;
  }

  const browsed = deps.browseSingleFile
    ? await deps.browseSingleFile()
    : undefined;
  if (browsed) return browsed;
  if (configuredPath && configuredSize !== undefined) return configuredPath;
  return undefined;
}

export interface TargetProblemResolutionDeps {
  workspaceRoot?: string;
  candidateWorkspaceRoots?: readonly string[];
  getRememberedWorkspaceRoot?(
    domainSlug: string,
    reference: string,
  ): string | undefined;
  selectedProblem?: SelectedProblem;
  problemArg?: Problem;
  serverUrl?: string;
  selectProblem(problem?: Problem): Promise<SelectedProblem | undefined>;
  readWorkspaceConfig(
    rootDir: string,
  ): Promise<WorkspaceProblemConfig | undefined>;
  writeWorkspaceConfig(
    rootDir: string,
    config: WorkspaceProblemConfig,
  ): Promise<string>;
  onConfigWarning?(message: string): void;
}

export interface EffectiveWorkspaceResolutionDeps {
  workspaceRoot?: string;
  candidateWorkspaceRoots?: readonly string[];
  selectedProblem?: SelectedProblem;
  serverUrl?: string;
  readWorkspaceConfig(
    rootDir: string,
  ): Promise<WorkspaceProblemConfig | undefined>;
  onConfigWarning?(message: string): void;
}

function matchesProblemConfig(
  wsConfig: WorkspaceProblemConfig,
  domainSlug: string | undefined,
  reference: string | undefined,
  serverUrl?: string,
): boolean {
  if (!isMatchingWorkspaceServer(wsConfig.serverUrl, serverUrl)) return false;
  if (!reference || wsConfig.reference !== reference) return false;
  if (domainSlug && wsConfig.domainSlug !== domainSlug) return false;
  return true;
}

function formatServerMismatchMessage(
  bindingServerUrl: string,
  currentServerUrl: string,
): string {
  return `当前工作区绑定的是服务器 ${bindingServerUrl}，与当前服务器 ${currentServerUrl} 不一致；已忽略旧绑定，请重新选择或初始化题目`;
}

function uniqueWorkspacePaths(
  paths: readonly (string | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of paths) {
    if (!item) continue;
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(item);
  }
  return out;
}

async function readWorkspaceConfigSafely(
  rootDir: string,
  readWorkspaceConfig: (
    rootDir: string,
  ) => Promise<WorkspaceProblemConfig | undefined>,
  onConfigWarning?: (message: string) => void,
): Promise<WorkspaceProblemConfig | undefined> {
  try {
    return await readWorkspaceConfig(rootDir);
  } catch (error) {
    onConfigWarning?.(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * 解析当前题目对应的有效工作区根目录：
 * 若默认工作区目录（目录 A）下没有匹配所选题目的 `.noj/problem.json`，
 * 则依次检查候选/已初始化目录（目录 B），匹配成功时返回目录 B，避免误操作目录 A。
 */
export async function resolveEffectiveWorkspaceRoot(
  deps: EffectiveWorkspaceResolutionDeps,
): Promise<{ workspaceRoot?: string; wsConfig?: WorkspaceProblemConfig }> {
  const defaultConfig = deps.workspaceRoot
    ? await readWorkspaceConfigSafely(
        deps.workspaceRoot,
        deps.readWorkspaceConfig,
        deps.onConfigWarning,
      )
    : undefined;

  const selected = deps.selectedProblem;
  if (selected?.reference) {
    if (
      defaultConfig &&
      matchesProblemConfig(
        defaultConfig,
        selected.domainSlug,
        selected.reference,
        deps.serverUrl,
      )
    ) {
      return { workspaceRoot: deps.workspaceRoot, wsConfig: defaultConfig };
    }
    const candidates = uniqueWorkspacePaths(
      deps.candidateWorkspaceRoots ?? [],
    ).filter(
      (dir) =>
        !deps.workspaceRoot ||
        path.resolve(dir) !== path.resolve(deps.workspaceRoot),
    );
    for (const candidate of candidates) {
      const cfg = await readWorkspaceConfigSafely(
        candidate,
        deps.readWorkspaceConfig,
        deps.onConfigWarning,
      );
      if (
        cfg &&
        matchesProblemConfig(
          cfg,
          selected.domainSlug,
          selected.reference,
          deps.serverUrl,
        )
      ) {
        return { workspaceRoot: candidate, wsConfig: cfg };
      }
    }
    if (
      defaultConfig &&
      !matchesProblemConfig(
        defaultConfig,
        selected.domainSlug,
        selected.reference,
        deps.serverUrl,
      )
    ) {
      return { workspaceRoot: deps.workspaceRoot, wsConfig: undefined };
    }
    return { workspaceRoot: deps.workspaceRoot, wsConfig: defaultConfig };
  }

  if (
    defaultConfig &&
    isMatchingWorkspaceServer(defaultConfig.serverUrl, deps.serverUrl)
  ) {
    return { workspaceRoot: deps.workspaceRoot, wsConfig: defaultConfig };
  }
  for (const candidate of uniqueWorkspacePaths(
    deps.candidateWorkspaceRoots ?? [],
  )) {
    const cfg = await readWorkspaceConfigSafely(
      candidate,
      deps.readWorkspaceConfig,
      deps.onConfigWarning,
    );
    if (cfg && isMatchingWorkspaceServer(cfg.serverUrl, deps.serverUrl)) {
      return { workspaceRoot: candidate, wsConfig: cfg };
    }
  }
  if (
    defaultConfig &&
    deps.serverUrl &&
    !isMatchingWorkspaceServer(defaultConfig.serverUrl, deps.serverUrl)
  ) {
    deps.onConfigWarning?.(
      formatServerMismatchMessage(
        defaultConfig.serverUrl,
        normalizeServerUrlForComparison(deps.serverUrl) ?? deps.serverUrl,
      ),
    );
  }
  return { workspaceRoot: deps.workspaceRoot, wsConfig: undefined };
}

function buildUpdatedWorkspaceConfig(
  wsConfig: WorkspaceProblemConfig,
  selected: SelectedProblem,
  serverUrl?: string,
): WorkspaceProblemConfig | undefined {
  if (!selected.reference || !selected.versionId) return undefined;
  if (!isMatchingWorkspaceServer(wsConfig.serverUrl, serverUrl)) {
    return undefined;
  }
  if (
    wsConfig.reference !== selected.reference ||
    (selected.domainSlug && wsConfig.domainSlug !== selected.domainSlug)
  ) {
    return undefined;
  }

  const nextServerUrl =
    normalizeServerUrlForComparison(serverUrl) || wsConfig.serverUrl;
  const nextDomainSlug = selected.domainSlug ?? wsConfig.domainSlug;
  const nextMode = selected.submissionMode ?? wsConfig.submissionMode;
  const nextJudgeType = selected.judgeType ?? wsConfig.judgeType;
  const nextVersion = selected.version ?? wsConfig.version;
  const nextEntryFile =
    nextMode !== wsConfig.submissionMode &&
    wsConfig.entryFile === inferEntryFile(wsConfig.submissionMode)
      ? inferEntryFile(nextMode)
      : wsConfig.entryFile;

  const changed =
    wsConfig.serverUrl !== nextServerUrl ||
    wsConfig.domainSlug !== nextDomainSlug ||
    wsConfig.versionId !== selected.versionId ||
    wsConfig.version !== nextVersion ||
    wsConfig.submissionMode !== nextMode ||
    wsConfig.judgeType !== nextJudgeType ||
    wsConfig.entryFile !== nextEntryFile;

  if (!changed) return wsConfig;

  return {
    serverUrl: nextServerUrl,
    domainSlug: nextDomainSlug,
    reference: wsConfig.reference,
    versionId: selected.versionId,
    version: nextVersion,
    entryFile: nextEntryFile,
    submissionMode: nextMode,
    judgeType: nextJudgeType,
    ...(wsConfig.supportPackagePath
      ? { supportPackagePath: wsConfig.supportPackagePath }
      : {}),
    ...(wsConfig.runtimeConfig
      ? { runtimeConfig: wsConfig.runtimeConfig }
      : {}),
  };
}

/**
 * 解析目标题目与作答版本：
 * 若用户显式重新选题更新了 `SelectedProblem.versionId`，则优先采用新版本并同步写回 `.noj/problem.json`；
 * 当默认工作区目录（目录 A）未绑定当前题目时，自动回退到已初始化匹配该题目的候选目录（目录 B）。
 */
export async function resolveTargetWithWorkspace(
  deps: TargetProblemResolutionDeps,
): Promise<ResolvedTarget | undefined> {
  const candidatesFor = (selected?: SelectedProblem): string[] =>
    uniqueWorkspacePaths([
      selected?.domainSlug && selected.reference
        ? deps.getRememberedWorkspaceRoot?.(
            selected.domainSlug,
            selected.reference,
          )
        : undefined,
      ...(deps.candidateWorkspaceRoots ?? []),
    ]);

  const syncIfBound = async (
    selected: SelectedProblem,
    targetRoot?: string,
    existingWsConfig?: WorkspaceProblemConfig,
  ): Promise<{ entryFile?: string; workspaceRoot?: string }> => {
    const effective =
      targetRoot && existingWsConfig
        ? { workspaceRoot: targetRoot, wsConfig: existingWsConfig }
        : await resolveEffectiveWorkspaceRoot({
            workspaceRoot: deps.workspaceRoot,
            candidateWorkspaceRoots: candidatesFor(selected),
            selectedProblem: selected,
            serverUrl: deps.serverUrl,
            readWorkspaceConfig: deps.readWorkspaceConfig,
            onConfigWarning: deps.onConfigWarning,
          });
    if (!effective.workspaceRoot || !effective.wsConfig) {
      return {};
    }
    try {
      const nextConfig = buildUpdatedWorkspaceConfig(
        effective.wsConfig,
        selected,
        deps.serverUrl,
      );
      if (!nextConfig) return { workspaceRoot: effective.workspaceRoot };
      if (nextConfig !== effective.wsConfig) {
        await deps.writeWorkspaceConfig(effective.workspaceRoot, nextConfig);
      }
      return {
        entryFile: nextConfig.entryFile,
        workspaceRoot: effective.workspaceRoot,
      };
    } catch (error) {
      deps.onConfigWarning?.(
        error instanceof Error ? error.message : String(error),
      );
      return {
        entryFile: effective.wsConfig.entryFile,
        workspaceRoot: effective.workspaceRoot,
      };
    }
  };

  if (deps.problemArg) {
    const picked = await deps.selectProblem(deps.problemArg);
    if (!picked?.domainSlug || !picked.reference || !picked.versionId) {
      return undefined;
    }
    const bound = await syncIfBound(picked);
    return {
      domainSlug: picked.domainSlug,
      reference: picked.reference,
      title: picked.title,
      versionId: picked.versionId,
      version: picked.version,
      submissionMode: picked.submissionMode ?? "code",
      judgeType: picked.judgeType ?? "dual",
      entryFile: bound.entryFile,
      workspaceRoot: bound.workspaceRoot,
    };
  }

  const effective = await resolveEffectiveWorkspaceRoot({
    workspaceRoot: deps.workspaceRoot,
    candidateWorkspaceRoots: candidatesFor(deps.selectedProblem),
    selectedProblem: deps.selectedProblem,
    serverUrl: deps.serverUrl,
    readWorkspaceConfig: deps.readWorkspaceConfig,
    onConfigWarning: deps.onConfigWarning,
  });

  if (
    effective.wsConfig &&
    isMatchingWorkspaceServer(effective.wsConfig.serverUrl, deps.serverUrl)
  ) {
    const wsConfig = effective.wsConfig;
    const selected = deps.selectedProblem;
    if (!selected) {
      return {
        domainSlug: wsConfig.domainSlug,
        reference: wsConfig.reference,
        title: wsConfig.reference,
        versionId: wsConfig.versionId,
        version: wsConfig.version,
        submissionMode: wsConfig.submissionMode,
        judgeType: wsConfig.judgeType,
        entryFile: wsConfig.entryFile,
        workspaceRoot: effective.workspaceRoot,
      };
    }

    if (
      matchesProblemConfig(
        wsConfig,
        selected.domainSlug,
        selected.reference,
        deps.serverUrl,
      )
    ) {
      if (selected.versionId && selected.versionId !== wsConfig.versionId) {
        const synced = await syncIfBound(
          selected,
          effective.workspaceRoot,
          wsConfig,
        );
        return {
          domainSlug: selected.domainSlug ?? wsConfig.domainSlug,
          reference: wsConfig.reference,
          title: selected.title || wsConfig.reference,
          versionId: selected.versionId,
          version: selected.version ?? wsConfig.version,
          submissionMode: selected.submissionMode ?? wsConfig.submissionMode,
          judgeType: selected.judgeType ?? wsConfig.judgeType,
          entryFile: synced.entryFile ?? wsConfig.entryFile,
          workspaceRoot: synced.workspaceRoot ?? effective.workspaceRoot,
        };
      }
      return {
        domainSlug: wsConfig.domainSlug,
        reference: wsConfig.reference,
        title: selected.title || wsConfig.reference,
        versionId: wsConfig.versionId,
        version: wsConfig.version,
        submissionMode: wsConfig.submissionMode,
        judgeType: wsConfig.judgeType,
        entryFile: wsConfig.entryFile,
        workspaceRoot: effective.workspaceRoot,
      };
    }
  }

  let selected = deps.selectedProblem;
  if (!selected) {
    selected = await deps.selectProblem();
  }
  if (!selected?.domainSlug || !selected.reference || !selected.versionId) {
    return undefined;
  }
  const bound = await syncIfBound(selected);
  return {
    domainSlug: selected.domainSlug,
    reference: selected.reference,
    title: selected.title,
    versionId: selected.versionId,
    version: selected.version,
    submissionMode: selected.submissionMode ?? "code",
    judgeType: selected.judgeType ?? "dual",
    entryFile: bound.entryFile,
    workspaceRoot: bound.workspaceRoot,
  };
}
