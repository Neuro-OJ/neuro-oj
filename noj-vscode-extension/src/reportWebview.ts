import * as path from "node:path";
import * as vscode from "vscode";
import { renderReportHtml } from "./reportHtml";
import type { EvaluationFeedback } from "./types";

let reportPanel: vscode.WebviewPanel | undefined;

/** 跳转到工作区指定文件与行号（仅允许工作区内部相对路径）。 */
export async function navigateToSourceLocation(
  workspaceRoot: string | undefined,
  file: string,
  line: number,
): Promise<void> {
  if (!workspaceRoot || !file) return;
  const resolved = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(workspaceRoot, file);
  const rootResolved = path.resolve(workspaceRoot);
  if (
    resolved !== rootResolved &&
    !resolved.startsWith(`${rootResolved}${path.sep}`)
  ) {
    vscode.window.showWarningMessage(`拒绝打开工作区之外的文件：${file}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(resolved),
  );
  const editor = await vscode.window.showTextDocument(doc);
  const targetLine = Math.max(0, line - 1);
  const pos = new vscode.Position(targetLine, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );
}

/** 在 VS Code 中展示可视化评测报告 Webview。 */
export function openReportWebview(
  feedback: EvaluationFeedback,
  workspaceRoot?: string,
): vscode.WebviewPanel {
  const title = `评测报告：${feedback.title}`;
  if (reportPanel) {
    reportPanel.title = title;
    reportPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    reportPanel = vscode.window.createWebviewPanel(
      "neuroOj.evaluationReport",
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true },
    );
    reportPanel.onDidDispose(() => {
      reportPanel = undefined;
    });
    reportPanel.webview.onDidReceiveMessage((message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as Record<string, unknown>).type === "openLocation"
      ) {
        const msg = message as { file?: unknown; line?: unknown };
        if (typeof msg.file === "string" && typeof msg.line === "number") {
          void navigateToSourceLocation(workspaceRoot, msg.file, msg.line);
        }
      }
    });
  }
  reportPanel.webview.html = renderReportHtml(feedback);
  return reportPanel;
}
