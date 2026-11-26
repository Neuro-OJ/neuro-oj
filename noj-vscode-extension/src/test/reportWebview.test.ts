import assert from "node:assert/strict";
import test from "node:test";
import {
  createReportWebviewController,
  type ReportWebviewPanelLike,
} from "../reportWebview";
import type { EvaluationFeedback } from "../types";

function makeFeedback(title: string): EvaluationFeedback {
  return {
    source: "local_mock",
    title,
    status: "WA",
    score: 50,
    maxScore: 100,
    dimensions: [],
    badcases: [],
    traces: [],
    locations: [{ file: "submission.py", line: 12 }],
  };
}

class FakeWebviewPanel implements ReportWebviewPanelLike {
  private messageListeners: Array<(message: unknown) => unknown> = [];
  private disposeListeners: Array<() => unknown> = [];
  revealCount = 0;
  readonly webview: ReportWebviewPanelLike["webview"];

  constructor(public title: string) {
    this.webview = {
      html: "",
      onDidReceiveMessage: (listener) => {
        this.messageListeners.push(listener);
        return { dispose: () => {} };
      },
    };
  }

  onDidDispose(listener: () => unknown): { dispose(): void } {
    this.disposeListeners.push(listener);
    return { dispose: () => {} };
  }

  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  dispose(): void {
    for (const listener of this.disposeListeners) {
      listener();
    }
  }

  listenerCount(): number {
    return this.messageListeners.length;
  }
}

test("createReportWebviewController 在复用报告面板时更新源码跳转的 workspaceRoot", () => {
  const panels: FakeWebviewPanel[] = [];
  const navigations: Array<{
    workspaceRoot: string | undefined;
    file: string;
    line: number;
  }> = [];

  const controller = createReportWebviewController<FakeWebviewPanel>({
    createPanel: (title) => {
      const panel = new FakeWebviewPanel(title);
      panels.push(panel);
      return panel;
    },
    revealPanel: (panel) => {
      panel.revealCount++;
    },
    onOpenLocation: (workspaceRoot, file, line) => {
      navigations.push({ workspaceRoot, file, line });
    },
  });

  // 1) 在工作区 A 打开报告
  const panelA = controller.open(makeFeedback("题 A"), "/workspaces/ws-a");
  assert.equal(panels.length, 1);
  assert.equal(controller.getWorkspaceRoot(), "/workspaces/ws-a");
  panelA.emitMessage({ type: "openLocation", file: "a.py", line: 10 });
  assert.deepEqual(navigations, [
    { workspaceRoot: "/workspaces/ws-a", file: "a.py", line: 10 },
  ]);

  // 2) 未关闭面板的情况下切换到工作区 B 再次打开报告（复用同一面板）
  const panelB = controller.open(makeFeedback("题 B"), "/workspaces/ws-b");
  assert.equal(panelB, panelA);
  assert.equal(panels.length, 1);
  assert.equal(panelA.revealCount, 1);
  assert.equal(panelA.title, "评测报告：题 B");
  assert.equal(panelA.listenerCount(), 1);
  assert.equal(controller.getWorkspaceRoot(), "/workspaces/ws-b");

  panelB.emitMessage({ type: "openLocation", file: "b.py", line: 25 });
  assert.deepEqual(navigations, [
    { workspaceRoot: "/workspaces/ws-a", file: "a.py", line: 10 },
    { workspaceRoot: "/workspaces/ws-b", file: "b.py", line: 25 },
  ]);

  // 3) 复用面板且新报告不带 workspaceRoot 时，清零而非沿用旧工作区
  controller.open(makeFeedback("无工作区报告"), undefined);
  assert.equal(controller.getWorkspaceRoot(), undefined);
  panelB.emitMessage({ type: "openLocation", file: "c.py", line: 3 });
  assert.deepEqual(navigations[2], {
    workspaceRoot: undefined,
    file: "c.py",
    line: 3,
  });

  // 4) 关闭面板后状态重置，再次打开创建新面板并绑定新工作区
  panelB.dispose();
  assert.equal(controller.getPanel(), undefined);
  assert.equal(controller.getWorkspaceRoot(), undefined);

  const panelC = controller.open(makeFeedback("题 C"), "/workspaces/ws-c");
  assert.notEqual(panelC, panelA);
  assert.equal(panels.length, 2);
  panelC.emitMessage({ type: "openLocation", file: "c2.py", line: 7 });
  assert.deepEqual(navigations[3], {
    workspaceRoot: "/workspaces/ws-c",
    file: "c2.py",
    line: 7,
  });
});
