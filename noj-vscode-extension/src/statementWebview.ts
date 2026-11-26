import * as vscode from "vscode";
import { renderStatementHtml } from "./statementHtml";
import type { DomainProblemDetail } from "./types";

let statementPanel: vscode.WebviewPanel | undefined;

/** 在 VS Code 中打开或刷新题面预览 Webview。 */
export function openStatementWebview(
  detail: DomainProblemDetail,
  meta: { domainSlug: string; reference: string },
): vscode.WebviewPanel {
  const title = `题面：${meta.reference}`;
  if (statementPanel) {
    statementPanel.title = title;
    statementPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    statementPanel = vscode.window.createWebviewPanel(
      "neuroOj.statement",
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: false },
    );
    statementPanel.onDidDispose(() => {
      statementPanel = undefined;
    });
  }
  statementPanel.webview.html = renderStatementHtml(detail, meta);
  return statementPanel;
}
