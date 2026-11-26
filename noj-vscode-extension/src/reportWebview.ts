import * as path from "node:path";
import type * as vscode from "vscode";
import { renderReportHtml } from "./reportHtml";
import type { EvaluationFeedback } from "./types";

function loadVscode(): typeof vscode {
  return require("vscode") as typeof vscode;
}

export interface ReportWebviewPanelLike {
  title: string;
  webview: {
    html: string;
    onDidReceiveMessage(listener: (message: unknown) => unknown): unknown;
  };
  onDidDispose(listener: () => unknown): unknown;
}

export interface ReportWebviewControllerDeps<
  TPanel extends ReportWebviewPanelLike = vscode.WebviewPanel,
> {
  createPanel(title: string): TPanel;
  revealPanel(panel: TPanel): void;
  renderHtml?(feedback: EvaluationFeedback): string;
  onOpenLocation(
    workspaceRoot: string | undefined,
    file: string,
    line: number,
  ): Promise<void> | void;
}

export interface ReportWebviewController<
  TPanel extends ReportWebviewPanelLike = vscode.WebviewPanel,
> {
  open(feedback: EvaluationFeedback, workspaceRoot?: string): TPanel;
  getWorkspaceRoot(): string | undefined;
  getPanel(): TPanel | undefined;
}

/**
 * 创建可复用面板的评测报告 Webview 控制器：
 * 将当前报告对应的 `workspaceRoot` 保存在可变控制器状态中，每次打开或复用面板都同步更新，
 * 避免切换工作区后点击源码链接仍按旧工作区路径解析。
 */
export function createReportWebviewController<
  TPanel extends ReportWebviewPanelLike = vscode.WebviewPanel,
>(deps: ReportWebviewControllerDeps<TPanel>): ReportWebviewController<TPanel> {
  let panel: TPanel | undefined;
  let currentWorkspaceRoot: string | undefined;

  return {
    open(feedback: EvaluationFeedback, workspaceRoot?: string): TPanel {
      const title = `评测报告：${feedback.title}`;
      currentWorkspaceRoot = workspaceRoot;
      if (panel) {
        panel.title = title;
        deps.revealPanel(panel);
      } else {
        panel = deps.createPanel(title);
        panel.onDidDispose(() => {
          panel = undefined;
          currentWorkspaceRoot = undefined;
        });
        panel.webview.onDidReceiveMessage((message: unknown) => {
          if (
            message &&
            typeof message === "object" &&
            (message as Record<string, unknown>).type === "openLocation"
          ) {
            const msg = message as { file?: unknown; line?: unknown };
            if (typeof msg.file === "string" && typeof msg.line === "number") {
              void deps.onOpenLocation(
                currentWorkspaceRoot,
                msg.file,
                msg.line,
              );
            }
          }
        });
      }
      panel.webview.html = (deps.renderHtml ?? renderReportHtml)(feedback);
      return panel;
    },
    getWorkspaceRoot(): string | undefined {
      return currentWorkspaceRoot;
    },
    getPanel(): TPanel | undefined {
      return panel;
    },
  };
}

let reportController: ReportWebviewController<vscode.WebviewPanel> | undefined;

/** 跳转到工作区指定文件与行号（仅允许工作区内部相对路径）。 */
export async function navigateToSourceLocation(
  workspaceRoot: string | undefined,
  file: string,
  line: number,
): Promise<void> {
  if (!workspaceRoot || !file) return;
  const vscodeApi = loadVscode();
  const resolved = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(workspaceRoot, file);
  const rootResolved = path.resolve(workspaceRoot);
  if (
    resolved !== rootResolved &&
    !resolved.startsWith(`${rootResolved}${path.sep}`)
  ) {
    vscodeApi.window.showWarningMessage(`拒绝打开工作区之外的文件：${file}`);
    return;
  }
  const doc = await vscodeApi.workspace.openTextDocument(
    vscodeApi.Uri.file(resolved),
  );
  const editor = await vscodeApi.window.showTextDocument(doc);
  const targetLine = Math.max(0, line - 1);
  const pos = new vscodeApi.Position(targetLine, 0);
  editor.selection = new vscodeApi.Selection(pos, pos);
  editor.revealRange(
    new vscodeApi.Range(pos, pos),
    vscodeApi.TextEditorRevealType.InCenter,
  );
}

/** 在 VS Code 中展示可视化评测报告 Webview。 */
export function openReportWebview(
  feedback: EvaluationFeedback,
  workspaceRoot?: string,
): vscode.WebviewPanel {
  if (!reportController) {
    const vscodeApi = loadVscode();
    reportController = createReportWebviewController<vscode.WebviewPanel>({
      createPanel: (title) =>
        vscodeApi.window.createWebviewPanel(
          "neuroOj.evaluationReport",
          title,
          { viewColumn: vscodeApi.ViewColumn.Beside, preserveFocus: true },
          { enableScripts: true },
        ),
      revealPanel: (panel) => {
        panel.reveal(vscodeApi.ViewColumn.Beside, true);
      },
      onOpenLocation: navigateToSourceLocation,
    });
  }
  return reportController.open(feedback, workspaceRoot);
}
